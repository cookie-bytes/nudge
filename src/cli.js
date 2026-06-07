#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
import { analyzeLayout, getLLMOptimizationPatch, getLLMZoneVerification, getLLMRoutingVerification } from './critic.js';
import { parseMermaidC4 } from './mermaid_parser.js';

const LM_STUDIO_API = process.env.NUDGE_LLM_API || 'http://localhost:1234';
const MAX_ITERATIONS = 4;
const OUTPUT_DIR = path.resolve('.nudge');

// Support custom input file via CLI argument
const inputArg = process.argv[2];
const INPUT_PATH = inputArg ? path.resolve(inputArg) : path.resolve('examples/system_context.yaml');

async function main() {
  console.log("=== Nudge AI-Driven Layout Optimizer PoC ===");
  console.log(`Ingesting input model from: ${INPUT_PATH}`);

  // 1. Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 2. Parse input model (Mermaid or YAML)
  let diagramModel;
  try {
    const fileContent = fs.readFileSync(INPUT_PATH, 'utf8');
    const ext = path.extname(INPUT_PATH).toLowerCase();
    
    if (ext === '.mermaid' || ext === '.mmd') {
      console.log("[Parser] Input identified as Mermaid. Compiling C4Context...");
      diagramModel = parseMermaidC4(fileContent);
    } else {
      console.log("[Parser] Input identified as YAML. Parsing...");
      diagramModel = yaml.load(fileContent);
    }
  } catch (err) {
    console.error("Failed to read/parse input file:", err);
    process.exit(1);
  }

  console.log(`Diagram loaded: "${diagramModel.title}"`);
  console.log("Initial Layout Options:", JSON.stringify(diagramModel.layoutOptions, null, 2));

  // 3. Initialize Playwright
  console.log("[Playwright] Launching headless browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();
  
  page.on('console', msg => {
    console.log(`[Browser Console] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });
  page.on('pageerror', err => {
    console.error('[Browser PageError]:', err.stack || err.message);
  });

  // Load the render template HTML
  const templatePath = path.resolve('src/render.html');
  const fileUrl = `file://${templatePath}`;
  console.log(`[Playwright] Opening diagram canvas: ${fileUrl}`);
  await page.goto(fileUrl);

  // For container diagrams (those with a boundary): run LM verification checkpoints
  // before the main optimization loop to pre-correct zone/ordering issues.
  const hasBoundary = (diagramModel.nodes || []).some(n => n.type === 'boundary');
  if (hasBoundary) {
    console.log("\n[Checkpoint] Container diagram — running pre-render LM zone verification...");
    const initialPlan = await page.evaluate((data) => window.computeContainerPlan(data), diagramModel);
    if (initialPlan) {
      const overrides = {};

      // Checkpoint 1: zone assignment correctness
      const zoneResult = await getLLMZoneVerification(LM_STUDIO_API, initialPlan);
      if (zoneResult) {
        if (zoneResult.zoneOverrides && Object.keys(zoneResult.zoneOverrides).length > 0) {
          overrides.zoneOverrides = zoneResult.zoneOverrides;
        }
        if (zoneResult.swapCommands && zoneResult.swapCommands.length > 0) {
          overrides.swapCommands = [...(zoneResult.swapCommands)];
        }
      }

      // Checkpoint 2: node ordering within zones (use updated plan if overrides changed zones)
      const planForRouting = Object.keys(overrides).length > 0
        ? await page.evaluate((data) => window.computeContainerPlan(data),
            { ...diagramModel, _layoutOverrides: overrides })
        : initialPlan;
      const routeResult = await getLLMRoutingVerification(LM_STUDIO_API, planForRouting);
      if (routeResult && routeResult.swapCommands && routeResult.swapCommands.length > 0) {
        overrides.swapCommands = [...(overrides.swapCommands || []), ...routeResult.swapCommands];
      }

      if (Object.keys(overrides).length > 0) {
        console.log("[Checkpoint] Applying LM layout overrides:", JSON.stringify(overrides, null, 2));
        diagramModel._layoutOverrides = overrides;
      } else {
        console.log("[Checkpoint] LM verified layout — no overrides needed.");
      }
    }
  }

  let currentOptions = { ...diagramModel.layoutOptions };
  let iteration = 1;
  let success = false;
  const history = [];

  // 4. Closed Loop Optimization Cycle
  while (iteration <= MAX_ITERATIONS) {
    console.log(`\n--- Iteration ${iteration}/${MAX_ITERATIONS} ---`);
    diagramModel.layoutOptions = { ...currentOptions };

    // Inject data and execute the rendering inside the browser
    console.log("[Render] Running layout calculations with ELKjs...");
    const result = await page.evaluate(async (data) => {
      return await window.renderDiagram(data);
    }, diagramModel);

    if (!result.success) {
      console.error("[Render] Rendering failed:", result.error);
      break;
    }

    console.log(`[Render] Viewport bounds computed: ${result.width}x${result.height}`);

    // Take screenshot of the SVG root element
    const screenshotPath = path.join(OUTPUT_DIR, `iteration_${iteration}.png`);
    const svgElement = await page.$('#svg-root');
    
    // Set viewport dynamically to encompass the full diagram size to prevent clipping
    await page.setViewportSize({
      width: Math.ceil(result.width) + 100,
      height: Math.ceil(result.height) + 100
    });

    await svgElement.screenshot({ path: screenshotPath });
    console.log(`[Snapshot] Saved visual state to: ${screenshotPath}`);

    // Fetch the raw SVG markup for exporting later
    const svgMarkup = await page.locator('#svg-root').innerHTML();

    // Run geometric critique on the coordinates
    console.log("[Critique] Running geometric collision analysis...");
    const report = analyzeLayout(result);
    console.log(`[Critique] Aspect Ratio: ${report.aspectRatio}`);
    console.log(`[Critique] Collisions: ${report.collisions.length} (${report.overlapCount} overlaps, ${report.intersectionCount} edge crossings)`);

    history.push({
      iteration,
      options: { ...currentOptions },
      collisions: report.collisions.length,
      overlaps: report.overlapCount,
      crossings: report.intersectionCount,
      aspectRatio: report.aspectRatio,
      screenshot: screenshotPath
    });

    if (report.collisions.length > 0) {
      console.log("[Critique] Issues detected:");
      report.collisions.forEach((c, index) => {
        console.log(`  ${index + 1}. [${c.type}] ${c.details}`);
      });
    } else {
      console.log("[Critique] Visual layout is pristine! Zero collisions detected.");
      success = true;
      
      // Save final clean outputs
      fs.writeFileSync(path.join(OUTPUT_DIR, 'optimized.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.width} ${result.height}">${svgMarkup}</svg>`);
      fs.copyFileSync(screenshotPath, path.join(OUTPUT_DIR, 'optimized.png'));
      break;
    }

    if (iteration === MAX_ITERATIONS) {
      console.log("[Optimization] Maximum iterations reached.");
      break;
    }

    // Call the LLM Critic to recommend parameter changes
    console.log("[Optimization] Requesting layout parameter patch from AI...");
    const patch = await getLLMOptimizationPatch(LM_STUDIO_API, currentOptions, report);

    if (!patch || Object.keys(patch).length === 0) {
      console.log("[Optimization] AI did not suggest any changes or request failed. Retaining parameters.");
    } else {
      console.log("[Optimization] AI suggested patch:", JSON.stringify(patch, null, 2));
      // Merge patch parameters into current options
      for (const [key, val] of Object.entries(patch)) {
        currentOptions[key] = String(val);
      }
      // Save merged options in cache file
      fs.writeFileSync(
        path.join(OUTPUT_DIR, 'layout.cache.json'), 
        JSON.stringify(currentOptions, null, 2)
      );
    }

    iteration++;
  }

  // 5. Finalize and report results
  await browser.close();

  console.log("\n=================================");
  console.log("       OPTIMIZATION SUMMARY       ");
  console.log("=================================");
  console.table(history.map(h => ({
    Iter: h.iteration,
    Collisions: h.collisions,
    Overlaps: h.overlaps,
    Crossings: h.crossings,
    'Aspect Ratio': h.aspectRatio,
    'Node Spacing': h.options['elk.spacing.nodeNode'] || 'unset',
    'Layer Spacing': h.options['elk.layered.spacing.nodeNodeBetweenLayers'] || 'unset'
  })));

  if (success) {
    console.log(`\n🎉 Success! Optimized assets exported successfully:`);
    console.log(`- SVG Vector Asset: ${path.join(OUTPUT_DIR, 'optimized.svg')}`);
    console.log(`- High-Res Snapshot: ${path.join(OUTPUT_DIR, 'optimized.png')}`);
  } else {
    console.log(`\n⚠️ Finished optimization loop, but remaining layout issues were left unhandled. Check the final iteration snapshot.`);
    // Copy the last iteration as final output anyway as best effort
    const lastHist = history[history.length - 1];
    fs.copyFileSync(lastHist.screenshot, path.join(OUTPUT_DIR, 'optimized.png'));
  }
}

main().catch(err => {
  console.error("Fatal execution error in CLI:", err);
});
