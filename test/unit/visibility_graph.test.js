import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/renderer/routing/visibility_graph.js';

const { buildVisibilityGraph } = globalThis.NudgeRenderer.visibilityGraph;

const BOUNDS = { x: 0, y: 0, width: 600, height: 400 };
const CLEARANCE = 16;

function singleObstacleGraph(overrides = {}) {
  return buildVisibilityGraph({
    bounds: BOUNDS,
    obstacles: [{ id: 'api', x: 250, y: 150, width: 100, height: 80 }],
    clearance: CLEARANCE,
    ...overrides
  });
}

function inflatedInterior(obstacle, clearance) {
  return {
    left: obstacle.x - clearance,
    top: obstacle.y - clearance,
    right: obstacle.x + obstacle.width + clearance,
    bottom: obstacle.y + obstacle.height + clearance
  };
}

test('grid lines include bounds edges, clearance faces, and element centre lines', () => {
  const graph = singleObstacleGraph();

  const hasX = (x) => graph.xCoords.some(c => Math.abs(c - x) <= 0.5);
  const hasY = (y) => graph.yCoords.some(c => Math.abs(c - y) <= 0.5);

  assert.ok(hasX(0) && hasX(600), 'bounds x edges present');
  assert.ok(hasY(0) && hasY(400), 'bounds y edges present');
  assert.ok(hasX(250 - CLEARANCE) && hasX(350 + CLEARANCE), 'inflated obstacle x faces present');
  assert.ok(hasY(150 - CLEARANCE) && hasY(230 + CLEARANCE), 'inflated obstacle y faces present');
  assert.ok(hasX(300), 'element centre x line present (straight drops possible)');
  assert.ok(hasY(190), 'element centre y line present');
});

test('no vertex lies strictly inside an inflated obstacle', () => {
  const obstacle = { id: 'api', x: 250, y: 150, width: 100, height: 80 };
  const graph = singleObstacleGraph();
  const r = inflatedInterior(obstacle, CLEARANCE);

  for (const v of graph.vertices) {
    const strictlyInside =
      v.x > r.left + 0.001 && v.x < r.right - 0.001 &&
      v.y > r.top + 0.001 && v.y < r.bottom - 0.001;
    assert.ok(!strictlyInside, `vertex ${v.id} (${v.x},${v.y}) inside inflated obstacle`);
  }
});

test('no graph edge passes through an inflated obstacle interior', () => {
  const obstacle = { id: 'api', x: 250, y: 150, width: 100, height: 80 };
  const graph = singleObstacleGraph();
  const r = inflatedInterior(obstacle, CLEARANCE);
  const byId = new Map(graph.vertices.map(v => [v.id, v]));

  for (const e of graph.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (e.axis === 'h') {
      const crosses =
        a.y > r.top + 0.001 && a.y < r.bottom - 0.001 &&
        Math.max(Math.min(a.x, b.x), r.left) < Math.min(Math.max(a.x, b.x), r.right) - 0.001;
      assert.ok(!crosses, `horizontal edge at y=${a.y} crosses obstacle`);
    } else {
      const crosses =
        a.x > r.left + 0.001 && a.x < r.right - 0.001 &&
        Math.max(Math.min(a.y, b.y), r.top) < Math.min(Math.max(a.y, b.y), r.bottom) - 0.001;
      assert.ok(!crosses, `vertical edge at x=${a.x} crosses obstacle`);
    }
  }
});

test('channel midline exists between two side-by-side elements', () => {
  const graph = buildVisibilityGraph({
    bounds: BOUNDS,
    obstacles: [
      { id: 'a', x: 100, y: 150, width: 100, height: 80 },
      { id: 'b', x: 400, y: 150, width: 100, height: 80 }
    ],
    clearance: CLEARANCE
  });

  // Corridor between inflated faces runs from 216 to 384; midline at 300.
  const midline = graph.xCoords.find(c => Math.abs(c - 300) <= 0.5);
  assert.ok(midline !== undefined, 'centred lane exists in the corridor between elements');

  // The midline must be traversable top-to-bottom: a contiguous chain of
  // vertical edges along x=300 spanning the full bounds height.
  const laneEdges = graph.edges.filter(e => e.axis === 'v' && Math.abs(e.lane - midline) <= 0.5);
  const spanned = laneEdges.reduce((sum, e) => sum + e.length, 0);
  assert.ok(Math.abs(spanned - BOUNDS.height) <= 1, `midline spans bounds height (got ${spanned})`);
});

