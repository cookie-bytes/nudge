// The single declared severity ordering over the six defect classes, and the one
// scoring function derived from it.
//
// Why this file exists (docs/IMPROVEMENT_PLAN.md INC-13, root cause #1): Nudge
// had *nine* independently tuned cost models over the same geometry, with no
// shared ordering. Two of them ranked the same pair of defect classes in
// opposite directions. The consequence is not "inconsistent weights" — it is
// that a local fix conserves total defect count instead of reducing it: fix one
// diagram, break another. `c34100d` fixed the burial-vs-overlap inversion in one
// model and left it live in two others, which is the predictable result of a fix
// having no canonical home.
//
// The ordering, hardest failure first:
//
//   1. Element Overlap                    — two elements occupy the same pixels
//   2. Connection-Line Element Crossing    — a line cuts through an element
//   3. Connection-Label Element Crossing   — a label is buried in an element
//   4. Connection-Line Overlap             — two lines run along each other
//   5. Connection-Line Crossing            — two lines cross
//   6. Label-Line Intersection             — a line runs through a label
//
// Rationale for the cut between 3 and 4: classes 1–3 destroy information (an
// element or a label becomes unreadable). Classes 4–6 degrade readability but
// every element and label remains legible. That is also where the absolute gate
// sits — see INC-8.
//
// Label-Label Overlap is a seventh class discovered while wiring the counters.
// It ranks with 3: two labels sharing pixels is as unreadable as one buried in
// a box.

/** Weights derived from the ordering. Each tier is decisively above the next. */
export const SEVERITY = {
  elementOverlap: 100000,
  lineElementCrossing: 100000,
  labelElementCrossing: 50000,
  // A clipped or invisible label destroys information as surely as a buried
  // one, so it ranks alongside it.
  labelOffCanvas: 50000,
  labelLabelOverlap: 20000,
  // Note occlusion is not one of the six classes — notes are annotations, not
  // layout participants — but it is scored here so the note auto-placement loop
  // shares the ordering rather than inventing its own.
  noteOverlap: 40000,
  noteLineCrossing: 8000,
  lineOverlap: 500,
  lineCrossing: 500,
  labelLineIntersection: 250,
};

/** Shape/cost terms. Tiebreakers only — never allowed to outrank a defect. */
export const SHAPE_COST = {
  lineOverlapPx: 2,
  bend: 4,
  routeLengthPx: 0.02,
};

/**
 * The one layout cost function. Lower is better.
 *
 * Every Node-side scorer calls this: the container label-hint accept/reject
 * loop, the canned-configuration search, and the test grader. Changing a weight
 * here changes all of them together, which is the entire point.
 *
 * @param {object} report  an `analyzeLayout` report
 * @returns {number}
 */
export function scoreLayout(report) {
  const edge = report.edgeQuality || {};
  return (
    (report.overlapCount || 0) * SEVERITY.elementOverlap +
    (report.intersectionCount || 0) * SEVERITY.lineElementCrossing +
    (report.labelElementCrossingCount || 0) * SEVERITY.labelElementCrossing +
    (report.labelOffCanvasCount || 0) * SEVERITY.labelOffCanvas +
    (report.labelLabelOverlapCount || 0) * SEVERITY.labelLabelOverlap +
    (report.noteOverlapCount || 0) * SEVERITY.noteOverlap +
    (report.noteEdgeCrossingCount || 0) * SEVERITY.noteLineCrossing +
    (edge.edgeOverlapCount || 0) * SEVERITY.lineOverlap +
    (edge.edgeCrossingCount || 0) * SEVERITY.lineCrossing +
    (edge.labelEdgeIntersectionCount || 0) * SEVERITY.labelLineIntersection +
    (edge.edgeOverlapPx || 0) * SHAPE_COST.lineOverlapPx +
    (edge.totalBends || 0) * SHAPE_COST.bend +
    (edge.totalRouteLength || 0) * SHAPE_COST.routeLengthPx
  );
}

/**
 * Total defect count, ignoring shape. Used where a count is wanted rather than
 * a cost — reporting, and the ratchet's "did anything get worse" question.
 */
export function countDefects(report) {
  const edge = report.edgeQuality || {};
  return (
    (report.overlapCount || 0) +
    (report.intersectionCount || 0) +
    (report.labelElementCrossingCount || 0) +
    (report.labelOffCanvasCount || 0) +
    (report.labelLabelOverlapCount || 0) +
    (edge.edgeOverlapCount || 0) +
    (edge.edgeCrossingCount || 0) +
    (edge.labelEdgeIntersectionCount || 0)
  );
}

/**
 * The defect classes that must be zero for a layout to be called successful.
 * Classes 1–3: the ones that destroy information. See INC-8 for why 4–6 are
 * held by the ratchet instead of by an absolute gate.
 */
export function isClean(report) {
  return (report.overlapCount || 0) === 0 &&
         (report.intersectionCount || 0) === 0 &&
         (report.labelElementCrossingCount || 0) === 0;
}
