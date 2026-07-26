// The measurable retirement criterion for the legacy connection-line router.
//
// CLAUDE.md says to keep the legacy router "until every fixture routes fully on
// the grid" — a condition nothing measured, so two routers plus nine probe
// scripts stayed live indefinitely (docs/IMPROVEMENT_PLAN.md INC-20). This test
// makes it a number: when it reaches zero, ~1,800 lines can be deleted.
//
// **The criterion is now met: zero fallbacks across the corpus.**
//
// It was reached in two steps, neither of them a router change. Self-relationships
// stopped falling back once the grid router learned to emit a loop instead of
// refusing them (a self-loop is a fixed shape, not a search). The remaining 28
// were never a routing problem at all: they were relationships whose endpoint
// elements the engine never laid out, because `container_plan.js` plans a single
// Boundary and silently dropped the rest. Nudge is a single-Boundary tool by
// design, so those diagrams are now refused up front rather than half-drawn
// (src/core/validation.js).
//
// So this is now an absolute invariant, not a ratchet: every relationship in
// every diagram Nudge accepts is routed by the grid router.
//
// Retiring the legacy router is therefore unblocked — ~1,800 lines across
// connection_line_router.js and route_candidate_rules.js, plus cost model #2 of
// the two still live. It is deliberately left as its own change: it also removes
// the documented `NUDGE_ROUTER=legacy` escape hatch, which is part of the CLI
// surface the CHANGELOG's semver policy covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../../src/plantuml_parser.js';
import { normalizeDiagramModel } from '../../src/core/optimizer.js';
import { findFixtures } from '../quality_baseline.js';

test('the grid router routes every relationship Nudge accepts', { timeout: 600000 }, async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let totalEdges = 0;
  let totalFallbacks = 0;
  const perFixture = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(new URL('../../src/render.html', import.meta.url).href);

    for (const { key, fullPath } of findFixtures()) {
      const source = fs.readFileSync(fullPath, 'utf8');
      const model = normalizeDiagramModel(
        key.endsWith('.puml') ? parsePlantUMLC4(source) : parseMermaidC4(source)
      );
      const result = await page.evaluate(d => window.renderDiagram(d), model);
      assert.ok(result?.success, `${key} failed to render: ${result?.error}`);

      // Flat/ELK diagrams never enter the container routing pass at all.
      const stats = result.routerStats;
      if (!stats) continue;

      assert.equal(stats.mode, 'grid', `${key} did not use the grid router by default`);
      totalEdges += stats.totalEdges;
      totalFallbacks += stats.legacyFallbacks;
      if (stats.legacyFallbacks > 0) {
        perFixture.push(`${key}: ${stats.legacyFallbacks}/${stats.totalEdges} (${stats.legacyFallbackEdgeIds.join(', ')})`);
      }
    }
  } finally {
    await browser.close();
  }

  assert.ok(totalEdges > 0, 'expected at least one container-routed fixture');

  console.log(
    `  [router] grid-routed ${totalEdges}/${totalEdges} relationships, ` +
    `${totalFallbacks} legacy fallbacks`
  );
  for (const line of perFixture) console.log(`    ${line}`);

  assert.equal(
    totalFallbacks, 0,
    `The grid router handed ${totalFallbacks} relationship(s) to the legacy router.\n\n` +
    'This is an absolute invariant, not a budget: every diagram Nudge accepts must ' +
    'route entirely on the grid. A fallback means either a routing regression, or a ' +
    'diagram shape that should have been refused by src/core/validation.js rather ' +
    'than routed by guesswork.\n\n' +
    perFixture.join('\n')
  );
});
