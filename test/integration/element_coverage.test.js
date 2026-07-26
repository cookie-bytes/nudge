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
// Now an **absolute gate**, not a ratchet. The two diagrams that broke this are
// outside the single-Boundary contract Nudge supports, so they are refused up
// front (src/core/validation.js) and kept as rejection fixtures instead of being
// half-drawn — see test/integration/unsupported_diagrams.test.js. Every diagram
// Nudge accepts renders every element it declares, with no exceptions to carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../../src/plantuml_parser.js';
import { normalizeDiagramModel } from '../../src/core/optimizer.js';
import { findFixtures } from '../quality_baseline.js';

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

  const dropped = [];
  let checked = 0;

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
      if (missing.length > 0) dropped.push(`${key}: ${missing.join(', ')}`);
      checked++;
    }
  } finally {
    await browser.close();
  }

  console.log(`  [coverage] ${checked} fixtures render every element they declare`);

  assert.deepEqual(
    dropped, [],
    'A fixture dropped elements. An element declared in the source and absent from ' +
    'the render is silently deleted user content — the most severe failure mode in ' +
    'the taxonomy, and it renders as dangling arrows pointing at nothing.\n\n' +
    'If the diagram is outside the single-Boundary contract it must be *refused* ' +
    '(src/core/validation.js), never half-drawn.\n\n' +
    dropped.join('\n')
  );
});
