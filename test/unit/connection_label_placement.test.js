// Direct unit tests for the Connection Label placer.
//
// This 1,000-line module with three separate cost models was previously
// reachable only through a full Playwright render, so the only way to ask "why
// did it choose that position?" was to look at a PNG. INC-9 removed the canvas
// from text measurement, which made the module pure and testable here in
// milliseconds (docs/IMPROVEMENT_PLAN.md INC-10).
//
// The severity-inversion and double-charge tests below were originally written
// to pin the *wrong* behaviour, so that INC-12 landing would visibly flip them.
// It has, and they now assert the corrected ordering: burying a label inside an
// element costs strictly more than grazing another label. The last group covers
// the UNSATISFIABLE outcome added by INC-16.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/renderer/labels/connection_label_placement.js';

const P = globalThis.NudgeRenderer.connectionLabelPlacement;

const H_PAD = 4;
const V_PAD = 3;

const box = (x, y, width, height, extra = {}) => ({ x, y, width, height, ...extra });

test('labelBoxAt centres the box on the point and applies padding on both axes', () => {
  const result = P.labelBoxAt(100, 50, 60, 20, H_PAD, V_PAD);
  assert.deepEqual(result, {
    x: 100 - 30 - H_PAD,
    y: 50 - 10 - V_PAD,
    width: 60 + 2 * H_PAD,
    height: 20 + 2 * V_PAD,
  });
});

test('boxesOverlap treats edge-to-edge contact as clear, not overlapping', () => {
  assert.equal(P.boxesOverlap(box(0, 0, 10, 10), box(10, 0, 10, 10)), false);
  assert.equal(P.boxesOverlap(box(0, 0, 10, 10), box(9.5, 0, 10, 10)), true);
});

test('boxToPolylineDistance is zero when the line passes through the box', () => {
  const line = [{ x: 0, y: 50 }, { x: 200, y: 50 }];
  assert.equal(P.boxToPolylineDistance(box(80, 40, 40, 20), line), 0);
});

test('boxToPolylineDistance measures box-edge to line, not centre to line', () => {
  // A wide label sitting correctly beside a horizontal segment: its centre is
  // far from the line, but its edge is close. Measuring from the centre would
  // penalise a good placement and push labels back onto their own lines.
  const line = [{ x: 0, y: 0 }, { x: 400, y: 0 }];
  const wide = box(0, 20, 400, 10);
  assert.ok(P.boxToPolylineDistance(wide, line) <= 20 + 1e-6);
});

test('labelEdgeHitCount ignores the label\'s own connection line', () => {
  const labelBox = P.labelBoxAt(100, 100, 40, 12, H_PAD, V_PAD);
  const throughOwn = [{ id: 'edge1', points: [{ x: 0, y: 100 }, { x: 200, y: 100 }] }];
  assert.equal(P.labelEdgeHitCount(labelBox, throughOwn, 'edge1'), 0);
  assert.equal(P.labelEdgeHitCount(labelBox, throughOwn, 'edge2'), 1);
});

test('labelEdgeHitCount counts each crossing connection line once', () => {
  const labelBox = P.labelBoxAt(100, 100, 40, 12, H_PAD, V_PAD);
  const lines = [
    { id: 'a', points: [{ x: 0, y: 100 }, { x: 200, y: 100 }] },
    { id: 'b', points: [{ x: 100, y: 0 }, { x: 100, y: 200 }] },
    { id: 'c', points: [{ x: 0, y: 900 }, { x: 200, y: 900 }] },
  ];
  assert.equal(P.labelEdgeHitCount(labelBox, lines, 'self'), 2);
});

test('checkLabelCollision detects a label buried in an element', () => {
  const element = box(50, 50, 120, 80);
  assert.equal(P.checkLabelCollision(110, 90, 60, 20, [element], H_PAD, V_PAD), true);
  assert.equal(P.checkLabelCollision(400, 400, 60, 20, [element], H_PAD, V_PAD), false);
});

