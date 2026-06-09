#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';

const DEFAULT_INPUT = 'test/content-delivery-just-in-time.mermaid';
const DEFAULT_PORT_RESPONSE = 'test_outputs/port_hint_probe/lm_response.json';
const DEFAULT_ORDER_RESPONSE = 'test_outputs/top_order_probe/lm_response.json';
const DEFAULT_ROUTE_RESPONSE = 'test_outputs/diagonal_route_probe/lm_response.json';
const DEFAULT_OUTPUT_DIR = 'test_outputs/diagonal_route_apply_probe';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    portResponse: DEFAULT_PORT_RESPONSE,
    orderResponse: DEFAULT_ORDER_RESPONSE,
    routeResponse: DEFAULT_ROUTE_RESPONSE,
    outputDir: DEFAULT_OUTPUT_DIR
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--port-response') args.portResponse = argv[++i];
    else if (arg === '--order-response') args.orderResponse = argv[++i];
    else if (arg === '--route-response') args.routeResponse = argv[++i];
    else if (arg === '--output-dir' || arg === '-o') args.outputDir = argv[++i];
  }
  return args;
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
  const hints = {};
  for (const suggestion of response.suggestions || []) {
    if (!suggestion.edgeId) continue;
    const hint = {};
    if (suggestion.sourceSide) hint.sourceSide = suggestion.sourceSide;
    if (suggestion.targetSide) hint.targetSide = suggestion.targetSide;
    if (Object.keys(hint).length > 0) hints[suggestion.edgeId] = hint;
  }
  return hints;
}

function loadRouteHints(responsePath) {
  const response = loadJsonResponse(responsePath);
  const hints = {};
  for (const suggestion of response.suggestions || []) {
    if (!suggestion.edgeId || !suggestion.routeIntent || suggestion.routeIntent === 'KEEP_DIAGONAL') continue;
    hints[suggestion.edgeId] = { routeIntent: suggestion.routeIntent };
  }
  return { response, hints };
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
    await page.setViewportSize({ width: Math.ceil(graph.width) + 100, height: Math.ceil(graph.height) + 100 });
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

function summarize(graph, report) {
  return {
    score: scoreReport(report),
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
  const order = loadJsonResponse(path.resolve(args.orderResponse));
  const { response: routeResponse, hints: routeHints } = loadRouteHints(path.resolve(args.routeResponse));
  const baseOverrides = {
    portHints,
    internalOrder: { [order.layerIndex || 0]: order.suggestedOrder || order.currentOrder || [] }
  };

  const baselineGraph = await renderDiagram({ ...diagramModel, _layoutOverrides: baseOverrides }, path.join(outputDir, 'baseline.png'));
  const routedGraph = await renderDiagram({
    ...diagramModel,
    _layoutOverrides: {
      ...baseOverrides,
      routeHints
    }
  }, path.join(outputDir, 'routed.png'));

  const baselineReport = analyzeLayout(baselineGraph);
  const routedReport = analyzeLayout(routedGraph);
  const baseline = summarize(baselineGraph, baselineReport);
  const routed = summarize(routedGraph, routedReport);
  const summary = {
    input: inputPath,
    suggestion: routeResponse,
    routeHints,
    baseline,
    routed,
    delta: {
      score: round(routed.score - baseline.score),
      edgeCrossings: routed.edgeCrossings - baseline.edgeCrossings,
      edgeOverlaps: routed.edgeOverlaps - baseline.edgeOverlaps,
      labelEdgeIntersections: routed.labelEdgeIntersections - baseline.labelEdgeIntersections,
      totalBends: routed.totalBends - baseline.totalBends,
      totalRouteLength: routed.totalRouteLength - baseline.totalRouteLength
    },
    verdict: routed.score < baseline.score ? 'improved' : routed.score > baseline.score ? 'worse' : 'unchanged'
  };
  fs.writeFileSync(path.join(outputDir, 'rating_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${path.join(outputDir, 'baseline.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'routed.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'rating_summary.json')}`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
