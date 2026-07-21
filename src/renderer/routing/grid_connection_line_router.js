// Grid-based connection-line router (next-gen design §3, behind NUDGE_ROUTER=grid).
//
// Routes connection lines with A* over the sparse orthogonal visibility graph
// (visibility_graph.js) instead of enumerating hand-written candidates.
// Search state is (vertex, heading) so bends are first-class costs. Ports are
// shared resources: each use of a face slot raises the cost of reusing it.
// Lines are routed hardest-first, then a rip-up-and-reroute round re-routes
// the worst offenders while the global conflict score improves.
//
// Pure geometry — no DOM. Loaded as a classic script in render.html and via
// side-effect import under `node --test`, hence the globalThis-safe namespace.
globalThis.NudgeRenderer = globalThis.NudgeRenderer || {};

globalThis.NudgeRenderer.gridConnectionLineRouter = (() => {
  // Aesthetic weights profile (next-gen design Pillar 4). One place, no
  // scattered bias literals. Element crossings are impossible by construction
  // (the graph contains no segment through an inflated obstacle).
  const WEIGHTS = {
    length: 0.5,        // per px
    bend: 40,           // per direction change
    cross: 200,         // per crossing with an already-routed line
    overlapFlat: 100,   // per overlapping routed segment (non-bundled)
    overlapPx: 2,       // per overlapping px
    portOccupied: 120,  // per prior use of the same port slot
    boundaryCross: 400  // per boundary-border crossing for internal↔internal lines
  };

  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const EPS = 1e-6;

  function direction(from, to) {
    if (Math.abs(to.x - from.x) > Math.abs(to.y - from.y)) return to.x > from.x ? 'E' : 'W';
    return to.y > from.y ? 'S' : 'N';
  }

  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  // Axis-aligned segments as {axis:'h'|'v', lane, lo, hi, edgeIdx}
  function polylineToSegments(points, edgeIdx) {
    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.x - b.x) > 0.5) {
        segments.push({ axis: 'h', lane: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), edgeIdx });
      } else if (Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) > 0.5) {
        segments.push({ axis: 'v', lane: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), edgeIdx });
      }
    }
    return segments;
  }

  // Mirrors the math scorer's semantics (core/geometry.js segmentsCross):
  // T-junctions — one segment ending on the interior of another — count as
  // crossings; only endpoint-to-endpoint corner touches are exempt.
  function segmentsConflict(segA, segB) {
    if (segA.axis !== segB.axis) {
      const h = segA.axis === 'h' ? segA : segB;
      const v = segA.axis === 'h' ? segB : segA;
      const intersects =
        v.lane >= h.lo - 1 && v.lane <= h.hi + 1 &&
        h.lane >= v.lo - 1 && h.lane <= v.hi + 1;
      if (!intersects) return null;
      const atHEnd = v.lane < h.lo + 2 || v.lane > h.hi - 2;
      const atVEnd = h.lane < v.lo + 2 || h.lane > v.hi - 2;
      if (atHEnd && atVEnd) return null; // corner touch, not a crossing
      return { cross: true };
    }
    if (Math.abs(segA.lane - segB.lane) > 1) return null;
    const overlap = Math.min(segA.hi, segB.hi) - Math.max(segA.lo, segB.lo);
    return overlap > 2 ? { overlapPx: overlap } : null;
  }

  // Crossings of an axis-aligned segment with the border of a rect.
  function borderCrossings(seg, rect) {
    if (!rect) return 0;
    const { x, y, width, height } = rect;
    let crossings = 0;
    if (seg.axis === 'h') {
      if (seg.lane > y + EPS && seg.lane < y + height - EPS) {
        if (seg.lo < x - EPS && seg.hi > x + EPS) crossings++;
        if (seg.lo < x + width - EPS && seg.hi > x + width + EPS) crossings++;
      }
    } else {
      if (seg.lane > x + EPS && seg.lane < x + width - EPS) {
        if (seg.lo < y - EPS && seg.hi > y + EPS) crossings++;
        if (seg.lo < y + height - EPS && seg.hi > y + height + EPS) crossings++;
      }
    }
    return crossings;
  }

  function collapseCollinear(points) {
    const out = [];
    for (const p of points) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y) < 0.5) continue;
      out.push({ x: p.x, y: p.y });
      while (out.length >= 3) {
        const [a, b, c] = out.slice(-3);
        const abH = Math.abs(a.y - b.y) < 0.5;
        const bcH = Math.abs(b.y - c.y) < 0.5;
        const abV = Math.abs(a.x - b.x) < 0.5;
        const bcV = Math.abs(b.x - c.x) < 0.5;
        if ((abH && bcH) || (abV && bcV)) out.splice(out.length - 2, 1);
        else break;
      }
    }
    return out;
  }

  function pointsToSection(points) {
    return {
      startPoint: points[0],
      bendPoints: points.slice(1, -1),
      endPoint: points[points.length - 1]
    };
  }

  // Minimal binary min-heap on f.
  function createHeap() {
    const items = [];
    return {
      push(item) {
        items.push(item);
        let i = items.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (items[parent].f <= items[i].f) break;
          [items[parent], items[i]] = [items[i], items[parent]];
          i = parent;
        }
      },
      pop() {
        const top = items[0];
        const last = items.pop();
        if (items.length > 0) {
          items[0] = last;
          let i = 0;
          for (;;) {
            const l = 2 * i + 1, r = 2 * i + 2;
            let smallest = i;
            if (l < items.length && items[l].f < items[smallest].f) smallest = l;
            if (r < items.length && items[r].f < items[smallest].f) smallest = r;
            if (smallest === i) break;
            [items[smallest], items[i]] = [items[i], items[smallest]];
            i = smallest;
          }
        }
        return top;
      },
      get size() { return items.length; }
    };
  }

  function createRouter({
    allEdges,
    obstacles,
    bounds,
    boundaryRect = null,
    childIds = new Set(),
    canBundleEdges = () => false,
    clearance = 18,
    portsPerFace = 3,
    weights = WEIGHTS
  }) {
    const graph = globalThis.NudgeRenderer.visibilityGraph.buildVisibilityGraph({
      bounds, obstacles, clearance, portsPerFace
    });
    const vertexById = new Map(graph.vertices.map(v => [v.id, v]));
    const adjacency = new Map(graph.vertices.map(v => [v.id, []]));
    for (const e of graph.edges) {
      adjacency.get(e.from).push({ to: e.to, length: e.length });
      adjacency.get(e.to).push({ to: e.from, length: e.length });
    }

    const obstacleById = new Map(obstacles.map(o => [o.id, o]));
    const portUse = new Map();        // portKey -> use count
    const routedSegments = [];        // conflict obstacles for subsequent lines
    const portsUsedByEdge = new Map(); // edgeIdx -> [portKeys]

    function moveConflictCost(seg, edge) {
      let cost = 0;
      for (const rs of routedSegments) {
        if (canBundleEdges(edge, allEdges[rs.edgeIdx])) continue;
        const conflict = segmentsConflict(seg, rs);
        if (!conflict) continue;
        if (conflict.cross) cost += weights.cross;
        else cost += weights.overlapFlat + conflict.overlapPx * weights.overlapPx;
      }
      return cost;
    }

    // Conflict cost of one edge's polyline against all other polylines in the
    // given (mutable) point arrays. Shared accept check for the post-routing
    // passes (nudging, kink straightening): a move that raises this is undone.
    function edgeConflictCostIn(pointsByEdge, edgeIdx) {
      let cost = 0;
      const own = polylineToSegments(pointsByEdge[edgeIdx], edgeIdx);
      pointsByEdge.forEach((points, otherIdx) => {
        if (!points || otherIdx === edgeIdx) return;
        if (canBundleEdges(allEdges[edgeIdx], allEdges[otherIdx])) return;
        for (const a of own) {
          for (const b of polylineToSegments(points, otherIdx)) {
            const conflict = segmentsConflict(a, b);
            if (!conflict) continue;
            cost += conflict.cross ? weights.cross : weights.overlapFlat + conflict.overlapPx * weights.overlapPx;
          }
        }
      });
      return cost;
    }

    function terminalStates(elementId, kind) {
      const facePorts = graph.ports.get(elementId);
      if (!facePorts) return [];
      const element = obstacleById.get(elementId);
      // A person's silhouette is symmetric about its centre, so a single line
      // reads best leaving from the body centreline. Bias its dock points
      // toward the centre slot of each face; the portOccupied penalty still
      // fans out multiple lines onto neighbouring slots.
      const centreBias = element && element.type === 'person';
      const cx = element ? element.x + element.width / 2 : 0;
      const cy = element ? element.y + element.height / 2 : 0;
      const states = [];
      for (const [face, ports] of Object.entries(facePorts)) {
        for (const port of ports) {
          const vertexId = graph.vertexAt(port.laneJoin.x, port.laneJoin.y);
          if (!vertexId) continue;
          const portKey = `${elementId}:${face}:${port.slot}`;
          const centreOffset = centreBias
            ? (face === 'top' || face === 'bottom' ? Math.abs(port.x - cx) : Math.abs(port.y - cy))
            : 0;
          states.push({
            vertexId,
            portKey,
            point: { x: port.x, y: port.y },
            laneJoin: port.laneJoin,
            // travel direction: source exits P->J, target enters J->P
            heading: kind === 'source' ? port.heading : OPPOSITE[port.heading],
            terminalCost:
              manhattan(port, port.laneJoin) * weights.length +
              (portUse.get(portKey) || 0) * weights.portOccupied +
              centreOffset * weights.length * 4
          });
        }
      }
      return states;
    }

    function routeOne(e, idx) {
      const src = obstacleById.get(e.from);
      const tgt = obstacleById.get(e.to);
      if (!src || !tgt || src.id === tgt.id) return null;

      const starts = terminalStates(e.from, 'source');
      const goalStates = terminalStates(e.to, 'target');
      if (starts.length === 0 || goalStates.length === 0) return null;

      const goalsByVertex = new Map();
      for (const g of goalStates) {
        if (!goalsByVertex.has(g.vertexId)) goalsByVertex.set(g.vertexId, []);
        goalsByVertex.get(g.vertexId).push(g);
      }
      const goalPoints = goalStates.map(g => vertexById.get(g.vertexId));
      const heuristic = (v) =>
        Math.min(...goalPoints.map(gp => manhattan(v, gp))) * weights.length;

      const bothInternal = childIds.has(e.from) && childIds.has(e.to);
      const heap = createHeap();
      const bestG = new Map();   // `${vertexId}|${heading}` -> g
      const parent = new Map();  // stateKey -> { prevKey, start }

      for (const s of starts) {
        const key = `${s.vertexId}|${s.heading}`;
        if (s.terminalCost < (bestG.get(key) ?? Infinity)) {
          bestG.set(key, s.terminalCost);
          parent.set(key, { prevKey: null, start: s });
          heap.push({
            f: s.terminalCost + heuristic(vertexById.get(s.vertexId)),
            g: s.terminalCost, vertexId: s.vertexId, heading: s.heading, key
          });
        }
      }

      let found = null;
      while (heap.size > 0) {
        const state = heap.pop();
        if (state.goal) { found = state; break; }
        if (state.g > (bestG.get(state.key) ?? Infinity) + EPS) continue;
        const vertex = vertexById.get(state.vertexId);

        // Finish: turn into a target port at this vertex.
        for (const goal of goalsByVertex.get(state.vertexId) || []) {
          const cost =
            (state.heading !== goal.heading ? weights.bend : 0) + goal.terminalCost;
          heap.push({
            f: state.g + cost, g: state.g + cost,
            goal, prevKey: state.key
          });
        }

        for (const move of adjacency.get(state.vertexId)) {
          const nextVertex = vertexById.get(move.to);
          const heading = direction(vertex, nextVertex);
          const seg = polylineToSegments([vertex, nextVertex], idx)[0];
          if (!seg) continue;
          let cost =
            move.length * weights.length +
            (heading !== state.heading ? weights.bend : 0) +
            moveConflictCost(seg, e);
          if (bothInternal) cost += borderCrossings(seg, boundaryRect) * weights.boundaryCross;

          const g = state.g + cost;
          const key = `${move.to}|${heading}`;
          if (g < (bestG.get(key) ?? Infinity) - EPS) {
            bestG.set(key, g);
            parent.set(key, { prevKey: state.key });
            heap.push({ f: g + heuristic(nextVertex), g, vertexId: move.to, heading, key });
          }
        }
      }

      if (!found) return null;

      // Reconstruct: source port point, lane vertices, target port point.
      const chain = [];
      let cursor = found.prevKey;
      let startState = null;
      while (cursor) {
        const [vertexId] = cursor.split('|');
        chain.unshift(vertexById.get(vertexId));
        const link = parent.get(cursor);
        if (link.start) { startState = link.start; break; }
        cursor = link.prevKey;
      }
      if (!startState) return null;

      const points = collapseCollinear([
        startState.point,
        ...chain,
        found.goal.laneJoin,
        found.goal.point
      ]);
      if (points.length < 2) return null;

      portUse.set(startState.portKey, (portUse.get(startState.portKey) || 0) + 1);
      portUse.set(found.goal.portKey, (portUse.get(found.goal.portKey) || 0) + 1);
      portsUsedByEdge.set(idx, [startState.portKey, found.goal.portKey]);
      return pointsToSection(points);
    }

    function registerSection(section, idx) {
      const points = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
      routedSegments.push(...polylineToSegments(points, idx));
    }

    function unregisterEdge(idx) {
      for (let i = routedSegments.length - 1; i >= 0; i--) {
        if (routedSegments[i].edgeIdx === idx) routedSegments.splice(i, 1);
      }
      for (const portKey of portsUsedByEdge.get(idx) || []) {
        portUse.set(portKey, Math.max(0, (portUse.get(portKey) || 0) - 1));
      }
      portsUsedByEdge.delete(idx);
    }

    // Pairwise conflict score of the routed set (grid-routed sections only).
    function evaluateSections(sections) {
      const segmentsByEdge = sections.map((section, idx) =>
        section ? polylineToSegments(
          [section.startPoint, ...(section.bendPoints || []), section.endPoint], idx
        ) : []
      );
      const perEdge = sections.map(() => 0);
      let total = 0;
      for (let i = 0; i < segmentsByEdge.length; i++) {
        for (let j = i + 1; j < segmentsByEdge.length; j++) {
          if (canBundleEdges(allEdges[i], allEdges[j])) continue;
          for (const segA of segmentsByEdge[i]) {
            for (const segB of segmentsByEdge[j]) {
              const conflict = segmentsConflict(segA, segB);
              if (!conflict) continue;
              const cost = conflict.cross
                ? WEIGHTS.cross
                : WEIGHTS.overlapFlat + conflict.overlapPx * WEIGHTS.overlapPx;
              perEdge[i] += cost;
              perEdge[j] += cost;
              total += cost;
            }
          }
        }
      }
      return { total, perEdge };
    }

    // ── Nudging phase (next-gen design §3.4) ────────────────────────────────
    // Routing lets lines share a channel; nudging separates them afterwards.
    // Interior segments that run (near-)collinear are clustered per axis and
    // offset onto parallel lanes. Port endpoints stay fixed: only segments
    // that do not touch the polyline's first/last point are moved, so entry
    // and exit geometry is preserved.
    const NUDGE_GAP = 14;          // lane separation inside a shared channel
    const NUDGE_CLUSTER_DIST = 8;  // lanes closer than this belong to one cluster

    function nudgeSections(sections) {
      const pointsByEdge = sections.map(section =>
        section ? [section.startPoint, ...(section.bendPoints || []), section.endPoint] : null
      );

      // All orthogonal segments take part in clustering; only interior ones
      // (not touching the polyline's first/last point) may be moved. Fixed
      // segments act as anchors the movable ones must dodge.
      const segments = [];
      pointsByEdge.forEach((points, edgeIdx) => {
        if (!points) return;
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i];
          const b = points[i + 1];
          const horizontal = Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.x - b.x) > 0.5;
          const vertical = Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) > 0.5;
          if (!horizontal && !vertical) continue;
          segments.push({
            edgeIdx, pointIdx: i,
            movable: i >= 1 && i < points.length - 2,
            axis: horizontal ? 'h' : 'v',
            lane: horizontal ? a.y : a.x,
            lo: horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
            hi: horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
          });
        }
      });

      // Cluster by axis + lane proximity + interval overlap (union-find).
      const parent = segments.map((_, i) => i);
      const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      for (let i = 0; i < segments.length; i++) {
        for (let j = i + 1; j < segments.length; j++) {
          const a = segments[i], b = segments[j];
          if (a.axis !== b.axis) continue;
          if (a.edgeIdx === b.edgeIdx) continue;
          if (Math.abs(a.lane - b.lane) > NUDGE_CLUSTER_DIST) continue;
          if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) <= 10) continue;
          if (canBundleEdges(allEdges[a.edgeIdx], allEdges[b.edgeIdx])) continue;
          parent[find(i)] = find(j);
        }
      }
      const clusters = new Map();
      segments.forEach((seg, i) => {
        const root = find(i);
        if (!clusters.has(root)) clusters.set(root, []);
        clusters.get(root).push(seg);
      });

      // A nudged lane must not enter any obstacle (with a small margin).
      function laneBlocked(axis, lane, lo, hi) {
        const margin = 4;
        for (const o of obstacles) {
          if (axis === 'h') {
            if (lane > o.y - margin && lane < o.y + o.height + margin &&
                Math.max(lo, o.x - margin) < Math.min(hi, o.x + o.width + margin)) return true;
          } else {
            if (lane > o.x - margin && lane < o.x + o.width + margin &&
                Math.max(lo, o.y - margin) < Math.min(hi, o.y + o.height + margin)) return true;
          }
        }
        return false;
      }

      for (const cluster of clusters.values()) {
        if (cluster.length < 2 || !cluster.some(s => s.movable)) continue;
        // Stable order: by where each line continues after this segment, so
        // parallel lines exit the channel without weaving through each other.
        cluster.sort((a, b) => {
          const pa = pointsByEdge[a.edgeIdx];
          const pb = pointsByEdge[b.edgeIdx];
          const nextA = pa[a.pointIdx + 2] || pa[a.pointIdx + 1];
          const nextB = pb[b.pointIdx + 2] || pb[b.pointIdx + 1];
          return a.axis === 'h' ? (nextA.y - nextB.y) : (nextA.x - nextB.x);
        });

        // Candidate lanes spread around the cluster centre. Fixed segments
        // claim their nearest lane first; movable segments take what remains.
        const centre = cluster.reduce((sum, s) => sum + s.lane, 0) / cluster.length;
        const slots = cluster.map((_, k) => centre + (k - (cluster.length - 1) / 2) * NUDGE_GAP);
        const taken = new Set();
        for (const seg of cluster.filter(s => !s.movable)) {
          let nearest = -1;
          for (let k = 0; k < slots.length; k++) {
            if (taken.has(k)) continue;
            if (nearest === -1 || Math.abs(slots[k] - seg.lane) < Math.abs(slots[nearest] - seg.lane)) nearest = k;
          }
          if (nearest !== -1) taken.add(nearest);
        }
        const freeSlots = slots.filter((_, k) => !taken.has(k));
        let slotIdx = 0;
        for (const seg of cluster) {
          if (!seg.movable) continue;
          const target = freeSlots[slotIdx++];
          if (target === undefined || Math.abs(target - seg.lane) < 0.5) continue;
          if (laneBlocked(seg.axis, target, seg.lo, seg.hi)) continue;
          const points = pointsByEdge[seg.edgeIdx];
          const before = edgeConflictCostIn(pointsByEdge, seg.edgeIdx);
          const apply = (lane) => {
            if (seg.axis === 'h') {
              points[seg.pointIdx].y = lane;
              points[seg.pointIdx + 1].y = lane;
            } else {
              points[seg.pointIdx].x = lane;
              points[seg.pointIdx + 1].x = lane;
            }
          };
          apply(target);
          if (edgeConflictCostIn(pointsByEdge, seg.edgeIdx) > before) apply(seg.lane);
        }
      }

      return sections.map((section, idx) => {
        if (!section) return section;
        const points = collapseCollinear(pointsByEdge[idx]);
        return points.length >= 2 ? pointsToSection(points) : section;
      });
    }

    // ── Kink straightening ──────────────────────────────────────────────────
    // Port slots are discrete (3 per face), so slightly misaligned dock points
    // produce short Z-jogs: two parallel runs joined by a tiny perpendicular
    // stub. Dock points may slide continuously along their face, so collapse
    // each jog by moving one parallel run onto the other's lane — sliding the
    // dock when the run is terminal — if it stays on the face, crosses no
    // element, and does not raise the line's conflict cost.
    const KINK_MAX = 24;     // stub shorter than this is a kink, not a route
    const FACE_MARGIN = 8;   // dock points keep this distance from face corners
    const MIN_STUB = 4;      // interior moves must not collapse/flip neighbours

    function straightenKinks(sections) {
      const pointsByEdge = sections.map(section =>
        section
          ? [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(p => ({ x: p.x, y: p.y }))
          : null
      );

      function segmentHitsObstacle(vertical, lane, lo, hi) {
        const m = 2;
        for (const o of obstacles) {
          if (vertical) {
            if (lane > o.x + m && lane < o.x + o.width - m &&
                Math.max(lo, o.y + m) < Math.min(hi, o.y + o.height - m)) return true;
          } else {
            if (lane > o.y + m && lane < o.y + o.height - m &&
                Math.max(lo, o.x + m) < Math.min(hi, o.x + o.width - m)) return true;
          }
        }
        return false;
      }

      pointsByEdge.forEach((pts, idx) => {
        if (!pts) return;
        const src = obstacleById.get(allEdges[idx].from);
        const tgt = obstacleById.get(allEdges[idx].to);
        let changed = true;
        let guard = 0;
        while (changed && guard++ < 6) {
          changed = false;
          for (let i = 1; i <= pts.length - 3; i++) {
            // Runs a = pts[i-1]->pts[i], stub b = pts[i]->pts[i+1], c = pts[i+1]->pts[i+2]
            const stubLen = Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
            if (stubLen < 0.5 || stubLen >= KINK_MAX) continue;
            const aVertical = Math.abs(pts[i - 1].x - pts[i].x) <= 0.5 && Math.abs(pts[i - 1].y - pts[i].y) > 0.5;
            const cVertical = Math.abs(pts[i + 1].x - pts[i + 2].x) <= 0.5 && Math.abs(pts[i + 1].y - pts[i + 2].y) > 0.5;
            const aHorizontal = Math.abs(pts[i - 1].y - pts[i].y) <= 0.5 && Math.abs(pts[i - 1].x - pts[i].x) > 0.5;
            const cHorizontal = Math.abs(pts[i + 1].y - pts[i + 2].y) <= 0.5 && Math.abs(pts[i + 1].x - pts[i + 2].x) > 0.5;
            if (!((aVertical && cVertical) || (aHorizontal && cHorizontal))) continue;
            const vertical = aVertical;
            const laneOf = (p) => vertical ? p.x : p.y;
            const alongOf = (p) => vertical ? p.y : p.x;

            const tryMove = (moveFirstRun) => {
              const lane = moveFirstRun ? laneOf(pts[i + 1]) : laneOf(pts[i]);
              const [m0, m1] = moveFirstRun ? [i - 1, i] : [i + 1, i + 2];
              const isDock = moveFirstRun ? (m0 === 0) : (m1 === pts.length - 1);

              if (isDock) {
                const el = moveFirstRun ? src : tgt;
                if (!el) return false;
                const faceLo = vertical ? el.x : el.y;
                const faceHi = vertical ? el.x + el.width : el.y + el.height;
                if (lane < faceLo + FACE_MARGIN || lane > faceHi - FACE_MARGIN) return false;
              } else {
                // Moving an interior bend stretches the perpendicular segment
                // behind it; refuse if that segment would flip or vanish.
                const anchor = moveFirstRun ? pts[m0 - 1] : pts[m1 + 1];
                if (!anchor) return false;
                const oldLen = laneOf(pts[moveFirstRun ? m0 : m1]) - laneOf(anchor);
                const newLen = lane - laneOf(anchor);
                if (Math.sign(oldLen) !== Math.sign(newLen) || Math.abs(newLen) < MIN_STUB) return false;
              }

              const mergedLo = Math.min(alongOf(pts[m0]), alongOf(pts[m1]), alongOf(pts[i]), alongOf(pts[i + 1]));
              const mergedHi = Math.max(alongOf(pts[m0]), alongOf(pts[m1]), alongOf(pts[i]), alongOf(pts[i + 1]));
              if (segmentHitsObstacle(vertical, lane, mergedLo, mergedHi)) return false;

              const saved = [{ ...pts[m0] }, { ...pts[m1] }];
              const before = edgeConflictCostIn(pointsByEdge, idx);
              if (vertical) { pts[m0].x = lane; pts[m1].x = lane; }
              else { pts[m0].y = lane; pts[m1].y = lane; }
              if (edgeConflictCostIn(pointsByEdge, idx) > before) {
                pts[m0].x = saved[0].x; pts[m0].y = saved[0].y;
                pts[m1].x = saved[1].x; pts[m1].y = saved[1].y;
                return false;
              }
              return true;
            };

            if (tryMove(true) || tryMove(false)) {
              const collapsed = collapseCollinear(pts);
              pts.length = 0;
              pts.push(...collapsed);
              changed = true;
              break;
            }
          }
        }
      });

      return sections.map((section, idx) => {
        if (!section) return section;
        const points = collapseCollinear(pointsByEdge[idx]);
        return points.length >= 2 ? pointsToSection(points) : section;
      });
    }

    // ── Terminal approach lengthening ────────────────────────────────────────
    // A port drop is only `clearance` (~18px) long, but the arrowhead marker
    // covers ~15px of it — so the last bend sits right at the arrowhead base and
    // no dash shows on the straight approach. Lengthen the final straight run to
    // at least MIN_APPROACH, leaving room for the arrowhead plus a visible dash:
    //   • Slide — when the corner behind the drop is interior, push it and its
    //     perpendicular neighbour outward together (the route stays orthogonal).
    //   • Jog — when the route is a bare L whose corner is pinned between two
    //     ports, insert a small step at the far (non-arrowhead) end so the
    //     arrowhead end still gets its straight run.
    // Either move is kept only if it crosses no element and does not raise the
    // line's conflict cost. The jog is applied only to the target (end) approach,
    // since the arrowhead sits there by default and the step must land away from it.
    const MIN_APPROACH = 30;
    // A lengthened approach must not slide its corridor run to within this of a
    // near-parallel neighbour: two lines closer than this read as one stroke.
    const MIN_PARALLEL_GAP = 12;

    function lengthenTerminalApproaches(sections) {
      const pointsByEdge = sections.map(section =>
        section
          ? [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(p => ({ x: p.x, y: p.y }))
          : null
      );

      function segmentHitsObstacle(vertical, c1, c2, lane) {
        const lo = Math.min(c1, c2), hi = Math.max(c1, c2), m = 2;
        for (const o of obstacles) {
          if (vertical) {
            if (lane > o.x + m && lane < o.x + o.width - m &&
                Math.max(lo, o.y + m) < Math.min(hi, o.y + o.height - m)) return true;
          } else {
            if (lane > o.y + m && lane < o.y + o.height - m &&
                Math.max(lo, o.x + m) < Math.min(hi, o.x + o.width - m)) return true;
          }
        }
        return false;
      }

      // Smallest gap from edge `idx`'s orthogonal segments to any overlapping
      // like-axis segment of another (non-bundled) edge. Lengthening a terminal
      // approach can slide the adjoining corridor run sideways; near-parallel
      // proximity is neither a crossing nor a collinear overlap, so the conflict
      // cost alone would let a slide fuse two lines into one thick stroke. This
      // measures that proximity so commitIfClear can veto the crowding slide.
      const orthSegments = (pts) => {
        const segs = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const horizontal = Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.x - b.x) > 0.5;
          const vertical = Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) > 0.5;
          if (!horizontal && !vertical) continue;
          segs.push({
            horizontal,
            lane: horizontal ? a.y : a.x,
            lo: horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
            hi: horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
          });
        }
        return segs;
      };
      function nearestParallelGap(idx) {
        const own = pointsByEdge[idx];
        if (!own) return Infinity;
        const ownSegs = orthSegments(own);
        let best = Infinity;
        pointsByEdge.forEach((pts, other) => {
          if (!pts || other === idx || canBundleEdges(allEdges[idx], allEdges[other])) return;
          for (const s of orthSegments(pts)) {
            for (const o of ownSegs) {
              if (s.horizontal !== o.horizontal) continue;
              if (Math.min(s.hi, o.hi) - Math.max(s.lo, o.lo) <= 10) continue;
              const gap = Math.abs(s.lane - o.lane);
              if (gap > 0.5 && gap < best) best = gap;
            }
          }
        });
        return best;
      }

      // Replace pts in place with newPts, but only if no element is crossed, the
      // line's conflict cost does not rise, and the move does not pull this line
      // within MIN_PARALLEL_GAP of a near-parallel neighbour it was clear of;
      // otherwise restore and report false.
      function commitIfClear(pts, idx, newPts, segmentsClear) {
        if (!segmentsClear()) return false;
        const saved = pts.map(p => ({ x: p.x, y: p.y }));
        const before = edgeConflictCostIn(pointsByEdge, idx);
        const gapBefore = nearestParallelGap(idx);
        pts.length = 0;
        pts.push(...newPts);
        const gapAfter = nearestParallelGap(idx);
        if (edgeConflictCostIn(pointsByEdge, idx) > before ||
            (gapAfter < MIN_PARALLEL_GAP && gapAfter < gapBefore - 0.5)) {
          pts.length = 0;
          pts.push(...saved);
          return false;
        }
        return true;
      }

      function extendEnd(pts, idx, atStart) {
        if (pts.length < 3) return false;
        const last = pts.length - 1;
        const P = atStart ? pts[0] : pts[last];
        const C = atStart ? pts[1] : pts[last - 1];
        const B = atStart ? pts[2] : pts[last - 2];

        const vertical = Math.abs(P.x - C.x) <= 0.5 && Math.abs(P.y - C.y) > 0.5;
        const horizontal = Math.abs(P.y - C.y) <= 0.5 && Math.abs(P.x - C.x) > 0.5;
        if (!vertical && !horizontal) return false;
        // B–C must be perpendicular to the P–C approach for the move to stay orthogonal.
        if (vertical ? Math.abs(B.y - C.y) > 0.5 : Math.abs(B.x - C.x) > 0.5) return false;

        const approachLen = vertical ? Math.abs(C.y - P.y) : Math.abs(C.x - P.x);
        if (approachLen >= MIN_APPROACH - 0.5) return false;

        const sign = Math.sign((vertical ? C.y : C.x) - (vertical ? P.y : P.x)) || 1;
        const newCoord = (vertical ? P.y : P.x) + sign * MIN_APPROACH;
        const bIsPort = atStart ? (2 === last) : (last - 2 === 0);

        if (!bIsPort) {
          // SLIDE: move C and B outward together; the run behind B absorbs the change.
          const A = atStart ? pts[3] : pts[last - 3];
          const newPts = pts.map(p => ({ x: p.x, y: p.y }));
          const nC = atStart ? newPts[1] : newPts[last - 1];
          const nB = atStart ? newPts[2] : newPts[last - 2];
          if (vertical) { nC.y = newCoord; nB.y = newCoord; } else { nC.x = newCoord; nB.x = newCoord; }
          return commitIfClear(pts, idx, newPts, () => !(vertical
            ? segmentHitsObstacle(false, nB.x, nC.x, newCoord) ||
              segmentHitsObstacle(true, P.y, newCoord, nC.x) ||
              segmentHitsObstacle(true, A.y, newCoord, nB.x)
            : segmentHitsObstacle(true, nB.y, nC.y, newCoord) ||
              segmentHitsObstacle(false, P.x, newCoord, nC.y) ||
              segmentHitsObstacle(false, A.x, newCoord, nB.y)));
        }

        // JOG: bare L with a pinned corner. Only fix the target (arrowhead) end so
        // the inserted step lands at the source. Insert N + moved corner Cp:
        //   B → N (along approach axis) → Cp (along old B–C axis) → P (approach)
        if (atStart) return false;
        const Cp = vertical ? { x: C.x, y: newCoord } : { x: newCoord, y: C.y };
        const N = vertical ? { x: B.x, y: newCoord } : { x: newCoord, y: B.y };
        const newPts = [...pts.slice(0, last - 1).map(p => ({ x: p.x, y: p.y })), N, Cp, { x: P.x, y: P.y }];
        return commitIfClear(pts, idx, newPts, () => !(vertical
          ? segmentHitsObstacle(true, B.y, newCoord, B.x) ||      // B → N
            segmentHitsObstacle(false, B.x, C.x, newCoord) ||     // N → Cp
            segmentHitsObstacle(true, P.y, newCoord, C.x)         // Cp → P
          : segmentHitsObstacle(false, B.x, newCoord, B.y) ||
            segmentHitsObstacle(true, B.y, C.y, newCoord) ||
            segmentHitsObstacle(false, P.x, newCoord, C.y)));
      }

      pointsByEdge.forEach((pts, idx) => {
        if (!pts) return;
        extendEnd(pts, idx, false);
        extendEnd(pts, idx, true);
      });

      return sections.map((section, idx) => {
        if (!section) return section;
        const points = collapseCollinear(pointsByEdge[idx]);
        return points.length >= 2 ? pointsToSection(points) : section;
      });
    }

    function routeAll() {
      const sections = new Array(allEdges.length).fill(null);

      // Hardest-first: longest centre-to-centre Manhattan distance routes
      // while corridors are still empty.
      const order = allEdges
        .map((e, idx) => {
          const src = obstacleById.get(e.from);
          const tgt = obstacleById.get(e.to);
          const span = src && tgt
            ? manhattan(
                { x: src.x + src.width / 2, y: src.y + src.height / 2 },
                { x: tgt.x + tgt.width / 2, y: tgt.y + tgt.height / 2 }
              )
            : -1;
          return { idx, span };
        })
        .sort((a, b) => b.span - a.span)
        .map(o => o.idx);

      for (const idx of order) {
        const section = routeOne(allEdges[idx], idx);
        if (section) {
          sections[idx] = section;
          registerSection(section, idx);
        }
      }

      // Rip-up-and-reroute: re-route the worst conflicting lines against the
      // rest; keep each re-route only if the global score does not worsen.
      let { total, perEdge } = evaluateSections(sections);
      const offenders = perEdge
        .map((score, idx) => ({ idx, score }))
        .filter(o => o.score > 0 && sections[o.idx])
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      for (const { idx } of offenders) {
        const previous = sections[idx];
        const previousPorts = portsUsedByEdge.get(idx);
        unregisterEdge(idx);
        const rerouted = routeOne(allEdges[idx], idx);
        if (rerouted) {
          sections[idx] = rerouted;
          registerSection(rerouted, idx);
          const next = evaluateSections(sections);
          if (next.total <= total) {
            total = next.total;
            continue;
          }
          unregisterEdge(idx);
        }
        // Restore the previous route (and its port reservations).
        sections[idx] = previous;
        registerSection(previous, idx);
        if (previousPorts) {
          portsUsedByEdge.set(idx, previousPorts);
          for (const portKey of previousPorts) {
            portUse.set(portKey, (portUse.get(portKey) || 0) + 1);
          }
        }
      }

      return lengthenTerminalApproaches(straightenKinks(nudgeSections(sections)));
    }

    return { routeAll, graph };
  }

  function routeAllEdges(options) {
    return createRouter(options).routeAll();
  }

  return { WEIGHTS, createRouter, routeAllEdges };
})();