test('createElementObstacles excludes placed labels; createLabelObstacles includes them', () => {
  const components = [box(0, 0, 10, 10)];
  const borders = [box(20, 0, 10, 10, { _borderStrip: true })];
  const placed = [box(40, 0, 10, 10)];

  assert.equal(P.createElementObstacles(components, borders).length, 2);
  assert.equal(P.createLabelObstacles(components, borders, placed).length, 3);
});

// --- The severity inversion (INC-12) --------------------------------------

function scoreAt(cx, cy, { obstacles, placedLabels, allComponents }) {
  return P.scoreCandidate({
    cx, cy,
    segLen: 0,
    textWidth: 60,
    textHeight: 20,
    obstacles,
    placedLabels,
    allComponents,
    preferSourceSideLabel: false,
    pStart: { x: 0, y: 0 },
    pointToBoxDist: () => 200,
    labelBoxAt: (x, y, w, h) => P.labelBoxAt(x, y, w, h, H_PAD, V_PAD),
    checkLabelCollision: (x, y, w, h, list) => P.checkLabelCollision(x, y, w, h, list, H_PAD, V_PAD),
    labelEdgeHitCount: () => 0,
    sharedTargetLabelPressure: () => 0,
    boxesOverlap: P.boxesOverlap,
  });
}

test('a placed label is charged once, as a label hit, not also as an obstacle collision', () => {
  const otherLabel = box(200, 200, 60, 20);
  const element = box(500, 500, 120, 80);
  // The production caller (connection_label_rendering.js) passes element-only
  // obstacles here. It used to pass `createLabelObstacles(...)`, which already
  // contains every placed label, so `scoreCandidate` counted the same labels
  // again via `placedLabels` — one defect, charged twice (INC-12 / Option A).
  const obstacles = P.createElementObstacles([element], []);

  const onLabel = scoreAt(230, 210, { obstacles, placedLabels: [otherLabel], allComponents: [element] });

  assert.equal(onLabel.nodeCollision, 0, 'a placed label is not an element collision');
  assert.equal(onLabel.labelHits, 1, 'it is charged exactly once, as a label hit');
});

test('burying a label inside an element costs more than grazing another label', () => {
  const element = box(500, 500, 120, 80);
  const otherLabel = box(200, 200, 60, 20);
  const obstacles = P.createElementObstacles([element], []);
  const context = { obstacles, placedLabels: [otherLabel], allComponents: [element] };

  const buriedInElement = scoreAt(560, 540, context);
  const grazingLabel = scoreAt(230, 210, context);

  // Lower score wins. Burying a label inside an architecture element is the
  // more severe defect — it is the class the container gate fails on — so it
  // must cost strictly more, per the severity ordering in the plan's Phase 4
  // preamble. Before the double-charge fix this comparison ran backwards.
  assert.ok(
    buriedInElement.score > grazingLabel.score,
    `expected burial (${buriedInElement.score}) to cost more than grazing (${grazingLabel.score})`
  );
  assert.equal(buriedInElement.nodeCollision, 1);
});

test('a clear position beats both burial and grazing', () => {
  const element = box(500, 500, 120, 80);
  const otherLabel = box(200, 200, 60, 20);
  const obstacles = P.createElementObstacles([element], []);
  const context = { obstacles, placedLabels: [otherLabel], allComponents: [element] };

  const clear = scoreAt(50, 800, context);
  assert.equal(clear.nodeCollision, 0);
  assert.equal(clear.labelHits, 0);
  assert.ok(clear.score < scoreAt(560, 540, context).score);
  assert.ok(clear.score < scoreAt(230, 210, context).score);
});

// --- The rescue stage that structurally cannot rescue (INC-12) -------------

// `nudgeLabelClear` keeps its candidates inside the union box of the obstacle
// set, which stands in for the diagram's content extent. These corner markers
// give the fixtures a realistic canvas — a diagram always has more than one
// element — without sitting anywhere near the label under test. Without them
// the content box collapses onto the single blocker and every escape is
// correctly judged out of bounds.
const CANVAS_CORNERS = [box(0, 0, 8, 8), box(992, 992, 8, 8)];

