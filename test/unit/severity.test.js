// The declared severity ordering is the thing that stops a local fix from being
// a defect-conservation operation (docs/IMPROVEMENT_PLAN.md INC-13, root cause
// #1). These tests pin the ordering itself, so changing a weight is a
// deliberate, visible act rather than a side effect of tuning one diagram.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEVERITY, scoreLayout, countDefects, isClean } from '../../src/core/severity.js';

const report = (overrides = {}) => ({
  overlapCount: 0,
  intersectionCount: 0,
  labelElementCrossingCount: 0,
  labelLabelOverlapCount: 0,
  noteOverlapCount: 0,
  noteEdgeCrossingCount: 0,
  edgeQuality: {
    edgeCrossingCount: 0,
    edgeOverlapCount: 0,
    edgeOverlapPx: 0,
    labelEdgeIntersectionCount: 0,
    totalBends: 0,
    totalRouteLength: 0,
    ...(overrides.edgeQuality || {}),
  },
  ...overrides,
});

test('the severity ordering runs hardest failure first', () => {
  // Element Overlap ≥ Line-Element Crossing > Label-Element Crossing >
  // Label-Label Overlap > Line Overlap ≥ Line Crossing > Label-Line Intersection.
  assert.ok(SEVERITY.elementOverlap >= SEVERITY.lineElementCrossing);
  assert.ok(SEVERITY.lineElementCrossing > SEVERITY.labelElementCrossing);
  assert.ok(SEVERITY.labelElementCrossing > SEVERITY.labelLabelOverlap);
  assert.ok(SEVERITY.labelLabelOverlap > SEVERITY.lineOverlap);
  assert.ok(SEVERITY.lineOverlap >= SEVERITY.lineCrossing);
  assert.ok(SEVERITY.lineCrossing > SEVERITY.labelLineIntersection);
});

test('one information-destroying defect outranks any number of readability ones', () => {
  // The cut between classes 1–3 and 4–6. A layout that buries a label must
  // never be preferred over one with a lot of line crossings, or the optimizer
  // will happily trade the severe defect away for cosmetics.
  const buriedLabel = scoreLayout(report({ labelElementCrossingCount: 1 }));
  const manyCrossings = scoreLayout(report({
    edgeQuality: { edgeCrossingCount: 20, edgeOverlapCount: 20, labelEdgeIntersectionCount: 20 },
  }));
  assert.ok(buriedLabel > manyCrossings, `${buriedLabel} should outrank ${manyCrossings}`);
});

test('shape cost never outranks a defect', () => {
  // Bends and route length are tiebreakers. A very long, very bendy route must
  // still beat a short one that crosses an element.
  const sprawling = scoreLayout(report({
    edgeQuality: { totalBends: 200, totalRouteLength: 100000 },
  }));
  const oneCrossing = scoreLayout(report({ intersectionCount: 1 }));
  assert.ok(oneCrossing > sprawling, `${oneCrossing} should outrank ${sprawling}`);
});

test('a clean layout scores zero', () => {
  assert.equal(scoreLayout(report()), 0);
  assert.equal(countDefects(report()), 0);
  assert.equal(isClean(report()), true);
});

test('countDefects sums all seven classes and ignores shape', () => {
  const r = report({
    overlapCount: 1,
    intersectionCount: 2,
    labelElementCrossingCount: 3,
    labelLabelOverlapCount: 4,
    edgeQuality: {
      edgeOverlapCount: 5, edgeCrossingCount: 6, labelEdgeIntersectionCount: 7,
      totalBends: 999, totalRouteLength: 99999,
    },
  });
  assert.equal(countDefects(r), 1 + 2 + 3 + 4 + 5 + 6 + 7);
});

test('isClean covers exactly the information-destroying classes', () => {
  assert.equal(isClean(report({ overlapCount: 1 })), false);
  assert.equal(isClean(report({ intersectionCount: 1 })), false);
  assert.equal(isClean(report({ labelElementCrossingCount: 1 })), false);

  // Classes 4–6 are held by the ratchet, not by the absolute gate — see INC-8.
  assert.equal(isClean(report({ labelLabelOverlapCount: 1 })), true);
  assert.equal(isClean(report({ edgeQuality: { edgeCrossingCount: 9 } })), true);
});

test('scoreLayout is monotonic — adding a defect never lowers the score', () => {
  const base = report({ intersectionCount: 1, edgeQuality: { edgeCrossingCount: 2 } });
  const baseScore = scoreLayout(base);
  for (const worse of [
    { ...base, overlapCount: 1 },
    { ...base, labelElementCrossingCount: 1 },
    { ...base, labelLabelOverlapCount: 1 },
    { ...base, edgeQuality: { ...base.edgeQuality, edgeOverlapCount: 1 } },
  ]) {
    assert.ok(scoreLayout(worse) > baseScore);
  }
});
