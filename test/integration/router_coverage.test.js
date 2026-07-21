// The measurable retirement criterion for the legacy connection-line router.
//
// CLAUDE.md says to keep the legacy router "until every fixture routes fully on
// the grid" — a condition nothing measured, so two routers plus nine probe
// scripts stayed live indefinitely (docs/IMPROVEMENT_PLAN.md INC-20). This test
// makes it a number: when it reaches zero, ~1,800 lines can be deleted.
//
// Deliberately a ratchet, not a gate. The fallback is correct behaviour today —
// the grid router cannot route relationships whose endpoints are not placed
// leaf elements, as in multi-boundary diagrams — so the number must shrink,
// never grow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../../src/plantuml_parser.js';
import { normalizeDiagramModel } from '../../src/core/optimizer.js';
import { findFixtures } from '../quality_baseline.js';

// Measured over the full fixture corpus. Every fallback is concentrated in the
// two multi-boundary fixtures — which are also the two carrying the bulk of the
// corpus's remaining defects (18 and 12 respectively). That is not a
// coincidence worth ignoring: the relationships the grid router hands off are
// the same ones that end up crossing and overlapping.
const FALLBACK_BUDGET = 28; // 14 per source format (.mermaid + .puml)

test('the grid router handles all but a known set of relationships', { timeout: 600000 }, async () => {
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
    `  [router] legacy fallbacks: ${totalFallbacks}/${totalEdges} relationships ` +
    `(budget ${FALLBACK_BUDGET})`
  );
  for (const line of perFixture) console.log(`    ${line}`);

  assert.ok(
    totalFallbacks <= FALLBACK_BUDGET,
    `Legacy router fallbacks regressed: ${totalFallbacks} > ${FALLBACK_BUDGET}.\n` +
    perFixture.join('\n')
  );

  if (totalFallbacks === 0) {
    assert.fail(
      'No fixture falls back to the legacy router any more. That is the stated ' +
      'retirement criterion: delete src/renderer/routing/connection_line_router.js, ' +
      'route_candidate_rules.js, the NUDGE_ROUTER=legacy branch and the scripts/*_probe.js ' +
      'files, then remove this assertion.'
    );
  }
});
