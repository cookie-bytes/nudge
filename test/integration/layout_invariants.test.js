// Property-based invariants over seeded, generated diagrams.
//
// The hand-authored corpus only contains shapes somebody thought to draw, so it
// discovers an edge case only after a user hits it. These invariants must hold
// for *every* diagram, drawn or generated, and each failure reports its seed so
// it reproduces exactly and can be promoted into the corpus as a fixture.
//
// These are invariants, not quality targets. Connection-Line Crossings are a
// quality metric held by the ratchet; a label rendered outside the canvas or an
// element escaping its boundary is a broken diagram at any quality level.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { generateDiagram } from '../generators/diagram_generator.js';
import { normalizeDiagramModel } from '../../src/core/optimizer.js';
import { analyzeLayout } from '../../src/core/geometry.js';

const SEED_COUNT = Number(process.env.NUDGE_PROPERTY_SEEDS || 40);
const FIRST_SEED = Number(process.env.NUDGE_PROPERTY_FIRST_SEED || 1);
const EPS = 0.5;

/** Port ids are `<elementId>_port_<dir>_<n>`; map one back to its element. */
function elementIdForPort(portId, nodeIds) {
  if (nodeIds.has(portId)) return portId;
  const cut = portId.lastIndexOf('_port_');
  return cut === -1 ? portId : portId.slice(0, cut);
}

function boxesOverlap(a, b) {
  return a.x + EPS < b.x + b.width && a.x + a.width > b.x + EPS &&
         a.y + EPS < b.y + b.height && a.y + a.height > b.y + EPS;
}

function pointOnBoxFace(p, box) {
  const onVertical = Math.abs(p.x - box.x) <= 2 || Math.abs(p.x - (box.x + box.width)) <= 2;
  const onHorizontal = Math.abs(p.y - box.y) <= 2 || Math.abs(p.y - (box.y + box.height)) <= 2;
  const withinY = p.y >= box.y - 2 && p.y <= box.y + box.height + 2;
  const withinX = p.x >= box.x - 2 && p.x <= box.x + box.width + 2;
  return (onVertical && withinY) || (onHorizontal && withinX);
}

/**
 * Every invariant for one rendered diagram.
 *
 * Returns `{ violations, offCanvasLabels }`. The split matters: five of the six
 * invariants hold across every generated diagram tried, so they gate
 * absolutely. The sixth — "every label box is in-canvas" — does not, and it is
 * a genuine finding rather than a bad assertion: it also fires once on the
 * hand-authored corpus (`nested_boundary_characterization`, 22 px overshoot).
 * It is therefore ratcheted at its measured count, exactly like the corpus
 * defect counts, so it cannot get worse while INC-15/INC-16 remain open.
 */
function checkInvariants(model, result) {
  const violations = [];
  let offCanvasLabels = 0;
  const nodes = result.nodes || [];
  const nodeIds = new Set(nodes.map(n => n.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const elements = nodes.filter(n => n.type !== 'boundary');

  // 1. No Element Overlap. The hardest defect class; it is 0 across the whole
  //    hand-authored corpus and must stay 0 on inputs nobody chose.
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      if (boxesOverlap(elements[i], elements[j])) {
        violations.push(`Element Overlap: ${elements[i].id} ∩ ${elements[j].id}`);
      }
    }
  }

  // 2. Every element has a positive, finite box. A NaN or zero-size box is the
  //    signature of a measurement that fell through without being scored.
  for (const node of nodes) {
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(node[key])) violations.push(`${node.id}.${key} is not finite: ${node[key]}`);
    }
    if (node.width <= 0 || node.height <= 0) violations.push(`${node.id} has a non-positive box`);
  }

  // 3. Every declared child renders inside its boundary.
  for (const declared of model.nodes || []) {
    if (declared.type !== 'boundary' || !declared.children?.length) continue;
    const boundary = byId.get(declared.id);
    if (!boundary) continue;
    for (const child of declared.children) {
      const rendered = byId.get(child.id);
      if (!rendered) continue;
      if (
        rendered.x < boundary.x - EPS || rendered.y < boundary.y - EPS ||
        rendered.x + rendered.width > boundary.x + boundary.width + EPS ||
        rendered.y + rendered.height > boundary.y + boundary.height + EPS
      ) {
        violations.push(`${child.id} escapes boundary ${declared.id}`);
      }
    }
  }

  for (const edge of result.edges || []) {
    const section = edge.sections?.[0];
    if (!section) {
      violations.push(`${edge.id} has no routed section`);
      continue;
    }
    const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];

    // 4. Every connection-line segment is axis-aligned. C4 lines are orthogonal
    //    by construction; a diagonal means a route was emitted unrouted.
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
        violations.push(`${edge.id} has a non-finite point`);
        break;
      }
      const horizontal = Math.abs(a.y - b.y) < EPS;
      const vertical = Math.abs(a.x - b.x) < EPS;
      if (!horizontal && !vertical) {
        violations.push(`${edge.id} segment ${i} is diagonal: (${a.x},${a.y})→(${b.x},${b.y})`);
      }
    }

    // 5. Every endpoint sits on the face of the element it connects.
    const sourceEl = byId.get(elementIdForPort(edge.sources?.[0] ?? '', nodeIds));
    const targetEl = byId.get(elementIdForPort(edge.targets?.[0] ?? '', nodeIds));
    if (sourceEl && !pointOnBoxFace(section.startPoint, sourceEl)) {
      violations.push(`${edge.id} start point is not on ${sourceEl.id}'s face`);
    }
    if (targetEl && !pointOnBoxFace(section.endPoint, targetEl)) {
      violations.push(`${edge.id} end point is not on ${targetEl.id}'s face`);
    }

    // 6. Placement is total: every label gets a real, in-canvas box. A label at
    //    an unscored fallthrough position shows up here as NaN or off-canvas.
    for (const label of edge.labels || []) {
      if (!Number.isFinite(label.x) || !Number.isFinite(label.y)) {
        violations.push(`${edge.id} label "${label.text}" has a non-finite position`);
        continue;
      }
      // `label.x`/`label.y` are the box *centre* (see estimateLabelBox in
      // src/core/geometry.js), not its top-left.
      const left = label.x - label.width / 2;
      const top = label.y - label.height / 2;
      if (left < -EPS || top < -EPS ||
          left + label.width > result.width + EPS ||
          top + label.height > result.height + EPS) {
        offCanvasLabels++;
      }
    }
  }

  return { violations, offCanvasLabels };
}

