// The quality ratchet: one checked-in defect vector per fixture.
//
// A *gate* asks "did it pass?". Over a corpus that legitimately carries known
// defects a gate is either permanently red or permanently switched off, and
// neither state catches a regression. A *ratchet* asks "did anything get
// worse?" — so a change that fixes one diagram and breaks another cannot merge
// silently, which is the defect-conservation failure mode described in
// docs/IMPROVEMENT_PLAN.md §1.
//
// This module owns the vector's shape, so `scripts/capture_quality_baseline.js`
// and `test/run_tests.js` can never drift apart in what they measure.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES_DIR = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'diagrams');
export const BASELINE_PATH = path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'baselines', 'quality_baseline.json');

// Every count in this list must not increase. Ordered by the severity ordering
// declared in docs/IMPROVEMENT_PLAN.md §Phase 4, hardest failure first.
export const RATCHET_METRICS = [
  'elementOverlaps',
  'connectionLineElementCrossings',
  'connectionLabelElementCrossings',
  'labelOffCanvas',
  'connectionLineOverlaps',
  'connectionLineCrossings',
  'labelLineIntersections',
  'labelLabelOverlaps',
  'boundaryViolations',
  'orthogonalViolations',
];

// Shape/cost metrics. Tracked so route churn is visible in the diff, but they
// are not pass/fail: a fix that removes a crossing often costs a bend.
export const ADVISORY_METRICS = [
  'connectionLineOverlapPx',
  'totalBends',
  'totalRouteLength',
];

export function countBoundaryViolations(model, result) {
  let violations = 0;
  const nodeMap = new Map((result.nodes || []).map(n => [n.id, n]));
  for (const node of model.nodes || []) {
    if (node.type !== 'boundary' || !node.children?.length) continue;
    const boundary = nodeMap.get(node.id);
    if (!boundary) continue;
    for (const child of node.children) {
      const cn = nodeMap.get(child.id);
      if (!cn) continue;
      if (
        cn.x < boundary.x || cn.y < boundary.y ||
        cn.x + cn.width > boundary.x + boundary.width ||
        cn.y + cn.height > boundary.y + boundary.height
      ) violations++;
    }
  }
  return violations;
}

export function countOrthogonalViolations(result) {
  let violations = 0;
  for (const edge of result.edges || []) {
    const section = edge.sections?.[0];
    if (!section) continue;
    const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
    for (let i = 0; i < points.length - 1; i++) {
      const horizontal = Math.abs(points[i].y - points[i + 1].y) < 0.5;
      const vertical = Math.abs(points[i].x - points[i + 1].x) < 0.5;
      if (!horizontal && !vertical) violations++;
    }
  }
  return violations;
}

/** The full defect vector for one rendered fixture: all six classes plus shape. */
export function qualityVector(model, result, report) {
  const edge = report.edgeQuality || {};
  return {
    elementOverlaps: report.overlapCount,
    connectionLineElementCrossings: report.intersectionCount,
    connectionLabelElementCrossings: report.labelElementCrossingCount || 0,
    labelOffCanvas: report.labelOffCanvasCount || 0,
    connectionLineOverlaps: edge.edgeOverlapCount || 0,
    connectionLineCrossings: edge.edgeCrossingCount || 0,
    labelLineIntersections: edge.labelEdgeIntersectionCount || 0,
    labelLabelOverlaps: report.labelLabelOverlapCount || 0,
    boundaryViolations: countBoundaryViolations(model, result),
    orthogonalViolations: countOrthogonalViolations(result),
    connectionLineOverlapPx: edge.edgeOverlapPx || 0,
    totalBends: edge.totalBends || 0,
    totalRouteLength: edge.totalRouteLength || 0,
    aspectRatio: report.aspectRatio,
    width: Math.round(result.width),
    height: Math.round(result.height),
  };
}

/** Every fixture under test/fixtures/diagrams, as `<folder>/<file>` keys. */
export function findFixtures() {
  const fixtures = [];
  for (const folder of fs.readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(FIXTURES_DIR, folder.name);
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith('.mermaid') && !entry.endsWith('.puml')) continue;
      fixtures.push({ key: `${folder.name}/${entry}`, fullPath: path.join(dir, entry) });
    }
  }
  return fixtures.sort((a, b) => a.key.localeCompare(b.key));
}

export function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

/**
 * Compare one fixture's measured vector against its baseline entry.
 * Returns `{ regressions, improvements, isNew }`. A regression is any ratcheted
 * count that went up; it fails the run. An improvement is any that went down;
 * it passes, but must be re-baselined so the ratchet tightens.
 */
export function compareToBaseline(key, vector, baseline) {
  const entry = baseline?.fixtures?.[key];
  if (!entry) return { regressions: [], improvements: [], isNew: true };

  const regressions = [];
  const improvements = [];
  for (const metric of RATCHET_METRICS) {
    const was = entry[metric] ?? 0;
    const now = vector[metric] ?? 0;
    if (now > was) regressions.push({ metric, was, now });
    else if (now < was) improvements.push({ metric, was, now });
  }
  return { regressions, improvements, isNew: false };
}
