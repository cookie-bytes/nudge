#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';

const DEFAULT_INPUT = 'test/content-delivery-just-in-time.mermaid';
const DEFAULT_PORT_RESPONSE = 'test_outputs/port_hint_probe/lm_response.json';
const DEFAULT_ORDER_RESPONSE = 'test_outputs/top_order_probe/lm_response.json';
const DEFAULT_OUTPUT_DIR = 'test_outputs/top_order_apply_probe';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    portResponse: DEFAULT_PORT_RESPONSE,
    orderResponse: DEFAULT_ORDER_RESPONSE,
    outputDir: DEFAULT_OUTPUT_DIR
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--port-response') args.portResponse = argv[++i];
    else if (arg === '--order-response') args.orderResponse = argv[++i];
    else if (arg === '--output-dir' || arg === '-o') args.outputDir = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/top_order_apply_probe.js [options]

Apply an LM-suggested top-row internal order and compare before/after scores.

Options:
  -i, --input <file>             Mermaid source file
                                 default: ${DEFAULT_INPUT}
      --port-response <file>     Port hints to apply before both renders
                                 default: ${DEFAULT_PORT_RESPONSE}
      --order-response <file>    Top-order LM response
                                 default: ${DEFAULT_ORDER_RESPONSE}
  -o, --output-dir <dir>         Output directory
                                 default: ${DEFAULT_OUTPUT_DIR}
`);
}

function loadJsonResponse(responsePath) {
  const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
  if (response.parsed) return response.parsed;
  if (response.raw) {
    const jsonMatch = response.raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  }
  return response;
}

function loadPortHints(responsePath) {
  if (!fs.existsSync(responsePath)) return {};
  const response = loadJsonResponse(responsePath);
  const suggestions = response.suggestions || [];
  const hints = {};
  for (const suggestion of suggestions) {
    if (!suggestion.edgeId) continue;
    const hint = {};
    if (suggestion.sourceSide) hint.sourceSide = suggestion.sourceSide;
    if (suggestion.targetSide) hint.targetSide = suggestion.targetSide;
    if (Object.keys(hint).length > 0) hints[suggestion.edgeId] = hint;
  }
  return hints;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function renderDiagram(diagramModel, screenshotPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 2400 } });
    const templateUrl = new URL('../src/render.html', import.meta.url).href;
    await page.goto(templateUrl);
    const graph = await page.evaluate((data) => window.renderDiagram(data), diagramModel);
    if (!graph.success) throw new Error(graph.error || 'render failed');
    await page.setViewportSize({
      width: Math.ceil(graph.width) + 100,
      height: Math.ceil(graph.height) + 100
    });
    const svgElement = await page.$('#svg-root');
    await svgElement.screenshot({ path: screenshotPath });
    return graph;
  } finally {
    await browser.close();
  }
}

function scoreReport(report) {
  return round(
    report.overlapCount * 100000 +
    report.intersectionCount * 100000 +
    report.edgeQuality.edgeCrossingCount * 500 +
    report.edgeQuality.edgeOverlapCount * 500 +
    report.edgeQuality.edgeOverlapPx * 2 +
    report.edgeQuality.labelEdgeIntersectionCount * 250 +
    report.edgeQuality.totalBends * 4 +
    report.edgeQuality.totalRouteLength * 0.02
  );
}

function topOrder(graph) {
  const containers = graph.nodes.filter(node => node.type === 'container');
  const minY = Math.min(...containers.map(node => node.y));
  return containers
    .filter(node => Math.abs(node.y - minY) < 5)
    .sort((a, b) => a.x - b.x)
    .map(node => node.id);
}

function summarize(graph, report) {
  return {
    score: scoreReport(report),
    topOrder: topOrder(graph),
    hardCollisions: report.collisions.length,
    nodeOverlaps: report.overlapCount,
    edgeNodeCrossings: report.intersectionCount,
    edgeCrossings: report.edgeQuality.edgeCrossingCount,
    edgeOverlaps: report.edgeQuality.edgeOverlapCount,
    edgeOverlapPx: report.edgeQuality.edgeOverlapPx,
    labelEdgeIntersections: report.edgeQuality.labelEdgeIntersectionCount,
    totalBends: report.edgeQuality.totalBends,
    totalRouteLength: report.edgeQuality.totalRouteLength
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const diagramModel = parseMermaidC4(fs.readFileSync(inputPath, 'utf8'));
  const portHints = loadPortHints(path.resolve(args.portResponse));
  const orderResponse = loadJsonResponse(path.resolve(args.orderResponse));
  const suggestedOrder = orderResponse.suggestedOrder || orderResponse.currentOrder;
  const layerIndex = Number.isInteger(orderResponse.layerIndex) ? orderResponse.layerIndex : 0;
  if (!Array.isArray(suggestedOrder) || suggestedOrder.length === 0) {
    throw new Error(`No suggestedOrder found in ${args.orderResponse}`);
  }

  const baseOverrides = { portHints };
  const baselineGraph = await renderDiagram({
    ...diagramModel,
    _layoutOverrides: baseOverrides
  }, path.join(outputDir, 'baseline.png'));

  const orderedGraph = await renderDiagram({
    ...diagramModel,
    _layoutOverrides: {
      ...baseOverrides,
      internalOrder: {
        [layerIndex]: suggestedOrder
      }
    }
  }, path.join(outputDir, 'ordered.png'));

  const baselineReport = analyzeLayout(baselineGraph);
  const orderedReport = analyzeLayout(orderedGraph);
  const baseline = summarize(baselineGraph, baselineReport);
  const ordered = summarize(orderedGraph, orderedReport);
  const summary = {
    input: inputPath,
    orderResponse: path.resolve(args.orderResponse),
    suggestion: orderResponse,
    baseline,
    ordered,
    delta: {
      score: round(ordered.score - baseline.score),
      edgeCrossings: ordered.edgeCrossings - baseline.edgeCrossings,
      edgeOverlaps: ordered.edgeOverlaps - baseline.edgeOverlaps,
      labelEdgeIntersections: ordered.labelEdgeIntersections - baseline.labelEdgeIntersections,
      totalBends: ordered.totalBends - baseline.totalBends,
      totalRouteLength: ordered.totalRouteLength - baseline.totalRouteLength
    },
    verdict: ordered.score < baseline.score ? 'improved' : ordered.score > baseline.score ? 'worse' : 'unchanged'
  };

  fs.writeFileSync(path.join(outputDir, 'rating_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${path.join(outputDir, 'baseline.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'ordered.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'rating_summary.json')}`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