test('layout invariants hold across seeded generated diagrams', { timeout: 600000 }, async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const failures = [];
  let offCanvasTotal = 0;
  let offCanvasSeeds = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(new URL('../../src/render.html', import.meta.url).href);

    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEED_COUNT; seed++) {
      const model = normalizeDiagramModel(generateDiagram(seed));
      const result = await page.evaluate(d => window.renderDiagram(d), model);

      if (!result?.success) {
        failures.push(`seed ${seed}: render failed — ${result?.error}`);
        continue;
      }

      // analyzeLayout must survive every generated layout too: the critic
      // throwing is itself a failure, and it is how the suite would find out.
      assert.doesNotThrow(() => analyzeLayout(result), `seed ${seed}: analyzeLayout threw`);

      const { violations, offCanvasLabels } = checkInvariants(model, result);
      if (violations.length > 0) {
        failures.push(`seed ${seed} (${model.edges.length} relationships):\n    - ${violations.join('\n    - ')}`);
      }
      if (offCanvasLabels > 0) {
        offCanvasSeeds++;
        offCanvasTotal += offCanvasLabels;
      }
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(
    failures, [],
    `${failures.length}/${SEED_COUNT} generated diagrams violated a layout invariant.\n` +
    `Reproduce one with NUDGE_PROPERTY_FIRST_SEED=<seed> NUDGE_PROPERTY_SEEDS=1.\n\n` +
    failures.join('\n\n')
  );

  // Now an absolute invariant, not a ratchet. Placement used to run out of
  // in-canvas positions in a crowded corridor and emit the label anyway,
  // because there was no "unsatisfiable" outcome to report instead — root
  // cause #3. INC-16 gave it one, so a label can no longer leave the canvas.
  //
  // History, which is the point of keeping it: 271 before INC-12 → 269 after the
  // double-charge fix → 286 when `nudgeLabelClear` first gained a horizontal
  // axis (it freed labels from elements straight off the canvas — caught here,
  // not in review) → 246 once the nudge was bounded to the content box → **0**
  // once placement could declare UNSATISFIABLE and degrade deliberately.
  const OFF_CANVAS_BUDGET = { seeds: 0, labels: 0 };
  if (SEED_COUNT === 40 && FIRST_SEED === 1) {
    assert.ok(
      offCanvasSeeds <= OFF_CANVAS_BUDGET.seeds && offCanvasTotal <= OFF_CANVAS_BUDGET.labels,
      `Off-canvas labels regressed: ${offCanvasSeeds} seeds / ${offCanvasTotal} labels ` +
      `(budget ${OFF_CANVAS_BUDGET.seeds} / ${OFF_CANVAS_BUDGET.labels}). ` +
      `If this is an improvement, lower OFF_CANVAS_BUDGET so the ratchet tightens.`
    );
    console.log(
      `  [property] off-canvas labels: ${offCanvasSeeds}/${SEED_COUNT} seeds, ` +
      `${offCanvasTotal} labels (budget ${OFF_CANVAS_BUDGET.seeds}/${OFF_CANVAS_BUDGET.labels}) — INC-16`
    );
  }
});
