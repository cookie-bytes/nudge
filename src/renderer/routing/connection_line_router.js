window.NudgeRenderer.routeSetAnalysis = {
  createEvaluator({
    allEdges,
    children,
    extNodes = [],
    getAbs,
    getSz,
    bndX,
    bndY,
    childPos,
    routedEdgeSegments,
    sectionToPoints,
    pointsToSegments,
    lineSegmentIntersectsRect,
    internalBoundaryClearanceHits,
    sourceReservedDropCrossings,
    segmentOverlapLength,
    segmentParallelProximity,
    segmentsCross,
    canBundleEdges
  }) {
    function sectionRouteLength(section) {
      return pointsToSegments(sectionToPoints(section))
        .reduce((sum, segment) => {
          const dx = segment.b.x - segment.a.x;
          const dy = segment.b.y - segment.a.y;
          return sum + Math.sqrt(dx * dx + dy * dy);
        }, 0);
    }

    function sectionNodeCrossings(section, edge) {
      let crossings = 0;
      const allNodes = [...children, ...extNodes];
      for (const segment of pointsToSegments(sectionToPoints(section))) {
        for (const node of allNodes) {
          if (node.id === edge.from || node.id === edge.to) continue;
          const pos = getAbs(node.id);
          const sz = getSz(node.id);
          const rect = { x: pos.x, y: pos.y, width: sz.w, height: sz.h };
          if (lineSegmentIntersectsRect(segment.a, segment.b, rect)) {
            crossings++;
            break;
          }
        }
      }
      return crossings;
    }

    function setRoutedSegmentsForSections(sections, excludeIndex = -1) {
      routedEdgeSegments.length = 0;
      sections.forEach((section, idx) => {
        if (!section || idx === excludeIndex) return;
        routedEdgeSegments.push(...pointsToSegments(sectionToPoints(section), idx));
      });
    }

    function evaluateRouteSet(sections) {
      const edgeScores = sections.map((section, idx) => ({
        idx,
        nodeCrossings: sectionNodeCrossings(section, allEdges[idx]),
        edgeCrossings: 0,
        edgeOverlaps: 0,
        edgeOverlapPx: 0,
        closeParallels: 0,
        closePx: 0,
        boundaryHits: 0,
        sourceDropCrossings: 0,
        routeLength: sectionRouteLength(section)
      }));
      const segmentsByEdge = sections.map(section => pointsToSegments(sectionToPoints(section)));

      for (let i = 0; i < segmentsByEdge.length; i++) {
        edgeScores[i].boundaryHits = internalBoundaryClearanceHits(segmentsByEdge[i], allEdges[i]);
        edgeScores[i].sourceDropCrossings = sourceReservedDropCrossings(segmentsByEdge[i], allEdges[i]);
      }

      for (let i = 0; i < segmentsByEdge.length; i++) {
        for (let j = i + 1; j < segmentsByEdge.length; j++) {
          for (const segA of segmentsByEdge[i]) {
            for (const segB of segmentsByEdge[j]) {
              const overlapPx = segmentOverlapLength(segA, segB);
              if (overlapPx > 20) {
                if (canBundleEdges(allEdges[i], allEdges[j])) continue;
                edgeScores[i].edgeOverlaps++;
                edgeScores[j].edgeOverlaps++;
                edgeScores[i].edgeOverlapPx += overlapPx;
                edgeScores[j].edgeOverlapPx += overlapPx;
              } else if (segmentsCross(segA, segB)) {
                edgeScores[i].edgeCrossings++;
                edgeScores[j].edgeCrossings++;
              } else {
                const closePx = segmentParallelProximity(segA, segB);
                if (closePx > 20) {
                  if (canBundleEdges(allEdges[i], allEdges[j])) continue;
                  edgeScores[i].closeParallels++;
                  edgeScores[j].closeParallels++;
                  edgeScores[i].closePx += closePx;
                  edgeScores[j].closePx += closePx;
                }
              }
            }
          }
        }
      }

      const totals = edgeScores.reduce((acc, edgeScore) => {
        acc.nodeCrossings += edgeScore.nodeCrossings;
        acc.edgeCrossings += edgeScore.edgeCrossings;
        acc.edgeOverlaps += edgeScore.edgeOverlaps;
        acc.edgeOverlapPx += edgeScore.edgeOverlapPx;
        acc.closeParallels += edgeScore.closeParallels;
        acc.closePx += edgeScore.closePx;
        acc.boundaryHits += edgeScore.boundaryHits;
        acc.sourceDropCrossings += edgeScore.sourceDropCrossings;
        acc.totalRouteLength += edgeScore.routeLength;
        edgeScore.score =
          edgeScore.nodeCrossings * 100000 +
          edgeScore.boundaryHits * 5000 +
          edgeScore.sourceDropCrossings * 900 +
          edgeScore.edgeOverlaps * 600 +
          edgeScore.edgeOverlapPx * 2 +
          edgeScore.closeParallels * 450 +
          edgeScore.closePx +
          edgeScore.edgeCrossings * 180 +
          edgeScore.routeLength * 0.01;
        return acc;
      }, {
        nodeCrossings: 0,
        edgeCrossings: 0,
        edgeOverlaps: 0,
        edgeOverlapPx: 0,
        closeParallels: 0,
        closePx: 0,
        boundaryHits: 0,
        sourceDropCrossings: 0,
        totalRouteLength: 0
      });

      totals.edgeScores = edgeScores;
      totals.score =
        totals.nodeCrossings * 100000 +
        totals.boundaryHits * 5000 +
        totals.sourceDropCrossings * 900 +
        totals.edgeOverlaps * 600 +
        totals.edgeOverlapPx * 2 +
        totals.closeParallels * 450 +
        totals.closePx +
        totals.edgeCrossings * 180 +
        totals.totalRouteLength * 0.01;
      return totals;
    }

    return {
      sectionRouteLength,
      sectionNodeCrossings,
      setRoutedSegmentsForSections,
      evaluateRouteSet
    };
  }
};

