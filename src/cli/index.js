#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { parseMermaidC4 } from '../mermaid_parser.js';
import { parsePlantUMLC4 } from '../plantuml_parser.js';
import { optimizeDiagram, THEME_REQUESTS } from '../core/optimizer.js';

const args = process.argv.slice(2);
const enhanceIndex = args.indexOf('--enhance');
const hasEnhance = enhanceIndex !== -1;
if (hasEnhance) {
  args.splice(enhanceIndex, 1);
}

// Output directory precedence: --out flag > NUDGE_OUTPUT_DIR (shared with the
// MCP server) > ./.nudge in the current working directory.
let outArg;
const outIndex = args.findIndex(a => a === '--out' || a.startsWith('--out='));
if (outIndex !== -1) {
  const token = args[outIndex];
  if (token.startsWith('--out=')) {
    outArg = token.slice('--out='.length);
    args.splice(outIndex, 1);
  } else {
    outArg = args[outIndex + 1];
    args.splice(outIndex, 2);
  }
  if (!outArg) {
    console.error('--out requires a directory path.');
    process.exit(1);
  }
}

// --theme auto|dark|light|both. `auto` (the default) pins the PNG to dark and
// lets the SVG follow the viewer's prefers-color-scheme. `both` writes the
// primary (dark) outputs under the usual optimized.* names plus a suffixed
// optimized.light.* pair, so adding it to an existing command never moves the
// files that command already consumed.
let themeArg = 'auto';
const themeIndex = args.findIndex(a => a === '--theme' || a.startsWith('--theme='));
if (themeIndex !== -1) {
  const token = args[themeIndex];
  if (token.startsWith('--theme=')) {
    themeArg = token.slice('--theme='.length);
    args.splice(themeIndex, 1);
  } else {
    themeArg = args[themeIndex + 1];
    args.splice(themeIndex, 2);
  }
  if (!THEME_REQUESTS.includes(themeArg)) {
    console.error(`--theme must be one of: ${THEME_REQUESTS.join(', ')}.`);
    process.exit(1);
  }
}

const inputArg = args[0];
const INPUT_PATH = inputArg ? path.resolve(inputArg) : path.resolve('examples/system_context.yaml');
const OUTPUT_DIR = path.resolve(outArg || process.env.NUDGE_OUTPUT_DIR || '.nudge');

const enhance = hasEnhance && !process.env.NUDGE_NO_LLM;

console.log('=== Nudge: Deterministic C4 Layout Engine ===');
console.log(`Input: ${INPUT_PATH}`);
console.log(`Output: ${OUTPUT_DIR}`);
console.log(`LLM Enhancement: ${enhance ? 'Enabled' : 'Disabled (deterministic-only mode)'}`);
console.log(`Theme: ${themeArg}${themeArg === 'auto' ? " (PNG dark; SVG follows the viewer's preference)" : ''}`);

let diagramModel;
try {
  const content = fs.readFileSync(INPUT_PATH, 'utf8');
  const ext = path.extname(INPUT_PATH).toLowerCase();
  if (ext === '.mermaid' || ext === '.mmd') {
    console.log('[Parser] Input identified as Mermaid. Compiling C4Context...');
    diagramModel = parseMermaidC4(content);
  } else if (ext === '.puml' || ext === '.plantuml') {
    console.log('[Parser] Input identified as PlantUML. Compiling C4...');
    diagramModel = parsePlantUMLC4(content);
  } else {
    console.log('[Parser] Input identified as YAML. Parsing...');
    diagramModel = yaml.load(content);
  }
} catch (err) {
  console.error('Failed to read/parse input file:', err.message);
  process.exit(1);
}

if (!diagramModel || typeof diagramModel !== 'object') {
  console.error('Input file parsed to an empty or invalid structure.');
  process.exit(1);
}
if (!Array.isArray(diagramModel.nodes)) {
  console.error("Input is missing a 'nodes' array. Check your YAML or Mermaid syntax.");
  process.exit(1);
}
if (!Array.isArray(diagramModel.edges)) {
  console.error("Input is missing an 'edges' array. Check your YAML or Mermaid syntax.");
  process.exit(1);
}

console.log(`Diagram loaded: "${diagramModel.title}"`);
console.log('Initial Layout Options:', JSON.stringify(diagramModel.layoutOptions, null, 2));

let result;
try {
  result = await optimizeDiagram({
    diagramModel,
    outputDir: OUTPUT_DIR,
    onLog: (msg) => console.log(msg),
    checkpointTimeout: Number(process.env.NUDGE_CHECKPOINT_TIMEOUT || 90000),
    enhance,
    theme: themeArg,
  });
} catch (err) {
  // An unsupported diagram is a contract refusal, not a crash. Print the
  // explanation on its own, with no stack trace to read past.
  if (err?.code === 'UNSUPPORTED_DIAGRAM') {
    console.error(`\n❌ Unsupported diagram\n\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
const { success, history, svgContent, pngPath, themes: themeOutputs } = result;

console.log('\n=================================');
console.log('       OPTIMIZATION SUMMARY       ');
console.log('=================================');
// All six defect classes, in the severity order declared in
// docs/IMPROVEMENT_PLAN.md. A hardcoded projection used to silently drop every
// class it did not name, which is how four of the six stayed invisible.
console.table(history.map(h => ({
  Iter: h.iteration,
  Collisions: h.collisions,
  'Elem Overlap': h.overlaps,
  'Line×Elem': h.crossings,
  'Label×Elem': h.labelElementCrossings,
  'Line Overlap': h.lineOverlaps,
  'Line×Line': h.lineCrossings,
  'Label×Line': h.labelLineIntersections,
  'Label×Label': h.labelLabelOverlaps,
  'Aspect Ratio': h.aspectRatio,
  'Node Spacing': h.options['elk.spacing.nodeNode'] || 'unset',
  'Layer Spacing': h.options['elk.layered.spacing.nodeNodeBetweenLayers'] || 'unset',
})));

if (success) {
  console.log('\n🎉 Success! Optimized assets exported:');
  for (const [name, out] of Object.entries(themeOutputs || {})) {
    const label = Object.keys(themeOutputs).length > 1 ? ` (${name})` : '';
    console.log(`   SVG${label}: ${out.svgPath}`);
    console.log(`   PNG${label}: ${out.pngPath}`);
  }
} else {
  console.log('\n⚠️  Finished with remaining layout issues. Best-effort PNG saved.');
  console.log(`   PNG: ${pngPath}`);
  process.exit(1);
}
