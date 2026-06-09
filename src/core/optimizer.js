import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import { analyzeLayout } from './geometry.js';
import { getLLMOptimizationPatch, getLLMZoneVerification, getLLMRoutingVerification } from './llm_client.js';

async function captureSvg(page, width, height) {
  const [svgMarkup, styles] = await Promise.all([
    page.locator('#svg-root').innerHTML(),
    page.evaluate(() => document.querySelector('head style')?.textContent ?? ''),
  ]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><style>${styles}</style>${svgMarkup}</svg>`;
}

/**
 * @param {object}   opts
 * @param {object}   opts.diagramModel
 * @param {string}   opts.outputDir       - absolute path for iteration PNGs and final outputs
 * @param {string}   [opts.apiUrl]
 * @param {number}   [opts.maxIterations]
 * @param {function} [opts.onLog]         - (msg: string) => void
 * @returns {Promise<{ success: boolean, history: object[], svgContent: string|null, pngPath: string|null }>}
 */
export async function optimizeDiagram({
  diagramModel,
  outputDir,
  apiUrl = process.env.NUDGE_LLM_API || 'http://127.0.0.1:1234',
  maxIterations = 4,
  onLog = (msg) => process.stderr.write(msg + '\n'),
  signal = null,
  checkpointTimeout = 30000,
  optimizationTimeout = 120000,
  skipLlm = !!process.env.NUDGE_NO_LLM,
}) {
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    page.on('console', msg => onLog(`[Browser] ${msg.type().toUpperCase()}: ${msg.text()}`));
    page.on('pageerror', err => onLog(`[Browser PageError]: ${err.message}`));

    const templateUrl = new URL('../render.html', import.meta.url).href;
    await page.goto(templateUrl);

    if (signal?.aborted) {
      onLog('[Optimizer] Optimization cancelled prior to start.');
      return { success: false, history: [], svgContent: null, pngPath: null };
    }

    const hasBoundary = (diagramModel.nodes || []).some(n => n.type === 'boundary');
    if (hasBoundary) {
      onLog('[Checkpoint] Container diagram — running pre-render LM zone verification...');
      const initialPlan = await page.evaluate((data) => window.computeContainerPlan(data), diagramModel);
      if (initialPlan) {
        const overrides = {};

        if (signal?.aborted) {
          onLog('[Optimizer] Optimization cancelled before zone verification.');
          return { success: false, history: [], svgContent: null, pngPath: null };
        }

        const zoneResult = skipLlm ? null : await getLLMZoneVerification(apiUrl, initialPlan, { signal, timeout: checkpointTimeout });
        if (zoneResult) {
          if (zoneResult.zoneOverrides && Object.keys(zoneResult.zoneOverrides).length > 0)
            overrides.zoneOverrides = zoneResult.zoneOverrides;
          if (zoneResult.swapCommands?.length > 0)
            overrides.swapCommands = [...zoneResult.swapCommands];
        }

        if (signal?.aborted) {
          onLog('[Optimizer] Optimization cancelled after zone verification.');
          return { success: false, history: [], svgContent: null, pngPath: null };
        }

        const planForRouting = Object.keys(overrides).length > 0
          ? await page.evaluate((data) => window.computeContainerPlan(data), { ...diagramModel, _layoutOverrides: overrides })
          : initialPlan;
        const routeResult = skipLlm ? null : await getLLMRoutingVerification(apiUrl, planForRouting, { signal, timeout: checkpointTimeout });
        if (routeResult?.swapCommands?.length > 0)
          overrides.swapCommands = [...(overrides.swapCommands || []), ...routeResult.swapCommands];

        if (Object.keys(overrides).length > 0) {
          onLog(`[Checkpoint] Applying LM layout overrides: ${JSON.stringify(overrides, null, 2)}`);
          diagramModel._layoutOverrides = overrides;
        } else {
          onLog('[Checkpoint] LM verified layout — no overrides needed.');
        }
      }
    }

    let currentOptions = { ...diagramModel.layoutOptions };
    const history = [];
    let svgContent = null;
    let pngPath = null;
    let success = false;
    let lastRenderResult = null;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (signal?.aborted) {
        onLog(`[Optimizer] Optimization cancelled at iteration ${iteration}.`);
        break;
      }

      onLog(`\n--- Iteration ${iteration}/${maxIterations} ---`);
      diagramModel.layoutOptions = { ...currentOptions };

      onLog('[Render] Running layout calculations with ELKjs...');
      const result = await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);

      if (!result.success) {
        onLog(`[Render] Rendering failed: ${result.error}`);
        break;
      }
      lastRenderResult = result;

      onLog(`[Render] Viewport bounds computed: ${result.width}x${result.height}`);

      await page.setViewportSize({
        width: Math.ceil(result.width) + 100,
        height: Math.ceil(result.height) + 100,
      });

      const screenshotPath = path.join(outputDir, `iteration_${iteration}.png`);
      const svgElement = await page.$('#svg-root');
      await svgElement.screenshot({ path: screenshotPath });
      onLog(`[Snapshot] Saved visual state to: ${screenshotPath}`);

      onLog('[Critique] Running geometric collision analysis...');
      const report = analyzeLayout(result);
      onLog(`[Critique] Aspect Ratio: ${report.aspectRatio}`);
      onLog(`[Critique] Collisions: ${report.collisions.length} (${report.overlapCount} overlaps, ${report.intersectionCount} edge crossings)`);

      history.push({
        iteration,
        options: { ...currentOptions },
        collisions: report.collisions.length,
        overlaps: report.overlapCount,
        crossings: report.intersectionCount,
        aspectRatio: report.aspectRatio,
        screenshot: screenshotPath,
      });

      const hardCollisions = report.collisions.filter(c =>
        c.type === 'node_overlap' ||
        c.type === 'edge_node_crossing' ||
        c.type === 'edge_label_node_crossing'
      );

      if (!success && hardCollisions.length === 0) {
        onLog('[Critique] No node overlaps or edge crossings detected. Layout is visually clean.');
        svgContent = await captureSvg(page, result.width, result.height);
        const svgFilePath = path.join(outputDir, 'optimized.svg');
        fs.writeFileSync(svgFilePath, svgContent);

        pngPath = path.join(outputDir, 'optimized.png');
        fs.copyFileSync(screenshotPath, pngPath);
        success = true;
      }

      if (report.collisions.length > 0) {
        report.collisions.forEach((c, i) => onLog(`  ${i + 1}. [${c.type}] ${c.details}`));
      } else {
        onLog('[Critique] Visual layout is pristine! Zero collisions or warnings detected.');
        break;
      }

      if (iteration === maxIterations) {
        onLog('[Optimization] Maximum iterations reached.');
        break;
      }

      if (signal?.aborted) {
        onLog(`[Optimizer] Optimization cancelled before LLM optimization call at iteration ${iteration}.`);
        break;
      }

      onLog('[Optimization] Requesting layout parameter patch from AI...');
      const patch = skipLlm ? null : await getLLMOptimizationPatch(apiUrl, currentOptions, report, { signal, timeout: optimizationTimeout });

      if (signal?.aborted) {
        onLog(`[Optimizer] Optimization cancelled after LLM optimization call at iteration ${iteration}.`);
        break;
      }

      if (!patch || Object.keys(patch).length === 0) {
        onLog('[Optimization] AI did not suggest any changes. Retaining parameters.');
      } else {
        onLog(`[Optimization] AI suggested patch: ${JSON.stringify(patch, null, 2)}`);
        for (const [key, val] of Object.entries(patch)) currentOptions[key] = String(val);
        fs.writeFileSync(path.join(outputDir, 'layout.cache.json'), JSON.stringify(currentOptions, null, 2));
      }
    }

    if (!success && lastRenderResult) {
      svgContent = await captureSvg(page, lastRenderResult.width, lastRenderResult.height);
      fs.writeFileSync(path.join(outputDir, 'optimized.svg'), svgContent);
    }

    if (history.length > 0) {
      pngPath = path.join(outputDir, 'optimized.png');
      fs.copyFileSync(history.at(-1).screenshot, pngPath);
    }

    return { success, history, svgContent, pngPath };
  } finally {
    await browser.close();
  }
}