test('graph routes around an obstacle: left and right sides stay connected', () => {
  const graph = singleObstacleGraph();
  const byId = new Map(graph.vertices.map(v => [v.id, v]));

  const adjacency = new Map();
  for (const e of graph.edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    if (!adjacency.has(e.to)) adjacency.set(e.to, []);
    adjacency.get(e.from).push(e.to);
    adjacency.get(e.to).push(e.from);
  }

  const start = graph.vertices.find(v => v.x === 0 && v.y === 0);
  assert.ok(start, 'corner vertex exists');
  const seen = new Set([start.id]);
  const queue = [start.id];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }

  for (const v of graph.vertices) {
    assert.ok(seen.has(v.id), `vertex ${v.id} (${v.x},${v.y}) unreachable from corner`);
  }
  assert.ok(byId.size === graph.vertices.length);
});

test('ports: per-face slots with outward headings and on-grid lane joins', () => {
  const graph = singleObstacleGraph({ portsPerFace: 2 });
  const ports = graph.ports.get('api');

  assert.equal(ports.top.length, 2);
  assert.equal(ports.bottom.length, 2);
  assert.equal(ports.left.length, 2);
  assert.equal(ports.right.length, 2);

  // Slots sit on the face at 1/3 and 2/3.
  assert.ok(Math.abs(ports.top[0].x - (250 + 100 / 3)) < 0.01);
  assert.ok(Math.abs(ports.top[1].x - (250 + 200 / 3)) < 0.01);
  assert.equal(ports.top[0].y, 150);
  assert.equal(ports.bottom[0].y, 230);
  assert.equal(ports.top[0].heading, 'N');
  assert.equal(ports.bottom[0].heading, 'S');
  assert.equal(ports.left[0].heading, 'W');
  assert.equal(ports.right[0].heading, 'E');

  // Every laneJoin must resolve to a real graph vertex so terminal segments
  // connect ports into the graph.
  for (const face of ['top', 'bottom', 'left', 'right']) {
    for (const port of ports[face]) {
      const vertexId = graph.vertexAt(port.laneJoin.x, port.laneJoin.y);
      assert.ok(vertexId, `laneJoin for ${face} slot ${port.slot} has no vertex`);
    }
  }
});

test('output is deterministic for identical input', () => {
  const obstacles = [
    { id: 'a', x: 100, y: 60, width: 120, height: 70 },
    { id: 'b', x: 380, y: 60, width: 120, height: 70 },
    { id: 'c', x: 240, y: 260, width: 120, height: 70 }
  ];
  const build = () => buildVisibilityGraph({ bounds: BOUNDS, obstacles, clearance: CLEARANCE });
  const a = build();
  const b = build();

  assert.deepEqual(a.xCoords, b.xCoords);
  assert.deepEqual(a.yCoords, b.yCoords);
  assert.deepEqual(a.vertices, b.vertices);
  assert.deepEqual(a.edges, b.edges);
});

test('obstacle flush against the bounds edge does not create out-of-bounds lines', () => {
  const graph = buildVisibilityGraph({
    bounds: BOUNDS,
    obstacles: [{ id: 'edge-hugger', x: 0, y: 0, width: 100, height: 80 }],
    clearance: CLEARANCE
  });

  for (const c of graph.xCoords) {
    assert.ok(c >= -0.001 && c <= 600.001, `x coord ${c} out of bounds`);
  }
  for (const c of graph.yCoords) {
    assert.ok(c >= -0.001 && c <= 400.001, `y coord ${c} out of bounds`);
  }
  assert.ok(graph.vertices.length > 0);
});
