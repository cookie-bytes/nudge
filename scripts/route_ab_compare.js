// A/B comparison: legacy candidate router vs experimental grid router
// (NUDGE_ROUTER=grid) across every .mermaid fixture, diffed against the
// committed baseline (test/fixtures/baselines/route_quality_baseline.json).
//
// Writes per-fixture PNGs for both routers plus a markdown report to
// test_outputs/router_ab/.
//
// Usage: node scripts/route_ab_compare.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'diagrams');
const BASELINE_PATH = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'baselines', 'route_quality_baseline.json');
const OUTPUT_DIR = path.join(WORKSPACE_ROOT, 'test_outputs', 'router_ab');

function findFixtures(dir, base = dir) {
  const fixtures = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) fixtures.push(...findFixtures(full, base));
    else if (entry.name.endsWith('.mermaid')) fixtures.push(path.relative(base, full));
  }
  return fixtures.sort();
}

function metricsFor(result) {
  const report = analyzeLayout(result);
  return {
    elementOverlaps: report.overlapCount,
    connectionLineElementCrossings: report.intersectionCount,
    connectionLineCrossings: report.edgeQuality.edgeCrossingCount,
    connectionLineOverlaps: report.edgeQuality.edgeOverlapCount,
    connectionLineOverlapPx: report.edgeQuality.edgeOverlapPx,
    labelLineIntersections: report.edgeQuality.labelEdgeIntersectionCount,
    totalBends: report.edgeQuality.totalBends,
    totalRouteLength: report.edgeQuality.totalRouteLength
  };
}

async function renderWith(page, content, router, pngPath) {
  const model = parseMermaidC4(content);
  await page.evaluate((mode) => { window.__nudgeRouter = mode; }, router);
  const result = await page.evaluate(async (data) => window.renderDiagram(data), model);
  await page.evaluate(() => { window.__nudgeRouter = undefined; });
  if (!result.success) return { error: result.error };

  const svgElement = await page.$('#svg-root');
  await page.setViewportSize({
    width: Math.min(8000, Math.ceil(result.width) + 100),
    height: Math.min(8000, Math.ceil(result.height) + 100)
  });
  await svgElement.screenshot({ path: pngPath });
  return { metrics: metricsFor(result) };
}

function fmtDelta(grid, legacy) {
  const d = grid - legacy;
  if (d === 0) return `${grid}`;
  return `${grid} (${d > 0 ? '+' : ''}${d})`;
}

async function run() {
  const baseline = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    : { fixtures: {} };
  const fixtureFiles = findFixtures(FIXTURES_DIR);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', err => console.error('  PAGE ERROR:', err.message));
  await page.goto(new URL('../src/render.html', import.meta.url).href);

  const rows = [];
  try {
    for (const file of fixtureFiles) {
      const base = path.basename(file, '.mermaid');
      const content = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
      console.log(`\n${file}`);

      const legacy = await renderWith(page, content, undefined, path.join(OUTPUT_DIR, `${base}_legacy.png`));
      const grid = await renderWith(page, content, 'grid', path.join(OUTPUT_DIR, `${base}_grid.png`));

      if (legacy.error || grid.error) {
        console.error(`  render error: legacy=${legacy.error || 'ok'} grid=${grid.error || 'ok'}`);
        rows.push({ file, error: legacy.error || grid.error });
        continue;
      }

      const l = legacy.metrics;
      const g = grid.metrics;
      const changed = JSON.stringify(l) !== JSON.stringify(g);
      rows.push({ file, legacy: l, grid: g, changed, baseline: baseline.fixtures[file] });
      console.log(
        `  legacy: lineX=${l.connectionLineCrossings} lineOL=${l.connectionLineOverlaps} elemX=${l.connectionLineElementCrossings} bends=${l.totalBends} len=${l.totalRouteLength}`
      );
      console.log(
        `  grid:   lineX=${g.connectionLineCrossings} lineOL=${g.connectionLineOverlaps} elemX=${g.connectionLineElementCrossings} bends=${g.totalBends} len=${g.totalRouteLength}${changed ? '' : '  (unchanged — flat/ELK diagram)'}`
      );
    }
  } finally {
    await browser.close();
  }

  // Markdown report
  let md = `# Router A/B: legacy candidate router vs grid router\n\nGenerated: ${new Date().toISOString()}\n\n`;
  md += `Grid cells show \`grid (delta vs legacy)\`; negative deltas are improvements.\n\n`;
  md += `| Fixture | LineX | LineOL | OL px | ElemX | Lbl/Line | Bends | Route px |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;
  const totals = { legacy: {}, grid: {} };
  const keys = ['connectionLineCrossings', 'connectionLineOverlaps', 'connectionLineOverlapPx', 'connectionLineElementCrossings', 'labelLineIntersections', 'totalBends', 'totalRouteLength'];
  for (const row of rows) {
    if (row.error) {
      md += `| ${row.file} | render error: ${row.error} | | | | | | |\n`;
      continue;
    }
    if (!row.changed) continue;
    for (const k of keys) {
      totals.legacy[k] = (totals.legacy[k] || 0) + row.legacy[k];
      totals.grid[k] = (totals.grid[k] || 0) + row.grid[k];
    }
    md += `| ${row.file} | ${fmtDelta(row.grid.connectionLineCrossings, row.legacy.connectionLineCrossings)} ` +
      `| ${fmtDelta(row.grid.connectionLineOverlaps, row.legacy.connectionLineOverlaps)} ` +
      `| ${fmtDelta(row.grid.connectionLineOverlapPx, row.legacy.connectionLineOverlapPx)} ` +
      `| ${fmtDelta(row.grid.connectionLineElementCrossings, row.legacy.connectionLineElementCrossings)} ` +
      `| ${fmtDelta(row.grid.labelLineIntersections, row.legacy.labelLineIntersections)} ` +
      `| ${fmtDelta(row.grid.totalBends, row.legacy.totalBends)} ` +
      `| ${fmtDelta(row.grid.totalRouteLength, row.legacy.totalRouteLength)} |\n`;
  }
  if (Object.keys(totals.grid).length > 0) {
    md += `| **TOTAL (container fixtures)** | ${fmtDelta(totals.grid.connectionLineCrossings, totals.legacy.connectionLineCrossings)} ` +
      `| ${fmtDelta(totals.grid.connectionLineOverlaps, totals.legacy.connectionLineOverlaps)} ` +
      `| ${fmtDelta(totals.grid.connectionLineOverlapPx, totals.legacy.connectionLineOverlapPx)} ` +
      `| ${fmtDelta(totals.grid.connectionLineElementCrossings, totals.legacy.connectionLineElementCrossings)} ` +
      `| ${fmtDelta(totals.grid.labelLineIntersections, totals.legacy.labelLineIntersections)} ` +
      `| ${fmtDelta(totals.grid.totalBends, totals.legacy.totalBends)} ` +
      `| ${fmtDelta(totals.grid.totalRouteLength, totals.legacy.totalRouteLength)} |\n`;
  }
  md += `\nFlat (ELK-routed) fixtures are excluded from the table: the grid router only applies to container diagrams.\n`;
  md += `\nPNG pairs for visual review are in this directory (\`*_legacy.png\` / \`*_grid.png\`).\n`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'router_ab_report.md'), md);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'router_ab_results.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(`\nReport written to ${path.relative(WORKSPACE_ROOT, path.join(OUTPUT_DIR, 'router_ab_report.md'))}`);
}

run().catch(err => {
  console.error('Fatal error running router A/B:', err);
  process.exit(1);
});
