// Every declared Architecture Element must actually render.
//
// This is the most basic completeness property a diagram tool has, and nothing
// asserted it. `buildContainerZonePlan` takes the *first* top-level Boundary and
// lays out its direct children (`container_plan.js`: `nodes.find(n => n.type ===
// 'boundary')`). Anything else — a second sibling Boundary, or a leaf element
// nested inside a sub-Boundary — is never placed and never drawn, while the
// relationships pointing at it are still emitted and routed to arbitrary
// coordinates.
//
// The corpus suite graded both affected fixtures **PASSED** while half of each
// diagram was missing, because every quality metric is computed over the
// elements that *did* render. A defect class with no counter is invisible, and
// this one silently deletes user content — the most severe failure mode in the
// taxonomy, and the one nothing was watching (docs/IMPROVEMENT_PLAN.md §1
// root cause #2).
//
// Ratchet, not a gate: the two known diagrams are genuinely broken today and
// fixing them needs multi-Boundary layout, which is a large change. Until then
// the count must not grow and no other fixture may join them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../../src/plantuml_parser.js';
import { normalizeDiagramModel } from '../../src/core/optimizer.js';
import { findFixtures } from '../quality_baseline.js';

/**
 * Known-dropped elements, per fixture. Measured, not guessed.
 *
 * `multi_boundary_cross_parent_routes` loses the whole second Boundary;
 * `nested_boundary_characterization` renders its two sub-Boundaries but none of
 * their leaf children. Both entries must shrink to `[]` and then be deleted when
 * multi-Boundary layout lands.
 */
const KNOWN_DROPPED = {
  'refactor/multi_boundary_cross_parent_routes.mermaid':
    ['platform', 'accounts', 'orders', 'events', 'accountsDb', 'ordersDb'],
  'refactor/multi_boundary_cross_parent_routes.puml':
    ['platform', 'accounts', 'orders', 'events', 'accountsDb', 'ordersDb'],
  'refactor/nested_boundary_characterization.mermaid':
    ['accounts', 'ledger', 'ledgerDb', 'api', 'commands'],
  'refactor/nested_boundary_characterization.puml':
    ['accounts', 'ledger', 'ledgerDb', 'api', 'commands'],
};

/** Every element id in the model, at any nesting depth. */
function declaredIds(nodes, out = []) {
  for (const node of nodes || []) {
    out.push(node.id);
    declaredIds(node.children, out);
  }
  return out;
}

test('every declared element renders', { timeout: 600000 }, async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const unexpected = [];
  const fixed = [];
  let droppedTotal = 0;

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

      const rendered = new Set((result.nodes || []).map(n => n.id));
      const missing = declaredIds(model.nodes).filter(id => !rendered.has(id));
      droppedTotal += missing.length;

      const allowed = new Set(KNOWN_DROPPED[key] || []);
      const surprises = missing.filter(id => !allowed.has(id));
      if (surprises.length > 0) {
        unexpected.push(`${key}: ${surprises.join(', ')}`);
      }
      const recovered = [...allowed].filter(id => rendered.has(id));
      if (recovered.length > 0) {
        fixed.push(`${key}: ${recovered.join(', ')}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`  [coverage] dropped elements: ${droppedTotal} across ${Object.keys(KNOWN_DROPPED).length} known fixture(s)`);

  assert.deepEqual(
    unexpected, [],
    'Fixtures dropped elements that are not in KNOWN_DROPPED. An element declared ' +
    'in the source and absent from the render is silently deleted user content.\n\n' +
    unexpected.join('\n')
  );

  assert.deepEqual(
    fixed, [],
    'Elements listed in KNOWN_DROPPED now render — this is the improvement that ' +
    'was wanted. Remove them from the list so the ratchet tightens.\n\n' +
    fixed.join('\n')
  );
});
