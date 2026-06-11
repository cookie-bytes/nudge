// Sparse orthogonal visibility graph for grid-based connection-line routing
// (next-gen router, docs/nudge_next_generation_design.md §3.1).
//
// Pure geometry: placed architecture element boxes in, routing graph out.
// No DOM, no A*, no rendering. Loaded both as a classic script in render.html
// and via side-effect import under `node --test`, hence the globalThis-safe
// namespace instead of the `window.NudgeRenderer` form used by browser-only
// renderer modules.
globalThis.NudgeRenderer = globalThis.NudgeRenderer || {};

globalThis.NudgeRenderer.visibilityGraph = (() => {
  const COORD_EPS = 0.5;   // grid lines closer than this are merged
  const GEOM_EPS = 1e-6;   // strict-interior tolerance for blocking checks

  function inflate(obstacle, clearance) {
    return {
      left: obstacle.x - clearance,
      top: obstacle.y - clearance,
      right: obstacle.x + obstacle.width + clearance,
      bottom: obstacle.y + obstacle.height + clearance
    };
  }

  function dedupeSorted(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const out = [];
    for (const v of sorted) {
      if (out.length === 0 || v - out[out.length - 1] > COORD_EPS) out.push(v);
    }
    return out;
  }

  // True when the point lies strictly inside any inflated obstacle. Points on
  // the inflated border are allowed — that border is the clearance lane.
  function pointBlocked(x, y, rects) {
    return rects.some(r =>
      x > r.left + GEOM_EPS && x < r.right - GEOM_EPS &&
      y > r.top + GEOM_EPS && y < r.bottom - GEOM_EPS
    );
  }

  // True when an axis-aligned segment passes through the strict interior of
  // any inflated obstacle. Endpoints/segments on the border are allowed.
  function segmentBlocked(x1, y1, x2, y2, rects) {
    const horizontal = Math.abs(y1 - y2) <= GEOM_EPS;
    for (const r of rects) {
      if (horizontal) {
        if (
          y1 > r.top + GEOM_EPS && y1 < r.bottom - GEOM_EPS &&
          Math.max(Math.min(x1, x2), r.left) < Math.min(Math.max(x1, x2), r.right) - GEOM_EPS
        ) return true;
      } else {
        if (
          x1 > r.left + GEOM_EPS && x1 < r.right - GEOM_EPS &&
          Math.max(Math.min(y1, y2), r.top) < Math.min(Math.max(y1, y2), r.bottom) - GEOM_EPS
        ) return true;
      }
    }
    return false;
  }

  // Evenly spaced port slots along each face of an element, each with an
  // outward heading and the point where its terminal segment joins the
  // clearance lane. Ports are terminal endpoints, not graph vertices: the
  // router connects port -> laneJoin, and laneJoin is guaranteed to sit on a
  // grid line because port coordinates are fed into the grid line sets.
  function buildPorts(obstacle, clearance, portsPerFace) {
    const slots = [];
    for (let i = 1; i <= portsPerFace; i++) slots.push(i / (portsPerFace + 1));
    const { x, y, width, height } = obstacle;

    return {
      top: slots.map((t, i) => ({
        slot: i,
        x: x + width * t,
        y,
        heading: 'N',
        laneJoin: { x: x + width * t, y: y - clearance }
      })),
      bottom: slots.map((t, i) => ({
        slot: i,
        x: x + width * t,
        y: y + height,
        heading: 'S',
        laneJoin: { x: x + width * t, y: y + height + clearance }
      })),
      left: slots.map((t, i) => ({
        slot: i,
        x,
        y: y + height * t,
        heading: 'W',
        laneJoin: { x: x - clearance, y: y + height * t }
      })),
      right: slots.map((t, i) => ({
        slot: i,
        x: x + width,
        y: y + height * t,
        heading: 'E',
        laneJoin: { x: x + width + clearance, y: y + height * t }
      }))
    };
  }

  // Grid lines per axis: bounds edges, inflated obstacle faces, element
  // centres (so straight centre-to-centre drops exist), port drop
  // coordinates, and channel midlines between consecutive blocking
  // coordinates (so every corridor has a centred lane).
  function buildAxisCoords({ boundEdges, blockingCoords, extraCoords, minChannelGap }) {
    const blocking = dedupeSorted([...boundEdges, ...blockingCoords]);
    const midlines = [];
    for (let i = 0; i < blocking.length - 1; i++) {
      if (blocking[i + 1] - blocking[i] >= minChannelGap) {
        midlines.push((blocking[i] + blocking[i + 1]) / 2);
      }
    }
    const [lo, hi] = [Math.min(...boundEdges), Math.max(...boundEdges)];
    return dedupeSorted(
      [...boundEdges, ...blockingCoords, ...extraCoords, ...midlines]
        .filter(v => v >= lo - GEOM_EPS && v <= hi + GEOM_EPS)
    );
  }

  /**
   * Build the orthogonal visibility graph.
   *
   * @param {object} options
   * @param {{x,y,width,height}} options.bounds      routing area (canvas or boundary box)
   * @param {Array<{id,x,y,width,height}>} options.obstacles  placed element boxes
   * @param {number} [options.clearance=16]          min distance routes keep from elements
   * @param {number} [options.portsPerFace=3]        port slots per element face
   * @returns {{ xCoords, yCoords, vertices, vertexAt, edges, ports }}
   *   vertices: [{id, x, y}] — grid intersections outside all inflated obstacles
   *   vertexAt: (x, y) => vertex id or undefined
   *   edges:    [{from, to, axis: 'h'|'v', lane, length}] — collision-free segments
   *             between adjacent vertices; `lane` is the shared grid-line coordinate
   *   ports:    Map elementId -> {top,bottom,left,right: [{slot,x,y,heading,laneJoin}]}
   */
  function buildVisibilityGraph({ bounds, obstacles, clearance = 16, portsPerFace = 3 }) {
    const rects = obstacles.map(o => inflate(o, clearance));
    const ports = new Map(obstacles.map(o => [o.id, buildPorts(o, clearance, portsPerFace)]));
    const portXs = [];
    const portYs = [];
    for (const facePorts of ports.values()) {
      for (const p of [...facePorts.top, ...facePorts.bottom]) portXs.push(p.x);
      for (const p of [...facePorts.left, ...facePorts.right]) portYs.push(p.y);
    }

    const xCoords = buildAxisCoords({
      boundEdges: [bounds.x, bounds.x + bounds.width],
      blockingCoords: rects.flatMap(r => [r.left, r.right]),
      extraCoords: [
        ...obstacles.map(o => o.x + o.width / 2),
        ...portXs
      ],
      minChannelGap: clearance
    });
    const yCoords = buildAxisCoords({
      boundEdges: [bounds.y, bounds.y + bounds.height],
      blockingCoords: rects.flatMap(r => [r.top, r.bottom]),
      extraCoords: [
        ...obstacles.map(o => o.y + o.height / 2),
        ...portYs
      ],
      minChannelGap: clearance
    });

    const vertices = [];
    const idGrid = new Map(); // `${xi},${yi}` -> vertex id
    xCoords.forEach((x, xi) => {
      yCoords.forEach((y, yi) => {
        if (pointBlocked(x, y, rects)) return;
        const id = `v${vertices.length}`;
        idGrid.set(`${xi},${yi}`, id);
        vertices.push({ id, x, y });
      });
    });

    const edges = [];
    // Horizontal segments: consecutive surviving vertices along each y line.
    yCoords.forEach((y, yi) => {
      let prev = null;
      xCoords.forEach((x, xi) => {
        const id = idGrid.get(`${xi},${yi}`);
        if (id === undefined) return;
        if (prev && !segmentBlocked(prev.x, y, x, y, rects)) {
          edges.push({ from: prev.id, to: id, axis: 'h', lane: y, length: x - prev.x });
        }
        prev = { id, x };
      });
    });
    // Vertical segments: consecutive surviving vertices along each x line.
    xCoords.forEach((x, xi) => {
      let prev = null;
      yCoords.forEach((y, yi) => {
        const id = idGrid.get(`${xi},${yi}`);
        if (id === undefined) return;
        if (prev && !segmentBlocked(x, prev.y, x, y, rects)) {
          edges.push({ from: prev.id, to: id, axis: 'v', lane: x, length: y - prev.y });
        }
        prev = { id, y };
      });
    });

    const coordIndex = new Map(vertices.map(v => [`${v.x},${v.y}`, v.id]));
    // Tolerant lookup: grid-line dedupe can shift a requested coordinate (e.g.
    // a port laneJoin) by up to COORD_EPS onto the surviving merged line.
    const vertexAt = (x, y) => {
      const exact = coordIndex.get(`${x},${y}`);
      if (exact !== undefined) return exact;
      const near = vertices.find(v => Math.abs(v.x - x) <= COORD_EPS && Math.abs(v.y - y) <= COORD_EPS);
      return near?.id;
    };

    return { xCoords, yCoords, vertices, vertexAt, edges, ports };
  }

  return { buildVisibilityGraph };
})();