function nudge({ midX, midY, blockers = [], placedLabels = [] }) {
  return P.nudgeLabelClear({
    midX,
    midY,
    textWidth: 60,
    textHeight: 20,
    H_PAD,
    V_PAD,
    placedLabels,
    obstacleNodes: [...CANVAS_CORNERS, ...blockers],
    boxesOverlap: P.boxesOverlap,
    checkLabelCollision: (x, y, w, h, list) => P.checkLabelCollision(x, y, w, h, list, H_PAD, V_PAD),
  });
}

test('nudgeLabelClear leaves an already-clear label exactly where it is', () => {
  const result = nudge({ midX: 200, midY: 100, blockers: [box(600, 600, 50, 50)] });
  assert.deepEqual(result, { x: 200, y: 100 });
});

test('nudgeLabelClear escapes vertically when the blocker is a wide band', () => {
  // A wide, short obstacle: moving sideways cannot escape it, moving up or down can.
  const result = nudge({ midX: 200, midY: 100, blockers: [box(0, 80, 1000, 40)] });
  assert.equal(result.x, 200, 'no need to move horizontally');
  assert.notEqual(result.y, 100, 'must move vertically');
  assert.ok(!P.checkLabelCollision(result.x, result.y, 60, 20, [box(0, 80, 1000, 40)], H_PAD, V_PAD));
});

test('nudgeLabelClear escapes horizontally when the blocker is a tall column', () => {
  // The case the old vertical-only stage structurally could not solve: a tall,
  // narrow obstacle. Every vertical candidate stays inside it; only sideways
  // clears. Labels are wider than they are tall, so this is the common shape.
  const blocker = box(150, 0, 120, 1000);
  const result = nudge({ midX: 200, midY: 100, blockers: [blocker] });

  assert.notEqual(result.x, 200, 'must move horizontally to escape a tall blocker');
  assert.equal(result.y, 100, 'no vertical move was needed');
  assert.ok(
    !P.checkLabelCollision(result.x, result.y, 60, 20, [blocker], H_PAD, V_PAD),
    'the nudged position must actually be clear'
  );
});

test('nudgeLabelClear takes the smallest displacement that clears', () => {
  const blocker = box(150, 0, 120, 1000);
  const origin = { x: 200, y: 100 };
  const result = nudge({ midX: origin.x, midY: origin.y, blockers: [blocker] });

  const clear = (x, y) => !P.checkLabelCollision(x, y, 60, 20, [blocker], H_PAD, V_PAD);
  assert.ok(clear(result.x, result.y), 'the chosen position must be clear');

  // No candidate strictly nearer than the chosen one was clear. Asserted over
  // the candidate lattice rather than a hardcoded step count, so the test does
  // not silently encode this fixture's arithmetic.
  const chosenDist = Math.abs(result.x - origin.x) + Math.abs(result.y - origin.y);
  const labelW = 60 + 2 * H_PAD;
  const labelH = 20 + 2 * V_PAD;
  for (let n = 1; n <= 3; n++) {
    for (const sign of [-1, 1]) {
      for (const [x, y] of [
        [origin.x, origin.y + sign * n * (labelH + 4)],
        [origin.x + sign * n * (labelW + 4), origin.y],
      ]) {
        const dist = Math.abs(x - origin.x) + Math.abs(y - origin.y);
        if (dist < chosenDist) {
          assert.ok(!clear(x, y), `a nearer candidate (${x},${y}) was clear but not chosen`);
        }
      }
    }
  }
});

test('nudgeLabelClear moves off a previously placed label', () => {
  const placed = [box(170, 87, 68, 26)];
  const result = nudge({ midX: 200, midY: 100, placedLabels: placed });
  assert.ok(
    result.x !== 200 || result.y !== 100,
    'a label sitting on another label must move'
  );
  const boxAt = P.labelBoxAt(result.x, result.y, 60, 20, H_PAD, V_PAD);
  assert.ok(!P.boxesOverlap(boxAt, placed[0]), 'and must end up clear of it');
});

