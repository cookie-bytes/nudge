import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/renderer/routing/visibility_graph.js';
import '../../src/renderer/routing/grid_connection_line_router.js';

const { routeAllEdges, WEIGHTS } = globalThis.NudgeRenderer.gridConnectionLineRouter;

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 };

function sectionPoints(section) {
  return [section.startPoint, ...(section.bendPoints || []), section.endPoint];
}

function assertOrthogonal(section, label) {
  const points = sectionPoints(section);
  for (let i = 0; i < points.length - 1; i++) {
    const horizontal = Math.abs(points[i].y - points[i + 1].y) < 0.5;
    const vertical = Math.abs(points[i].x - points[i + 1].x) < 0.5;
    assert.ok(horizontal || vertical,
      `${label}: segment ${i} not orthogonal: (${points[i].x},${points[i].y}) -> (${points[i + 1].x},${points[i + 1].y})`);
  }
}

function assertAvoidsObstacles(section, obstacles, edge, label) {
  const points = sectionPoints(section);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (const o of obstacles) {
      if (o.id === edge.from || o.id === edge.to) continue;
      const lox = Math.min(a.x, b.x), hix = Math.max(a.x, b.x);
      const loy = Math.min(a.y, b.y), hiy = Math.max(a.y, b.y);
      const crosses =
        Math.max(lox, o.x) < Math.min(hix, o.x + o.width) - 0.001 &&
        Math.max(loy, o.y) < Math.min(hiy, o.y + o.height) - 0.001;
      assert.ok(!crosses, `${label}: segment ${i} passes through element ${o.id}`);
    }
  }
}

test('vertically aligned elements get a straight bend-free drop', () => {
  const obstacles = [
    { id: 'api', x: 300, y: 100, width: 200, height: 80 },
    { id: 'db', x: 300, y: 300, width: 200, height: 80 }
  ];
  const allEdges = [{ from: 'api', to: 'db', label: 'reads' }];
  const [section] = routeAllEdges({ allEdges, obstacles, bounds: BOUNDS });

  assert.ok(section, 'route found');
  assertOrthogonal(section, 'aligned drop');
  assert.equal(section.bendPoints.length, 0, 'straight drop has no bends');
  assert.ok(Math.abs(section.startPoint.x - 400) < 1, 'exits at source bottom centre');
  assert.ok(Math.abs(section.startPoint.y - 180) < 1, 'exits on source bottom face');
  assert.ok(Math.abs(section.endPoint.y - 300) < 1, 'enters on target top face');
});

test('an element in the way forces an orthogonal detour around it', () => {
  const obstacles = [
    { id: 'a', x: 300, y: 60, width: 200, height: 80 },
    { id: 'blocker', x: 300, y: 250, width: 200, height: 100 },
    { id: 'b', x: 300, y: 460, width: 200, height: 80 }
  ];
  const allEdges = [{ from: 'a', to: 'b', label: 'calls' }];
  const [section] = routeAllEdges({ allEdges, obstacles, bounds: BOUNDS });

  assert.ok(section, 'route found');
  assertOrthogonal(section, 'detour');
  assertAvoidsObstacles(section, obstacles, allEdges[0], 'detour');
  assert.ok(section.bendPoints.length >= 2, 'detour requires bends');
});

test('parallel relationships between the same pair spread across port slots', () => {
  const obstacles = [
    { id: 'svc', x: 100, y: 100, width: 200, height: 80 },
    { id: 'bus', x: 500, y: 100, width: 200, height: 80 }
  ];
  const allEdges = [
    { from: 'svc', to: 'bus', label: 'publish' },
    { from: 'svc', to: 'bus', label: 'subscribe' }
  ];
  // canBundleEdges=false so occupancy must separate them
  const sections = routeAllEdges({
    allEdges, obstacles, bounds: BOUNDS, canBundleEdges: () => false
  });

  assert.ok(sections[0] && sections[1], 'both routed');
  const samePort =
    Math.abs(sections[0].startPoint.x - sections[1].startPoint.x) < 1 &&
    Math.abs(sections[0].startPoint.y - sections[1].startPoint.y) < 1 &&
    Math.abs(sections[0].endPoint.x - sections[1].endPoint.x) < 1 &&
    Math.abs(sections[0].endPoint.y - sections[1].endPoint.y) < 1;
  assert.ok(!samePort, 'port occupancy separates parallel lines');
});