window.NudgeRenderer.connectionLineRouter = {
  computeHubPortAssignments({
    children,
    allEdges,
    getAbs,
    getSz,
    portHints,
    rightSet,
    leftSet,
    MIN_ROUTE_LINE_GAP
  }) {
    const assignments = new Map();
    const busNodes = children.filter(n => n.type === 'message_bus');
    for (const bus of busNodes) {
      const bp = getAbs(bus.id);
      const bs = getSz(bus.id);
      const faceGroups = { TOP: [], BOTTOM: [], LEFT: [], RIGHT: [] };
      allEdges.forEach((e, idx) => {
        if (e.from !== bus.id && e.to !== bus.id) return;
        const otherId = e.from === bus.id ? e.to : e.from;
        const op = getAbs(otherId);
        const os = getSz(otherId);
        const otherCx = op.x + os.w / 2;
        const otherCy = op.y + os.h / 2;
        const hint = portHints[`edge_${idx}`] || portHints[idx] || {};
        const hintedFace = e.from === bus.id ? hint.sourceSide : hint.targetSide;
        if (['TOP', 'BOTTOM', 'LEFT', 'RIGHT'].includes(hintedFace)) {
          const sortKey = (hintedFace === 'TOP' || hintedFace === 'BOTTOM') ? otherCx : otherCy;
          faceGroups[hintedFace].push({ idx, sortKey, sideSortKey: otherCy, hinted: true });
          return;
        }

        // Zone-aware: external nodes in the left/right zones approach the bus
        // from the side, not from above — assign them to the matching face so
        // their port slots don't displace the internal-node TOP face ordering.
        if (rightSet.has(otherId)) {
          faceGroups.RIGHT.push({ idx, sortKey: otherCy, sideSortKey: otherCy });
        } else if (leftSet.has(otherId)) {
          faceGroups.LEFT.push({ idx, sortKey: otherCy, sideSortKey: otherCy });
        } else if (op.y + os.h <= bp.y + 4) {
          faceGroups.TOP.push({ idx, sortKey: otherCx, sideSortKey: otherCy });
        } else if (op.y >= bp.y + bs.h - 4) {
          faceGroups.BOTTOM.push({ idx, sortKey: otherCx, sideSortKey: otherCy });
        } else if (otherCx < bp.x + bs.w / 2) {
          faceGroups.LEFT.push({ idx, sortKey: otherCy, sideSortKey: otherCy });
        } else {
          faceGroups.RIGHT.push({ idx, sortKey: otherCy, sideSortKey: otherCy });
        }
      });
      for (const [face, edges] of Object.entries(faceGroups)) {
        if (!edges.length) continue;
        edges.sort((a, b) => a.sortKey - b.sortKey);

        // TOP/BOTTOM: map node x-centres proportionally onto the bus face so each
        // connection lands near its natural drop-point, minimising horizontal jog.
        // A forward+backward pass enforces a minimum gap when nodes share x-centres.
        let topBotPortX = null;
        if (face === 'TOP' || face === 'BOTTOM') {
          const busLo = bp.x + bs.w * 0.05;
          const busHi = bp.x + bs.w * 0.95;
          const minGap = (busHi - busLo) / (edges.length + 1);
          const lo = edges[0].sortKey, hi = edges[edges.length - 1].sortKey;
          topBotPortX = edges.map(e =>
            hi === lo ? (busLo + busHi) / 2
                      : busLo + ((e.sortKey - lo) / (hi - lo)) * (busHi - busLo)
          );
          for (let i = 1; i < topBotPortX.length; i++) {
            if (topBotPortX[i] < topBotPortX[i - 1] + minGap)
              topBotPortX[i] = topBotPortX[i - 1] + minGap;
          }
          if (topBotPortX[topBotPortX.length - 1] > busHi) {
            topBotPortX[topBotPortX.length - 1] = busHi;
            for (let i = topBotPortX.length - 2; i >= 0; i--) {
              if (topBotPortX[i] > topBotPortX[i + 1] - minGap)
                topBotPortX[i] = topBotPortX[i + 1] - minGap;
            }
          }
        }

        const rightCapThreshold = bp.x + bs.w - Math.max(MIN_ROUTE_LINE_GAP * 2, bs.w * 0.08);
        edges.forEach((edge, i) => {
          const { idx } = edge;
          const t = (i + 1) / (edges.length + 1);
          let x, y;
          if (face === 'TOP') {
            x = topBotPortX[i];
            y = bp.y;
            if (x >= rightCapThreshold) {
              faceGroups.RIGHT.push({
                idx,
                sortKey: edge.sideSortKey ?? edge.sortKey,
                sideSortKey: edge.sideSortKey ?? edge.sortKey
              });
              return;
            }
          }
          if (face === 'BOTTOM') { x = topBotPortX[i]; y = bp.y + bs.h; }
          if (face === 'LEFT')   { x = bp.x;            y = bp.y + bs.h * t; }
          if (face === 'RIGHT')  { x = bp.x + bs.w;     y = bp.y + bs.h * t; }
          assignments.set(idx, { busId: bus.id, face, x, y });
        });
      }
    }
    return assignments;
  },

  computeSideCorridorAssignments({
    allEdges,
    rightSet,
    leftSet,
    childIds,
    getAbs,
    getSz,
    bndX,
    bndW,
    rightCorrGap,
    leftCorrGap
  }) {
    const assignments = new Map(); // edgeIdx → { corridorX, startY }

    function sideNodeId(e) {
      return (rightSet.has(e.from) || leftSet.has(e.from)) ? e.from : e.to;
    }

    function processGroup(edgeIndices, corridorStart, direction, corrGap) {
      const N = edgeIndices.length;
      if (N <= 1) return;
      // Sort by the y-centre of the side (right/left) node so corridor slots
      // and exit y-positions stay consistently ordered, avoiding crossings.
      const sorted = [...edgeIndices].sort((a, b) => {
        const pa = getAbs(sideNodeId(allEdges[a])), pb = getAbs(sideNodeId(allEdges[b]));
        const sa = getSz(sideNodeId(allEdges[a])),  sb = getSz(sideNodeId(allEdges[b]));
        return (pa.y + sa.h / 2) - (pb.y + sb.h / 2);
      });
      const step = corrGap / (N + 1);
      sorted.forEach((idx, i) => {
        assignments.set(idx, { corridorX: corridorStart + direction * step * (i + 1), startY: null });
      });

      // When multiple inside→side edges share the same inside source, their
      // horizontal exit segments (source-right-edge → corridorX) would overlap
      // at sCy. Distribute the exit y-positions across the source's right face
      // so each segment is at a distinct y, eliminating the overlap.
      const bySource = new Map();
      sorted.forEach(idx => {
        const e = allEdges[idx];
        const insideId = childIds.has(e.from) ? e.from : null;
        if (!insideId) return;
        if (!bySource.has(insideId)) bySource.set(insideId, []);
        bySource.get(insideId).push(idx);
      });
      for (const [insideId, edgeIds] of bySource) {
        if (edgeIds.length <= 1) continue;
        const sp = getAbs(insideId), ss = getSz(insideId);
        // edgeIds are already in side-node-y order (from sorted above)
        edgeIds.forEach((idx, i) => {
          const existing = assignments.get(idx);
          assignments.set(idx, { ...existing, startY: sp.y + ss.h * (i + 1) / (edgeIds.length + 1) });
        });
      }
    }

    const rightEdgeIndices = [];
    const leftEdgeIndices  = [];
    allEdges.forEach((e, idx) => {
      if (rightSet.has(e.from) || rightSet.has(e.to)) rightEdgeIndices.push(idx);
      else if (leftSet.has(e.from) || leftSet.has(e.to)) leftEdgeIndices.push(idx);
    });
    processGroup(rightEdgeIndices, bndX + bndW, +1, rightCorrGap);
    processGroup(leftEdgeIndices,  bndX,        -1, leftCorrGap);

    return assignments;
  },

  createRouteSelector({
    routeIntent,
    targetNode,
    routeCrossingCount,
    routeEdgeConflictStats,
    routeLength,
    routeDiagonalLength,
    preferVerticalEntry = false,
    debugTag = null
  }) {
    const debugActive = () => debugTag && window.__nudgeDebugRoute === debugTag;
    function chooseBestRoute(candidates) {
      const orthogonalHintActive = !(targetNode && targetNode.type === 'database') && (
        routeIntent === 'LEFT_LANE' ||
        routeIntent === 'RIGHT_LANE' ||
        routeIntent === 'ORTHOGONAL_NEAR_TARGET'
      );
      return candidates
        .filter(Boolean)
        .map(route => window.NudgeRenderer.routeGeometry.orthogonalizeSection(route, preferVerticalEntry))
        .map((route, order) => ({
          route,
          order,
          crossings: routeCrossingCount(route),
          ...routeEdgeConflictStats(route),
          bends: route.bendPoints ? route.bendPoints.length : 0,
          length: routeLength(route) + (route._scoreBias || 0),
          diagonalLength: orthogonalHintActive ? routeDiagonalLength(route) : 0
        }))
        .map(candidate => ({
          ...candidate,
          score:
            candidate.edgeOverlaps * 80 +
            candidate.edgeOverlapPx * 0.5 +
            candidate.closeParallels * 65 +
            candidate.closePx * 0.35 +
            candidate.boundaryHits * 900 +
            candidate.sourceDropCrossings * 900 +
            candidate.edgeCrossings * 120 +
            candidate.sourcePortReuses * 90 +
            candidate.diagonalLength * 1.3 +
            candidate.bends * 45 +
            candidate.length
        }))
        .sort((a, b) =>
          a.crossings - b.crossings ||
          a.score - b.score ||
          a.order - b.order
        )
        .map((candidate, rank) => {
          if (debugActive()) {
            const { route, ...stats } = candidate;
            const pts = [route.startPoint, ...(route.bendPoints || []), route.endPoint]
              .map(p => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' ');
            console.log(`[RouteDebug ${debugTag}] #${rank} ${JSON.stringify(stats)} pts: ${pts}`);
          }
          return candidate;
        })
        .map(({ route }) => {
          const { _scoreBias, ...cleanRoute } = route;
          return cleanRoute;
        })[0];
    }

    function chooseBestRouteWithStandardGuard(candidates, standard) {
      standard = window.NudgeRenderer.routeGeometry.orthogonalizeSection(standard, preferVerticalEntry);
      const chosen = chooseBestRoute(candidates);
      if (!routeIntent || !chosen || chosen === standard) return chosen;

      const chosenConflicts = routeEdgeConflictStats(chosen);
      const standardConflicts = routeEdgeConflictStats(standard);
      if (
        routeCrossingCount(chosen) > routeCrossingCount(standard) ||
        chosenConflicts.edgeCrossings > standardConflicts.edgeCrossings ||
        chosenConflicts.edgeOverlaps > standardConflicts.edgeOverlaps ||
        chosenConflicts.boundaryHits > standardConflicts.boundaryHits ||
        chosenConflicts.sourceDropCrossings > standardConflicts.sourceDropCrossings
      ) {
        return standard;
      }
      return chosen;
    }

    return {
      chooseBestRoute,
      chooseBestRouteWithStandardGuard
    };
  },

  createLaneReserver({
    sectionToPoints,
    pointsToSection,
    clonePoints,
    routedEdgeSegments,
    edgeConflictScore,
    LANE_OFFSETS,
    LANE_OVERLAP_THRESHOLD,
    getAbs,
    getSz,
    getNode
  }) {
    function shiftSegment(points, segmentIndex, offset) {
      const shifted = clonePoints(points);
      const p1 = shifted[segmentIndex];
      const p2 = shifted[segmentIndex + 1];
      if (Math.abs(p1.x - p2.x) < 2) {
        p1.x += offset;
        p2.x += offset;
      } else if (Math.abs(p1.y - p2.y) < 2) {
        p1.y += offset;
        p2.y += offset;
      }
      return shifted;
    }

    function reserveRouteLanes(section, edge) {
      let preferVerticalEntry = false;
      if (edge && getNode && getAbs && getSz) {
        const targetNode = getNode(edge.to);
        if (targetNode && targetNode.type === 'database') {
          const sp = getAbs(edge.from);
          const tp = getAbs(edge.to);
          const ss = getSz(edge.from);
          const ts = getSz(edge.to);
          if (sp && tp && ss && ts) {
            preferVerticalEntry = (tp.y >= sp.y + ss.h - 2 || sp.y >= tp.y + ts.h - 2);
          }
        }
      }
      section = window.NudgeRenderer.routeGeometry.orthogonalizeSection(section, preferVerticalEntry);
      let points = sectionToPoints(section);
      if (points.length < 4 || routedEdgeSegments.length === 0) return section;

      for (let i = 1; i < points.length - 2; i++) {
        const current = { a: points[i], b: points[i + 1] };
        const isAxisAligned = Math.abs(current.a.x - current.b.x) < 2 ||
                              Math.abs(current.a.y - current.b.y) < 2;
        if (!isAxisAligned) continue;

        const currentStats = edgeConflictScore(points, edge);
        if (
          currentStats.overlaps === 0 &&
          currentStats.closeParallels === 0 &&
          currentStats.crossings === 0 &&
          currentStats.boundaryHits === 0 &&
          currentStats.sourceDropCrossings === 0
        ) continue;
        if (
          currentStats.crossings === 0 &&
          currentStats.boundaryHits === 0 &&
          currentStats.sourceDropCrossings === 0 &&
          currentStats.overlapPx < LANE_OVERLAP_THRESHOLD &&
          currentStats.closePx < LANE_OVERLAP_THRESHOLD
        ) continue;

        let best = { points, score: currentStats.score, offset: 0 };
        for (const offset of LANE_OFFSETS.slice(1)) {
          const candidatePoints = shiftSegment(points, i, offset);
          const stats = edgeConflictScore(candidatePoints, edge);
          const score = stats.score + Math.abs(offset) * 2;
          if (score < best.score) {
            best = { points: candidatePoints, score, offset };
          }
        }
        if (best.offset !== 0) points = best.points;
      }

      return pointsToSection(points);
    }

    return {
      shiftSegment,
      reserveRouteLanes
    };
  },

  createEdgeRouter({
    getAbs,
    getSz,
    getNode,
    incomingEdges,
    outgoingEdges,
    allEdges,
    hubPortAssignments,
    sideCorridorAssignments,
    routeHints,
    children,
    childPos,
    bndX,
    bndY,
    V_GAP,
    MIN_ROUTE_LINE_GAP,
    leftSet,
    rightSet,
    childIds,
    lineSegmentIntersectsRect,
    internalBoundaryClearanceHits,
    sourceReservedDropCrossings,
    routedEdgeSegments,
    canBundleEdges,
    candidateRules,
    extNodes = []
  }) {
  function routeEdge(e, idx) {
    const sp = getAbs(e.from), tp = getAbs(e.to);
    const ss = getSz(e.from),  ts = getSz(e.to);

    // Distribute entry and exit points horizontally to prevent overlaps
    const inEdges = incomingEdges.get(e.to) || [idx];
    const targetNode = getNode(e.to);
    const targetCenterX = tp.x + ts.w / 2;

    const directDropSpecification = window.NudgeRenderer.routeSpecifications.createDirectDropSpecification({
      allEdges,
      getNode,
      getAbs,
      getSz
    });
    const {
      isPaired,
      isDirectPairedEntry,
      isCenterReservedDbEdge
    } = directDropSpecification;

    let entryX = tp.x + ts.w / 2;
    if (inEdges.length > 1) {
      if (targetNode && targetNode.type === 'message_bus' && !targetNode.local) {
        const hubAssign = hubPortAssignments.get(idx);
        if (hubAssign) {
          entryX = hubAssign.x;
        } else {
          const orderedInEdges = [...inEdges].sort((a, b) => {
            const edgeA = allEdges[a];
            const edgeB = allEdges[b];
            const posA = getAbs(edgeA.from);
            const posB = getAbs(edgeB.from);
            const sizeA = getSz(edgeA.from);
            const sizeB = getSz(edgeB.from);
            const cxA = posA.x + sizeA.w / 2;
            const cxB = posB.x + sizeB.w / 2;
            if (Math.abs(cxA - cxB) > 1) return cxA - cxB;
            return posA.y - posB.y;
          });
          const inIdx = orderedInEdges.indexOf(idx);
          if (inIdx !== -1) entryX = tp.x + (ts.w / (orderedInEdges.length + 1)) * (inIdx + 1);
        }
      } else if (isPaired(targetNode) && inEdges.some(isDirectPairedEntry) && !isDirectPairedEntry(idx)) {
        const srcCenterX = sp.x + ss.w / 2;
        entryX = srcCenterX > targetCenterX
          ? tp.x + ts.w / 3
          : tp.x + ts.w * 2 / 3;
      } else {
        const inIdx = inEdges.indexOf(idx);
        if (inIdx !== -1) entryX = tp.x + (ts.w / (inEdges.length + 1)) * (inIdx + 1);
      }
    }

    const outEdges = outgoingEdges.get(e.from) || [idx];
    const orderedOutEdges = [...outEdges].sort((a, b) => {
      const edgeA = allEdges[a];
      const edgeB = allEdges[b];
      const posA = getAbs(edgeA.to);
      const posB = getAbs(edgeB.to);
      const sizeA = getSz(edgeA.to);
      const sizeB = getSz(edgeB.to);
      return (posA.x + sizeA.w / 2) - (posB.x + sizeB.w / 2);
    });
    const outIdx = orderedOutEdges.indexOf(idx);
    const outCount = orderedOutEdges.length;
    let exitX = (outCount > 1 && outIdx !== -1) ? sp.x + (ss.w / (outCount + 1)) * (outIdx + 1) : (sp.x + ss.w / 2);

    const sourceCenterX = sp.x + ss.w / 2;
    const centerReservedByDbEdges = outEdges.filter(edgeIdx =>
      isCenterReservedDbEdge(edgeIdx, { sp, ss, sourceCenterX })
    );

    if (centerReservedByDbEdges.length > 0 && !centerReservedByDbEdges.includes(idx)) {
      const sideEdgeIndices = outEdges.filter(edgeIdx => !centerReservedByDbEdges.includes(edgeIdx));
      const sideIdx = sideEdgeIndices.indexOf(idx);
      const sideSlots = sideEdgeIndices.length === 1
        ? [(() => {
            const targetPos = getAbs(e.to);
            const targetSize = getSz(e.to);
            const targetCenterX = targetPos.x + targetSize.w / 2;
            return targetCenterX < sourceCenterX ? sp.x + ss.w * 0.25 : sp.x + ss.w * 0.75;
          })()]
        : sideEdgeIndices.map((_, slotIdx) => {
            const t = sideEdgeIndices.length === 1 ? 0.5 : slotIdx / (sideEdgeIndices.length - 1);
            return sp.x + ss.w * (0.25 + t * 0.5);
          });
      if (sideIdx !== -1) exitX = sideSlots[sideIdx];
    }

    const scx = exitX;
    const tcx = entryX;
    const routeHint = routeHints[`edge_${idx}`] || routeHints[idx] || {};
    const routeIntent = routeHint.routeIntent || routeHint.intent || null;
    const sBot = sp.y + ss.h,    tTop = tp.y;
    const sTop = sp.y,           tBot = tp.y + ts.h;
    const sCy  = sp.y + ss.h / 2, tCy = tp.y + ts.h / 2;
    const targetHubAssign = targetNode && targetNode.type === 'message_bus'
      ? hubPortAssignments.get(idx)
      : null;
    const targetEntryY = targetHubAssign ? targetHubAssign.y : null;

    function routeCrossingCount(route) {
      let crossings = 0;
      const pts = [route.startPoint, ...(route.bendPoints || []), route.endPoint];
      const allNodes = [...children, ...extNodes];
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i], p2 = pts[i+1];
        for (const node of allNodes) {
          if (node.id === e.from || node.id === e.to) continue;
          const pos = getAbs(node.id);
          const sz = getSz(node.id);
          const rect = { x: pos.x, y: pos.y, width: sz.w, height: sz.h };
          if (lineSegmentIntersectsRect(p1, p2, rect)) {
            crossings++;
            break;
          }
        }
      }
      return crossings;
    }
    function checkCollision(route) {
      return routeCrossingCount(route) > 0;
    }
    function directDatabaseDropRoute() {
      return directDropSpecification.directDatabaseDropRoute({
        e,
        sp,
        tp,
        ss,
        ts,
        sBot,
        tTop,
        checkCollision
      });
    }
    function routeLength(route) {
      const pts = [route.startPoint, ...(route.bendPoints || []), route.endPoint];
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x;
        const dy = pts[i + 1].y - pts[i].y;
        len += Math.sqrt(dx * dx + dy * dy);
      }
      return len;
    }
    function routeDiagonalLength(route) {
      const pts = [route.startPoint, ...(route.bendPoints || []), route.endPoint];
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x;
        const dy = pts[i + 1].y - pts[i].y;
        if (Math.abs(dx) > 2 && Math.abs(dy) > 2) {
          len += Math.sqrt(dx * dx + dy * dy);
        }
      }
      return len;
    }
    function routeSegments(route) {
      const pts = [route.startPoint, ...(route.bendPoints || []), route.endPoint];
      return pts.slice(0, -1).map((p, i) => ({ a: p, b: pts[i + 1] }));
    }
    function pointsNear(a, b, tolerance = 2) {
      return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
    }
    function segmentOrientation(a, b, c) {
      return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    function pointOnSegment(a, b, p) {
      return (
        p.x >= Math.min(a.x, b.x) - 1 &&
        p.x <= Math.max(a.x, b.x) + 1 &&
        p.y >= Math.min(a.y, b.y) - 1 &&
        p.y <= Math.max(a.y, b.y) + 1 &&
        Math.abs(segmentOrientation(a, b, p)) < 1
      );
    }
    function routeSegmentCrosses(segA, segB) {
      const a = segA.a, b = segA.b, c = segB.a, d = segB.b;
      if (pointsNear(a, c) || pointsNear(a, d) || pointsNear(b, c) || pointsNear(b, d)) {
        return false;
      }
      const o1 = segmentOrientation(a, b, c);
      const o2 = segmentOrientation(a, b, d);
      const o3 = segmentOrientation(c, d, a);
      const o4 = segmentOrientation(c, d, b);
      if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
          ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
        return true;
      }
      return pointOnSegment(a, b, c) || pointOnSegment(a, b, d) ||
             pointOnSegment(c, d, a) || pointOnSegment(c, d, b);
    }
    function routeSegmentOverlapLength(segA, segB) {
      const a = segA.a, b = segA.b, c = segB.a, d = segB.b;
      const aHorizontal = Math.abs(a.y - b.y) < 2;
      const bHorizontal = Math.abs(c.y - d.y) < 2;
      const aVertical = Math.abs(a.x - b.x) < 2;
      const bVertical = Math.abs(c.x - d.x) < 2;
      if (aHorizontal && bHorizontal && Math.abs(a.y - c.y) < 6) {
        const lo = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
        const hi = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
        return Math.max(0, hi - lo);
      }
      if (aVertical && bVertical && Math.abs(a.x - c.x) < 6) {
        const lo = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
        const hi = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
        return Math.max(0, hi - lo);
      }
      return 0;
    }
    function routeSegmentParallelProximity(segA, segB) {
      const a = segA.a, b = segA.b, c = segB.a, d = segB.b;
      const aHorizontal = Math.abs(a.y - b.y) < 2;
      const bHorizontal = Math.abs(c.y - d.y) < 2;
      const aVertical = Math.abs(a.x - b.x) < 2;
      const bVertical = Math.abs(c.x - d.x) < 2;
      if (aHorizontal && bHorizontal) {
        const distance = Math.abs(a.y - c.y);
        if (distance < 6 || distance >= MIN_ROUTE_LINE_GAP) return 0;
        const lo = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
        const hi = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
        return Math.max(0, hi - lo);
      }
      if (aVertical && bVertical) {
        const distance = Math.abs(a.x - c.x);
        if (distance < 6 || distance >= MIN_ROUTE_LINE_GAP) return 0;
        const lo = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
        const hi = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
        return Math.max(0, hi - lo);
      }
      return 0;
    }
    function routeEdgeConflictStats(route) {
      const segments = routeSegments(route);
      let edgeCrossings = 0;
      let edgeOverlaps = 0;
      let edgeOverlapPx = 0;
      let closeParallels = 0;
      let closePx = 0;
      const boundaryHits = internalBoundaryClearanceHits(segments, e);
      const sourceDropCrossings = sourceReservedDropCrossings(segments, e);
      let sourcePortReuses = 0;
      const start = route.startPoint;
      if (start) {
        for (const existingSeg of routedEdgeSegments) {
          if (
            allEdges[existingSeg.edgeIndex]?.from === e.from &&
            Math.hypot(start.x - existingSeg.a.x, start.y - existingSeg.a.y) < 6
          ) {
            sourcePortReuses++;
            break;
          }
        }
      }
      for (const candidateSeg of segments) {
        for (const existingSeg of routedEdgeSegments) {
          const overlapPx = routeSegmentOverlapLength(candidateSeg, existingSeg);
          if (overlapPx > 20) {
            if (canBundleEdges(e, allEdges[existingSeg.edgeIndex])) continue;
            edgeOverlaps++;
            edgeOverlapPx += overlapPx;
          } else if (routeSegmentCrosses(candidateSeg, existingSeg)) {
            edgeCrossings++;
          } else {
            const close = routeSegmentParallelProximity(candidateSeg, existingSeg);
            if (close > 20) {
              if (canBundleEdges(e, allEdges[existingSeg.edgeIndex])) continue;
              closeParallels++;
              closePx += close;
            }
          }
        }
      }
      return { edgeCrossings, edgeOverlaps, edgeOverlapPx, closeParallels, closePx, boundaryHits, sourceDropCrossings, sourcePortReuses };
    }
    function horizontalLaneBelowSource() {
      const nextTop = children
        .filter(child => child.id !== e.from && child.id !== e.to)
        .map(child => bndY + childPos[child.id].y)
        .filter(y => y >= sBot)
        .sort((a, b) => a - b)[0];
      return nextTop === undefined ? sBot + V_GAP / 2 : (sBot + nextTop) / 2;
    }
    function horizontalLaneAboveTarget() {
      const prevBottom = children
        .filter(child => child.id !== e.from && child.id !== e.to)
        .map(child => bndY + childPos[child.id].y + (child.height || 80))
        .filter(y => y <= tTop)
        .sort((a, b) => b - a)[0];
      return prevBottom === undefined ? tTop - V_GAP / 2 : (prevBottom + tTop) / 2;
    }
    function horizontalLaneAboveSource() {
      const prevBottom = children
        .filter(child => child.id !== e.from && child.id !== e.to)
        .map(child => bndY + childPos[child.id].y + (child.height || 80))
        .filter(y => y <= sTop)
        .sort((a, b) => b - a)[0];
      return prevBottom === undefined ? sTop - V_GAP / 2 : (prevBottom + sTop) / 2;
    }
    function horizontalLaneBelowTarget() {
      const nextTop = children
        .filter(child => child.id !== e.from && child.id !== e.to)
        .map(child => bndY + childPos[child.id].y)
        .filter(y => y >= tBot)
        .sort((a, b) => a - b)[0];
      return nextTop === undefined ? tBot + V_GAP / 2 : (tBot + nextTop) / 2;
    }
    function sourceTopSlot(slot = 0.75) {
      return sp.x + ss.w * slot;
    }
    function sourceBottomSlot(slot = 0.75) {
      return sp.x + ss.w * slot;
    }
    function sourceSafeBottomExitXs(preferRight) {
      return candidateRules.sourceSafeBottomExitXs({ e, sp, ss, scx }, preferRight);
    }
    function orderedMessageBusGutterX(preferRight) {
      return candidateRules.orderedMessageBusGutterX({ e, idx, targetNode, tp, ts }, preferRight);
    }
    function sideExternalRouteCandidates() {
      return candidateRules.sideExternalRouteCandidates({
        sp,
        tp,
        ss,
        ts,
        sTop,
        sBot,
        sCy,
        tCy,
        sourceTopSlot,
        sourceBottomSlot
      });
    }
    function targetFacingRouteCandidates() {
      return candidateRules.targetFacingRouteCandidates({
        sp,
        tp,
        ss,
        ts,
        sTop,
        sBot,
        sCy,
        tCy,
        horizontalLaneBelowSource,
        horizontalLaneAboveSource,
        routeEdgeConflictStats,
        checkCollision
      });
    }
    function hintedOrthogonalRouteCandidates(sourceY, endY, sourceLane, targetLane, sourcePortXs = [scx]) {
      return candidateRules.hintedOrthogonalRouteCandidates(
        { routeIntent, targetNode, tcx, tp, ts, orderedMessageBusGutterX },
        sourceY,
        endY,
        sourceLane,
        targetLane,
        sourcePortXs
      );
    }
    const preferVerticalEntry = targetNode && targetNode.type === 'database' &&
      (tp.y >= sp.y + ss.h - 2 || sp.y >= tp.y + ts.h - 2);

    const {
      chooseBestRoute,
      chooseBestRouteWithStandardGuard
    } = window.NudgeRenderer.connectionLineRouter.createRouteSelector({
      routeIntent,
      targetNode,
      routeCrossingCount,
      routeEdgeConflictStats,
      routeLength,
      routeDiagonalLength,
      preferVerticalEntry,
      debugTag: `${e.from}->${e.to}`
    });

    // Horizontal Z/S-curve routing for left/right column nodes
    const standardRoute = candidateRules.standardRouteCandidate({
      e,
      idx,
      sp,
      tp,
      ss,
      ts,
      scx,
      tcx,
      sCy,
      tCy,
      sTop,
      sBot,
      tTop,
      tBot,
      targetEntryY,
      sideCorridorAssignments,
      directDatabaseDropRoute,
      checkCollision
    });

    const standardRouteConflicts = routeEdgeConflictStats(standardRoute);
    if (
      (leftSet.has(e.from) || rightSet.has(e.from) || leftSet.has(e.to) || rightSet.has(e.to)) &&
      (
        checkCollision(standardRoute) ||
        standardRouteConflicts.edgeCrossings > 0 ||
        standardRouteConflicts.edgeOverlaps > 0
      )
    ) {
      const candidates = [standardRoute, ...sideExternalRouteCandidates()];
      candidates.push(...candidateRules.sideExternalZSCurveCandidates({ sp, tp, ss, ts, sCy, tCy }));
      return chooseBestRouteWithStandardGuard(candidates, standardRoute);
    }

    if ((leftSet.has(e.to) || rightSet.has(e.to)) && childIds.has(e.from)) {
      if (sideCorridorAssignments.has(idx)) return standardRoute;
      const candidates = [standardRoute, ...sideExternalRouteCandidates()];
      if (candidates.length > 1) return chooseBestRoute(candidates);
    }

    if (childIds.has(e.from) && childIds.has(e.to)) {
      const directDbRoute = directDatabaseDropRoute();
      if (directDbRoute) return directDbRoute;

      const candidates = [standardRoute, ...targetFacingRouteCandidates()];
      if (tp.y >= sp.y + ss.h - 2) {
        candidates.push(...candidateRules.internalBelowTargetRouteCandidates({
          scx,
          tcx,
          sBot,
          tTop,
          targetEntryY,
          routeIntent,
          horizontalLaneBelowSource,
          horizontalLaneAboveTarget,
          orderedMessageBusGutterX,
          sourceSafeBottomExitXs,
          hintedOrthogonalRouteCandidates,
          sp,
          tp,
          ss,
          ts,
          sCy
        }));
      } else if (sp.y >= tp.y + ts.h - 2) {
        candidates.push(...candidateRules.internalAboveTargetRouteCandidates({
          scx,
          tcx,
          sTop,
          tBot,
          targetEntryY,
          routeIntent,
          horizontalLaneAboveSource,
          horizontalLaneBelowTarget,
          orderedMessageBusGutterX,
          hintedOrthogonalRouteCandidates,
          sp,
          tp,
          ss,
          ts,
          sCy
        }));
      }
      return chooseBestRouteWithStandardGuard(candidates, standardRoute);
    }

    return standardRoute;
  }

    return {
      routeEdge
    };
  },

  createImprover({
    allEdges,
    setRoutedSegmentsForSections,
    reserveRouteLanes,
    routeEdge,
    evaluateRouteSet
  }) {
    function improveRoutedSections(sections) {
      let current = evaluateRouteSet(sections);
      const maxReroutes = Math.min(5, Math.ceil(allEdges.length * 0.2));
      const candidates = [...current.edgeScores]
        .filter(edgeScore =>
          edgeScore.edgeCrossings > 0 ||
          edgeScore.edgeOverlaps > 0 ||
          edgeScore.closeParallels > 0 ||
          edgeScore.boundaryHits > 0 ||
          edgeScore.sourceDropCrossings > 0 ||
          edgeScore.nodeCrossings > 0
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, maxReroutes);

      for (const candidate of candidates) {
        setRoutedSegmentsForSections(sections, candidate.idx);
        const rerouted = reserveRouteLanes(routeEdge(allEdges[candidate.idx], candidate.idx), allEdges[candidate.idx]);
        const nextSections = [...sections];
        nextSections[candidate.idx] = rerouted;
        const next = evaluateRouteSet(nextSections);
        const routeLengthLimit = current.totalRouteLength * 1.12;

        if (
          next.nodeCrossings <= current.nodeCrossings &&
          next.totalRouteLength <= routeLengthLimit &&
          next.score < current.score - 1
        ) {
          sections[candidate.idx] = rerouted;
          current = next;
        }
      }

      setRoutedSegmentsForSections(sections);
      return sections;
    }

    return {
      improveRoutedSections
    };
  }
};