test('nudgeLabelClear returns the original position when nothing clears', () => {
  // Fully enclosed: no candidate escapes. The stage must still return a usable
  // coordinate rather than undefined — a NaN here poisons every downstream box.
  const result = nudge({ midX: 200, midY: 100, blockers: [box(-5000, -5000, 10000, 10000)] });
  assert.deepEqual(result, { x: 200, y: 100 });
});

test('placement helpers are deterministic for identical input', () => {
  const element = box(500, 500, 120, 80);
  const obstacles = P.createElementObstacles([element], []);
  const context = { obstacles, placedLabels: [], allComponents: [element] };
  const first = scoreAt(120, 340, context);
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(scoreAt(120, 340, context), first);
  }
});

// --- The UNSATISFIABLE outcome (INC-16) ------------------------------------

const BOUNDS = { left: 0, top: 0, right: 1000, bottom: 1000 };

function failureOf({ midX, midY, elements = [], placedLabels = [], bounds = BOUNDS }) {
  return P.placementFailure({
    midX, midY,
    textWidth: 60,
    textHeight: 20,
    H_PAD, V_PAD,
    elementObstacles: elements,
    placedLabels,
    bounds,
    boxesOverlap: P.boxesOverlap,
  });
}

test('contentBounds is the union box of the obstacle set', () => {
  const bounds = P.contentBounds([box(100, 200, 50, 50), box(400, 40, 30, 30)]);
  assert.deepEqual(bounds, { left: 100, top: 40, right: 430, bottom: 250 });
});

test('contentBounds is null when there is nothing to bound', () => {
  assert.equal(P.contentBounds([]), null);
});

test('placementFailure reports a clear placement as satisfiable', () => {
  assert.equal(failureOf({ midX: 500, midY: 500 }), null);
});

test('placementFailure names the three unsatisfiable outcomes', () => {
  assert.equal(failureOf({ midX: 5, midY: 500 }), 'off-canvas');
  assert.match(failureOf({ midX: 500, midY: 500, elements: [box(450, 450, 100, 100, { id: 'api' })] }), /buried in 'api'/);
  assert.equal(failureOf({ midX: 500, midY: 500, placedLabels: [box(470, 490, 60, 20)] }), 'overlaps another label');
});

test('placementFailure ignores boundary border strips', () => {
  // Border strips sit behind labels and are not opaque, so clipping one is
  // cosmetic. Counting them would declare almost every boundary diagram
  // unsatisfiable.
  const strip = box(450, 450, 100, 100, { id: 'boundary', _borderStrip: true });
  assert.equal(failureOf({ midX: 500, midY: 500, elements: [strip] }), null);
});

test('placementFailure treats absent bounds as unbounded rather than failing', () => {
  assert.equal(failureOf({ midX: -9999, midY: -9999, bounds: null }), null);
});

test('clampToBounds pulls an off-canvas box back inside', () => {
  const clamped = P.clampToBounds({
    midX: -500, midY: 5000, textWidth: 60, textHeight: 20, H_PAD, V_PAD, bounds: BOUNDS,
  });
  assert.equal(failureOf({ midX: clamped.x, midY: clamped.y }), null);
});

test('clampToBounds centres a label too large for the canvas instead of clipping one end', () => {
  const tiny = { left: 0, top: 0, right: 40, bottom: 40 };
  const clamped = P.clampToBounds({
    midX: 0, midY: 0, textWidth: 200, textHeight: 100, H_PAD, V_PAD, bounds: tiny,
  });
  assert.equal(clamped.x, 20);
  assert.equal(clamped.y, 20);
});

test('clampToBounds leaves an already-in-bounds box untouched', () => {
  const clamped = P.clampToBounds({
    midX: 500, midY: 500, textWidth: 60, textHeight: 20, H_PAD, V_PAD, bounds: BOUNDS,
  });
  assert.deepEqual(clamped, { x: 500, y: 500 });
});
