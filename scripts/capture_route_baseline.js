// Captures a per-fixture connection-line quality baseline for router A/B comparison.
//
// Renders every .mermaid fixture under test/fixtures/diagrams/ with the current
// renderer, runs the math scorer (analyzeLayout), and writes the metrics to
// test/fixtures/baselines/route_quality_baseline.json. The baseline is committed
// so a future router (e.g. NUDGE_ROUTER=grid) can be diffed against it fixture
// by fixture instead of re-judging every diagram by eye.
//
// Usage: node scripts/capture_route_baseline.js [--output <path>]

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'diagrams');
const DEFAULT_OUTPUT = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'baselines', 'route_quality_baseline.json');

function parseArgs(argv) {
  const args = { output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') args.output = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function findFixtures(dir, base = dir) {
  const fixtures = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) fixtures.push(...findFixtures(full, base));
    else if (entry.name.endsWith('.mermaid')) fixtures.push(path.relative(base, full));
  }
  return fixtures.sort();
}

function gitInfo() {
  try {
    const commit = execFileSync('git', ['-C', WORKSPACE_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', WORKSPACE_ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

function countBoundaryViolations(model, result) {
  let violations = 0;
  const nodeMap = new Map((result.nodes || []).map(n => [n.id, n]));
  for (const node of model.nodes || []) {
    if (node.type !== 'boundary' || !node.children?.length) continue;
    const boundary = nodeMap.get(node.id);
    if (!boundary) continue;
    for (const child of node.children) {
      const cn = nodeMap.get(child.id);
      if (!cn) continue;
      if (
        cn.x < boundary.x || cn.y < boundary.y ||
        cn.x + cn.width > boundary.x + boundary.width ||
        cn.y + cn.height > boundary.y + boundary.height
      ) violations++;
    }
  }
  return violations;
}

function countOrthogonalViolations(result) {
  let violations = 0;
  for (const edge of result.edges || []) {
    const section = edge.sections?.[0];
    if (!section) continue;
    const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
    for (let i = 0; i < points.length - 1; i++) {
      const horizontal = Math.abs(points[i].y - points[i + 1].y) < 0.5;
      const vertical = Math.abs(points[i].x - points[i + 1].x) < 0.5;
      if (!horizontal && !vertical) violations++;
    }
  }
  return violations;
}

async function captureBaseline() {
  const args = parseArgs(process.argv.slice(2));
  const fixtureFiles = findFixtures(FIXTURES_DIR);
  if (fixtureFiles.length === 0) throw new Error(`No .mermaid fixtures found under ${FIXTURES_DIR}`);

  console.log(`Capturing route quality baseline for ${fixtureFiles.length} fixture(s)...`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(new URL('../src/render.html', import.meta.url).href);

  const fixtures = {};
  let failures = 0;

  try {
    for (const file of fixtureFiles) {
      const content = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
      const model = parseMermaidC4(content);
      const result = await page.evaluate(async (data) => window.renderDiagram(data), model);

      if (!result.success) {
        console.error(`  [FAIL] ${file}: ${result.error}`);
        fixtures[file] = { renderError: result.error };
        failures++;
        continue;
      }

      const report = analyzeLayout(result);
      fixtures[file] = {
        elementOverlaps: report.overlapCount,
        connectionLineElementCrossings: report.intersectionCount,
        boundaryViolations: countBoundaryViolations(model, result),
        orthogonalViolations: countOrthogonalViolations(result),
        connectionLineCrossings: report.edgeQuality.edgeCrossingCount,
        connectionLineOverlaps: report.edgeQuality.edgeOverlapCount,
        connectionLineOverlapPx: report.edgeQuality.edgeOverlapPx,
        labelLineIntersections: report.edgeQuality.labelEdgeIntersectionCount,
        totalBends: report.edgeQuality.totalBends,
        totalRouteLength: report.edgeQuality.totalRouteLength,
        aspectRatio: report.aspectRatio,
        width: Math.round(result.width),
        height: Math.round(result.height)
      };
      console.log(
        `  ${file}: lineX=${report.edgeQuality.edgeCrossingCount} lineOL=${report.edgeQuality.edgeOverlapCount} ` +
        `elemX=${report.intersectionCount} bends=${report.edgeQuality.totalBends} len=${report.edgeQuality.totalRouteLength}`
      );
    }
  } finally {
    await browser.close();
  }

  const baseline = {
    generatedAt: new Date().toISOString(),
    git: gitInfo(),
    router: process.env.NUDGE_ROUTER || 'grid',
    fixtures
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nBaseline written to ${path.relative(WORKSPACE_ROOT, args.output)}`);
  if (failures > 0) {
    console.error(`${failures} fixture(s) failed to render — baseline entries record the error.`);
    process.exit(1);
  }
}

captureBaseline().catch(err => {
  console.error('Fatal error capturing baseline:', err);
  process.exit(1);
});
