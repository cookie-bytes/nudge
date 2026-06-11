import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import { analyzeLayout } from './geometry.js';
import {
  getLLMOptimizationPatch,
  getLLMLabelPlacementHints
} from './llm_client.js';

/**
 * Normalise a parsed diagram model before rendering, shared by every entry
 * point (CLI, MCP). Infers the diagram type when the input format does not
 * declare one (YAML), and wraps a C4Context diagram's internal architecture
 * elements in a hidden synthetic boundary so context diagrams reuse the
 * container layout pipeline. Persons and external systems stay outside the
 * boundary, where the container plan places them in its external zones.
 */
export function normalizeDiagramModel(diagramModel) {
  const hasBoundary = (diagramModel.nodes || []).some(n => n.type === 'boundary');
  if (!diagramModel.diagramType) {
    diagramModel.diagramType = hasBoundary ? 'C4Container' : 'C4Context';
  }
  if (hasBoundary || diagramModel._contextBoundaryAdded) return diagramModel;
  if (!String(diagramModel.diagramType).startsWith('C4Context')) return diagramModel;

  const outsideTypes = new Set(['person', 'person_ext', 'external']);
  const insideNodes = (diagramModel.nodes || []).filter(n => !outsideTypes.has(n.type));
  const outsideNodes = (diagramModel.nodes || []).filter(n => outsideTypes.has(n.type));
  if (insideNodes.length === 0 || outsideNodes.length === 0) return diagramModel;

  diagramModel.nodes = [...outsideNodes, {
    id: '__context_boundary',
    label: 'System Context',
    type: 'boundary',
    children: insideNodes,
    _synthetic: true
  }];
  diagramModel._contextBoundaryAdded = true;
  return diagramModel;
}

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
  enhance = false,
}) {
  fs.mkdirSync(outputDir, { recursive: true });

  normalizeDiagramModel(diagramModel);

  // Container connection lines default to the grid router (A* over the
  // orthogonal visibility graph, docs/nudge_next_generation_design.md §3).
  // NUDGE_ROUTER=legacy restores the old candidate router.
  if (process.env.NUDGE_ROUTER) {
    diagramModel._router = process.env.NUDGE_ROUTER;
    onLog(`[Optimizer] Connection-line router override: ${process.env.NUDGE_ROUTER} (NUDGE_ROUTER).`);
  }

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
      let overrides = { ...(diagramModel._layoutOverrides || {}) };
      const visualHints = {};

      const scoreContainerStep = (result) => {
        const report = analyzeLayout(result);
        const edge = report.edgeQuality || {};
        return {
          report,
          score:
            report.overlapCount * 100000 +
            report.intersectionCount * 100000 +
            (edge.edgeCrossingCount || 0) * 500 +
            (edge.edgeOverlapCount || 0) * 500 +
            (edge.edgeOverlapPx || 0) * 2 +
            (edge.labelEdgeIntersectionCount || 0) * 250 +
            (edge.totalBends || 0) * 4 +
            (edge.totalRouteLength || 0) * 0.02
        };
      };

      const renderContainerStep = async (stepName, overridesForStep = overrides) => {
        const result = await page.evaluate(async (data) => window.renderDiagram(data), {
          ...diagramModel,
          _layoutOverrides: overridesForStep
        });
        if (!result?.success) {
          onLog(`[Render] ${stepName} failed: ${result?.error || 'unknown render error'}`);
          return null;
        }
        await page.setViewportSize({
          width: Math.ceil(result.width) + 100,
          height: Math.ceil(result.height) + 100,
        });
        const screenshotPath = path.join(outputDir, `${stepName}.png`);
        const svgElement = await page.$('#svg-root');
        await svgElement.screenshot({ path: screenshotPath });
        onLog(`[Snapshot] Saved ${stepName} visual state to: ${screenshotPath}`);
        return { result, screenshotPath };
      };

      const renderAndMaybeAccept = async (stepName, candidateOverrides, currentStep, description) => {
        const candidateStep = await renderContainerStep(stepName, candidateOverrides);
        if (!candidateStep) return { accepted: false, step: null, overrides };

        const currentScore = scoreContainerStep(currentStep.result).score;
        const candidateScore = scoreContainerStep(candidateStep.result).score;
        if (candidateScore <= currentScore) {
          overrides = candidateOverrides;
          onLog(`[Visual Hint] Accepted ${description}: ${Math.round(currentScore * 10) / 10} -> ${Math.round(candidateScore * 10) / 10}`);
          return { accepted: true, step: candidateStep, overrides };
        }

        onLog(`[Visual Hint] Rejected ${description}: ${Math.round(currentScore * 10) / 10} -> ${Math.round(candidateScore * 10) / 10}`);
        return { accepted: false, step: currentStep, overrides };
      };

      onLog('[Visual Hint] Container diagram — running label placement optimizer...');

      const initialStep = await renderContainerStep('step_0_initial');
      if (!initialStep) return { success: false, history: [], svgContent: null, pngPath: null };
      let acceptedStep = initialStep;

      if (enhance && !signal?.aborted) {
        const labelResult = await getLLMLabelPlacementHints(apiUrl, diagramModel, initialStep.result, { signal, timeout: checkpointTimeout });
        if (labelResult) visualHints.labelPlacement = labelResult;
        const labelHints = {};
        for (const suggestion of labelResult?.suggestions || []) {
          if (suggestion.edgeId && suggestion.placement) {
            labelHints[suggestion.edgeId] = suggestion.placement;
          }
        }
        if (Object.keys(labelHints).length > 0) {
          const candidateOverrides = {
            ...overrides,
            labelHints: {
              ...(overrides.labelHints || {}),
              ...labelHints
            }
          };
          const accepted = await renderAndMaybeAccept('step_1_label_hints', candidateOverrides, acceptedStep, `label hints: ${Object.entries(labelHints).map(([id, val]) => `${id}->${val}`).join(', ')}`);
          acceptedStep = accepted.step || acceptedStep;
        } else {
          const labelHintsStep = await renderContainerStep('step_1_label_hints');
          if (!labelHintsStep) return { success: false, history: [], svgContent: null, pngPath: null };
          acceptedStep = labelHintsStep;
        }
      } else {
        const labelHintsStep = await renderContainerStep('step_1_label_hints');
        if (!labelHintsStep) return { success: false, history: [], svgContent: null, pngPath: null };
        acceptedStep = labelHintsStep;
      }

      if (!fs.existsSync(path.join(outputDir, 'step_1_label_hints.png'))) {
        const labelHintsStep = await renderContainerStep('step_1_label_hints');
        if (!labelHintsStep) return { success: false, history: [], svgContent: null, pngPath: null };
      }

      const finalStep = acceptedStep;

      diagramModel._layoutOverrides = overrides;
      if (Object.keys(visualHints).length > 0) {
        fs.writeFileSync(path.join(outputDir, 'visual_hints.json'), JSON.stringify(visualHints, null, 2));
      }

      onLog('[Critique] Running geometric collision analysis...');
      const report = analyzeLayout(finalStep.result);
      onLog(`[Critique] Aspect Ratio: ${report.aspectRatio}`);
      onLog(`[Critique] Collisions: ${report.collisions.length} (${report.overlapCount} overlaps, ${report.intersectionCount} edge crossings)`);

      const svg = await captureSvg(page, finalStep.result.width, finalStep.result.height);
      fs.writeFileSync(path.join(outputDir, 'optimized.svg'), svg);
      const finalPngPath = path.join(outputDir, 'optimized.png');
      fs.copyFileSync(finalStep.screenshotPath, finalPngPath);

      const history = [{
        iteration: 1,
        options: { ...diagramModel.layoutOptions },
        collisions: report.collisions.length,
        overlaps: report.overlapCount,
        crossings: report.intersectionCount,
        aspectRatio: report.aspectRatio,
        screenshot: finalStep.screenshotPath,
      }];

      const success = report.overlapCount === 0 && report.intersectionCount === 0;
      return { success, history, svgContent: svg, pngPath: finalPngPath };
    }

    let currentOptions = { ...diagramModel.layoutOptions };
    const history = [];
    let svgContent = null;
    let pngPath = null;
    let success = false;
    let lastRenderResult = null;

    if (!enhance) {
      onLog('[Optimizer] LLM is disabled (deterministic-only mode). Running canned ELKjs configuration search...');
      const cannedConfigs = [
        { ...currentOptions },
        {
          ...currentOptions,
          "elk.spacing.nodeNode": "160",
          "elk.layered.spacing.nodeNodeBetweenLayers": "130",
          "elk.spacing.edgeNode": "90",
          "elk.spacing.edgeEdge": "25"
        },
        {
          ...currentOptions,
          "elk.spacing.nodeNode": "200",
          "elk.layered.spacing.nodeNodeBetweenLayers": "160",
          "elk.spacing.edgeNode": "100",
          "elk.spacing.edgeEdge": "30"
        },
        {
          ...currentOptions,
          "elk.spacing.nodeNode": "120",
          "elk.layered.spacing.nodeNodeBetweenLayers": "100",
          "elk.spacing.edgeNode": "70",
          "elk.spacing.edgeEdge": "15"
        }
      ];

      let bestScore = Infinity;
      let bestOptions = null;
      let bestRenderResult = null;
      let bestReport = null;

      for (let i = 0; i < cannedConfigs.length; i++) {
        if (signal?.aborted) {
          onLog('[Optimizer] Optimization cancelled during canned config search.');
          break;
        }
        const config = cannedConfigs[i];
        diagramModel.layoutOptions = { ...config };

        onLog(`[Optimizer] Trying canned config ${i + 1}/${cannedConfigs.length}: nodeNode=${config["elk.spacing.nodeNode"] || 'unset'}, layerSpacing=${config["elk.layered.spacing.nodeNodeBetweenLayers"] || 'unset'}...`);
        const result = await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);
        if (!result.success) {
          onLog(`[Render] Canned config ${i + 1} failed: ${result.error}`);
          continue;
        }

        const report = analyzeLayout(result);
        const edge = report.edgeQuality || {};
        const score =
          report.overlapCount * 100000 +
          report.intersectionCount * 100000 +
          (edge.edgeCrossingCount || 0) * 500 +
          (edge.edgeOverlapCount || 0) * 500 +
          (edge.edgeOverlapPx || 0) * 2 +
          (edge.labelEdgeIntersectionCount || 0) * 250 +
          (edge.totalBends || 0) * 4 +
          (edge.totalRouteLength || 0) * 0.02;

        onLog(`[Optimizer] Config ${i + 1} score: ${Math.round(score * 10) / 10} (overlaps: ${report.overlapCount}, crossings: ${report.intersectionCount}, tight spacing: ${report.collisions.filter(c => c.type === 'tight_spacing').length})`);

        if (score < bestScore) {
          bestScore = score;
          bestOptions = config;
          bestRenderResult = result;
          bestReport = report;
        }
      }

      if (bestRenderResult) {
        onLog(`[Optimizer] Selected best config with score ${bestScore}.`);
        diagramModel.layoutOptions = { ...bestOptions };

        await page.setViewportSize({
          width: Math.ceil(bestRenderResult.width) + 100,
          height: Math.ceil(bestRenderResult.height) + 100,
        });

        const screenshotPath = path.join(outputDir, `optimized.png`);
        const svgElement = await page.$('#svg-root');
        await svgElement.screenshot({ path: screenshotPath });
        onLog(`[Snapshot] Saved visual state to: ${screenshotPath}`);

        svgContent = await captureSvg(page, bestRenderResult.width, bestRenderResult.height);
        const svgFilePath = path.join(outputDir, 'optimized.svg');
        fs.writeFileSync(svgFilePath, svgContent);

        pngPath = screenshotPath;

        history.push({
          iteration: 1,
          options: { ...bestOptions },
          collisions: bestReport.collisions.length,
          overlaps: bestReport.overlapCount,
          crossings: bestReport.intersectionCount,
          aspectRatio: bestReport.aspectRatio,
          screenshot: screenshotPath,
        });

        const hardCollisions = bestReport.collisions.filter(c =>
          c.type === 'node_overlap' ||
          c.type === 'edge_node_crossing' ||
          c.type === 'edge_label_node_crossing'
        );
        success = (hardCollisions.length === 0);
      }
    } else {
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
        const patch = await getLLMOptimizationPatch(apiUrl, currentOptions, report, { signal, timeout: optimizationTimeout });

        if (signal?.aborted) {
          onLog(`[Optimizer] Optimization cancelled after LLM optimization call at iteration ${iteration}.`);
          break;
        }

        if (!patch || Object.keys(patch).length === 0) {
          onLog('[Optimization] AI did not suggest any changes. Retaining parameters.');
          break;
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
    }

    return { success, history, svgContent, pngPath };
  } finally {
    await browser.close();
  }
}