test('internal lines stay inside the boundary when a clean inside route exists', () => {
  const boundaryRect = { x: 50, y: 50, width: 700, height: 500 };
  const obstacles = [
    { id: 'a', x: 100, y: 100, width: 150, height: 80 },
    { id: 'b', x: 500, y: 380, width: 150, height: 80 }
  ];
  const allEdges = [{ from: 'a', to: 'b', label: 'uses' }];
  const sections = routeAllEdges({
    allEdges, obstacles, bounds: BOUNDS, boundaryRect,
    childIds: new Set(['a', 'b'])
  });

  const points = sectionPoints(sections[0]);
  for (const p of points) {
    assert.ok(
      p.x >= boundaryRect.x - 0.5 && p.x <= boundaryRect.x + boundaryRect.width + 0.5 &&
      p.y >= boundaryRect.y - 0.5 && p.y <= boundaryRect.y + boundaryRect.height + 0.5,
      `point (${p.x},${p.y}) escaped the boundary`
    );
  }
});

test('edges with unroutable endpoints return null instead of throwing', () => {
  const obstacles = [{ id: 'only', x: 100, y: 100, width: 100, height: 80 }];
  const allEdges = [
    { from: 'only', to: 'ghost', label: 'broken' },
    { from: 'only', to: 'only', label: 'self' }
  ];
  const sections = routeAllEdges({ allEdges, obstacles, bounds: BOUNDS });
  assert.equal(sections[0], null);
  assert.equal(sections[1], null);
});

test('nudging separates lines forced through a shared channel', () => {
  // Two walls leave a single horizontal corridor (y 330..420). Both lines
  // must pass through it; nudging must put them on separated lanes.
  const obstacles = [
    { id: 'src1', x: 50, y: 250, width: 100, height: 80 },
    { id: 'src2', x: 50, y: 450, width: 100, height: 80 },
    { id: 'tgt1', x: 650, y: 250, width: 100, height: 80 },
    { id: 'tgt2', x: 650, y: 450, width: 100, height: 80 },
    { id: 'wallTop', x: 300, y: 0, width: 200, height: 330 },
    { id: 'wallBot', x: 300, y: 420, width: 200, height: 180 }
  ];
  const allEdges = [
    { from: 'src1', to: 'tgt1', label: 'a' },
    { from: 'src2', to: 'tgt2', label: 'b' }
  ];
  const sections = routeAllEdges({
    allEdges, obstacles, bounds: BOUNDS, canBundleEdges: () => false
  });

  assert.ok(sections[0] && sections[1], 'both routed');
  for (const [i, section] of sections.entries()) {
    assertOrthogonal(section, `corridor line ${i}`);
    assertAvoidsObstacles(section, obstacles, allEdges[i], `corridor line ${i}`);
  }

  // Horizontal segments inside the corridor span (x 300..500).
  const corridorLanes = sections.map(section => {
    const points = sectionPoints(section);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (Math.abs(a.y - b.y) > 0.5) continue;
      if (Math.min(a.x, b.x) <= 310 && Math.max(a.x, b.x) >= 490) return a.y;
    }
    return null;
  });
  assert.ok(corridorLanes[0] !== null && corridorLanes[1] !== null, 'both lines traverse the corridor');
  assert.ok(
    Math.abs(corridorLanes[0] - corridorLanes[1]) >= 10,
    `corridor lanes not separated: ${corridorLanes[0]} vs ${corridorLanes[1]}`
  );
});

test('slightly misaligned stacked elements get a straight line, not a Z-jog', () => {
  // Centres are 10px apart: discrete port slots cannot align, so without the
  // kink-straightening pass the route is drop -> 10px jog -> drop. The dock
  // must slide along the face to give a single straight segment.
  const obstacles = [
    { id: 'a', x: 300, y: 100, width: 200, height: 80 },
    { id: 'b', x: 310, y: 300, width: 200, height: 80 }
  ];
  const allEdges = [{ from: 'a', to: 'b', label: 'calls' }];
  const [section] = routeAllEdges({ allEdges, obstacles, bounds: BOUNDS });

  assert.ok(section, 'route found');
  assertOrthogonal(section, 'misaligned drop');
  const points = sectionPoints(section);
  for (let i = 0; i < points.length - 1; i++) {
    const len = Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
    assert.ok(len >= 24, `kink segment remains: ${len}px at (${points[i].x},${points[i].y})`);
  }
  assert.equal(section.bendPoints.length, 0, 'straightened to a single drop');
});

test('weights profile exposes the documented cost knobs', () => {
  for (const key of ['length', 'bend', 'cross', 'overlapFlat', 'overlapPx', 'portOccupied', 'boundaryCross']) {
    assert.ok(Number.isFinite(WEIGHTS[key]), `missing weight: ${key}`);
  }
});
