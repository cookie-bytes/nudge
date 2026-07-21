#!/usr/bin/env node
// Captures the per-fixture quality baseline consumed by the ratchet in
// test/run_tests.js. Generalises the old route-only baseline to all six defect
// classes (docs/IMPROVEMENT_PLAN.md INC-6).
//
// Renders every fixture under test/fixtures/diagrams/ through the *production*
// path — `normalizeDiagramModel → renderDiagram → analyzeLayout` — because
// skipping normalisation tests a layout C4Context diagrams never actually get.
//
// Re-running this after a layout change rewrites the baseline, so the quality
// delta of that change shows up as a reviewable diff rather than disappearing.
//
// Usage: node scripts/capture_quality_baseline.js [--output <path>]

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../src/plantuml_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';
import { normalizeDiagramModel } from '../src/core/optimizer.js';
import {
  WORKSPACE_ROOT, BASELINE_PATH, findFixtures, qualityVector, RATCHET_METRICS
} from '../test/quality_baseline.js';

function parseArgs(argv) {
  const args = { output: BASELINE_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output') args.output = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
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

const args = parseArgs(process.argv.slice(2));
const fixtureList = findFixtures();
if (fixtureList.length === 0) throw new Error('No fixtures found under test/fixtures/diagrams/');

console.log(`Capturing quality baseline for ${fixtureList.length} fixture(s)...`);
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const fixtures = {};
let failures = 0;

try {
  const page = await browser.newPage();
  await page.goto(new URL('../src/render.html', import.meta.url).href);

  for (const { key, fullPath } of fixtureList) {
    const content = fs.readFileSync(fullPath, 'utf8');
    const model = normalizeDiagramModel(
      key.endsWith('.puml') ? parsePlantUMLC4(content) : parseMermaidC4(content)
    );
    const result = await page.evaluate(async (data) => window.renderDiagram(data), model);

    if (!result?.success) {
      console.error(`  [FAIL] ${key}: ${result?.error}`);
      fixtures[key] = { renderError: result?.error ?? 'unknown render error' };
      failures++;
      continue;
    }

    const vector = qualityVector(model, result, analyzeLayout(result));
    fixtures[key] = vector;
    const defects = RATCHET_METRICS.reduce((sum, m) => sum + (vector[m] || 0), 0);
    console.log(`  ${key}: ${defects} defect(s)` + (defects
      ? ` — ${RATCHET_METRICS.filter(m => vector[m]).map(m => `${m}=${vector[m]}`).join(' ')}`
      : ''));
  }
} finally {
  await browser.close();
}

const totals = {};
for (const metric of RATCHET_METRICS) {
  totals[metric] = Object.values(fixtures).reduce((sum, f) => sum + (f[metric] || 0), 0);
}

fs.mkdirSync(path.dirname(args.output), { recursive: true });
fs.writeFileSync(args.output, JSON.stringify({
  generatedAt: new Date().toISOString(),
  git: gitInfo(),
  router: process.env.NUDGE_ROUTER || 'grid',
  totals,
  fixtures,
}, null, 2) + '\n');

console.log(`\nCorpus totals: ${Object.entries(totals).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'clean'}`);
console.log(`Baseline written to ${path.relative(WORKSPACE_ROOT, args.output)}`);
if (failures > 0) {
  console.error(`${failures} fixture(s) failed to render — baseline entries record the error.`);
  process.exit(1);
}
