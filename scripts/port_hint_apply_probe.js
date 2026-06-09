#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';

const DEFAULT_INPUT = 'test/content-delivery-just-in-time.mermaid';
const DEFAULT_RESPONSE = 'test_outputs/port_hint_probe/lm_response.json';
const DEFAULT_OUTPUT_DIR = 'test_outputs/port_hint_apply_probe';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    response: DEFAULT_RESPONSE,
    outputDir: DEFAULT_OUTPUT_DIR
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--response' || arg === '-r') args.response = argv[++i];
    else if (arg === '--output-dir' || arg === '-o') args.outputDir = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/port_hint_apply_probe.js [options]

Apply local-LM port hints to a rendered C4 diagram and compare before/after
geometry scores. This is an experiment rig; it does not modify source diagrams.

Options:
  -i, --input <file>       Mermaid source file
                           default: ${DEFAULT_INPUT}
  -r, --response <file>    LM response JSON from port_hint_probe.js
                           default: ${DEFAULT_RESPONSE}
  -o, --output-dir <dir>   Directory for screenshots and rating summary
                           default: ${DEFAULT_OUTPUT_DIR}
`);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function pointsForEdge(edge) {
  const section = edge.sections?.[0];
  if (!section) return [];
  return [
    section.startPoint,
    ...(section.bendPoints || []),
    section.endPoint
  ].map(p => ({ x: round(p.x), y: round(p.y) }));
}

function routeLength(points) {
  return round(points.slice(0, -1).reduce((sum, point, index) => {
    const next = points[index + 1];
    return sum + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0));
}

function pointSide(point, node) {
  if (!point || !node) return 'UNKNOWN';
  const distances = [
    ['LEFT', Math.abs(point.x - node.x)],
    ['RIGHT', Math.abs(point.x - (node.x + node.width))],
    ['TOP', Math.abs(point.y - node.y)],
    ['BOTTOM', Math.abs(point.y - (node.y + node.height))]
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

function loadSuggestions(responsePath) {
  const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
  if (Array.isArray(response.suggestions)) return response.suggestions;
  if (Array.isArray(response.parsed?.suggestions)) return response.parsed.suggestions;
  if (response.raw) {
    const jsonMatch = response.raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.suggestions)) return parsed.suggestions;
    }
  }
  return [];
}

function suggestionsToPortHints(suggestions) {
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

async function renderDiagram(diagramModel, screenshotPath) {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 2400 } });
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
    });

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

function summarizeGraph(graph, report, suggestions) {
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const suggestedEdgeIds = new Set(suggestions.map(suggestion => suggestion.edgeId));
  const suggestedEdges = graph.edges
    .filter(edge => suggestedEdgeIds.has(edge.id))
    .map(edge => {
      const sourceId = edge.sources[0];
      const targetId = edge.targets[0];
      const source = nodesById.get(sourceId);
      const target = nodesById.get(targetId);
      const points = pointsForEdge(edge);
      return {
        edgeId: edge.id,
        connection: `${source?.label || sourceId} (${sourceId}) -> ${target?.label || targetId} (${targetId})`,
        label: edge.labels?.[0]?.text || '',
        sourceSide: pointSide(points[0], source),
        targetSide: pointSide(points.at(-1), target),
        routeLength: routeLength(points),
        bendCount: Math.max(0, points.length - 2),
        points
      };
    });

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
    totalRouteLength: report.edgeQuality.totalRouteLength,
    suggestedEdges
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const responsePath = path.resolve(args.response);
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const source = fs.readFileSync(inputPath, 'utf8');
  const diagramModel = parseMermaidC4(source);
  const suggestions = loadSuggestions(responsePath);
  const portHints = suggestionsToPortHints(suggestions);

  if (Object.keys(portHints).length === 0) {
    throw new Error(`No applicable port hints found in ${responsePath}`);
  }

  const baselineGraph = await renderDiagram(diagramModel, path.join(outputDir, 'baseline.png'));
  const hintedGraph = await renderDiagram({
    ...diagramModel,
    _layoutOverrides: {
      ...(diagramModel._layoutOverrides || {}),
      portHints
    }
  }, path.join(outputDir, 'hinted.png'));

  const baselineReport = analyzeLayout(baselineGraph);
  const hintedReport = analyzeLayout(hintedGraph);
  const baseline = summarizeGraph(baselineGraph, baselineReport, suggestions);
  const hinted = summarizeGraph(hintedGraph, hintedReport, suggestions);

  const summary = {
    input: inputPath,
    response: responsePath,
    suggestions,
    portHints,
    baseline,
    hinted,
    delta: {
      score: round(hinted.score - baseline.score),
      edgeCrossings: hinted.edgeCrossings - baseline.edgeCrossings,
      edgeOverlaps: hinted.edgeOverlaps - baseline.edgeOverlaps,
      labelEdgeIntersections: hinted.labelEdgeIntersections - baseline.labelEdgeIntersections,
      totalBends: hinted.totalBends - baseline.totalBends,
      totalRouteLength: hinted.totalRouteLength - baseline.totalRouteLength
    },
    verdict: hinted.score < baseline.score ? 'improved' : hinted.score > baseline.score ? 'worse' : 'unchanged'
  };

  fs.writeFileSync(path.join(outputDir, 'rating_summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${path.join(outputDir, 'baseline.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'hinted.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'rating_summary.json')}`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
