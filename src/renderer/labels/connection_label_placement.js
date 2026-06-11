window.NudgeRenderer.connectionLabelPlacement = {
  createLineSampler(section, pStart, pEnd, absX, absY, hasBendPoints) {
    // Extract all points along the chosen edge line style
    const points = [pStart];
    if (hasBendPoints) {
      points.push(...section.bendPoints.map(b => ({ x: b.x + absX, y: b.y + absY })));
    }
    points.push(pEnd);

    // Calculate total length and segment lengths
    let totalLen = 0;
    const segLens = [];
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i+1].x - points[i].x;
      const dy = points[i+1].y - points[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      totalLen += len;
      segLens.push(len);
    }

    function getPointAtFraction(fraction) {
      if (totalLen === 0) return { x: points[0].x, y: points[0].y, segment: { p1: points[0], p2: points[0] } };
      const targetDist = totalLen * fraction;
      let accumulated = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const len = segLens[i];
        if (accumulated + len >= targetDist - 1e-5) {
          const remaining = targetDist - accumulated;
          const p1 = points[i];
          const p2 = points[i+1];
          const t = len > 0 ? remaining / len : 0;
          return {
            x: p1.x + t * (p2.x - p1.x),
            y: p1.y + t * (p2.y - p1.y),
            segment: { p1, p2 }
          };
        }
        accumulated += len;
      }
      const lastIdx = points.length - 1;
      return {
        x: points[lastIdx].x,
        y: points[lastIdx].y,
        segment: { p1: points[lastIdx - 1], p2: points[lastIdx] }
      };
    }

    return { points, totalLen, segLens, getPointAtFraction };
  },

  prepareLabelContext({
    label,
    flatNodeById,
    sourceId,
    targetId,
    section,
    pStart,
    pEnd,
    absX,
    absY,
    hasBendPoints
  }) {
    const textWidth = label.width;
    const textHeight = label.height;
    const sourceNode = flatNodeById.get(sourceId);
    const targetNode = flatNodeById.get(targetId);
    const {
      isConsumeBusLabel,
      preferSourceSideLabel
    } = window.NudgeRenderer.connectionLabelPlacement.classifyMessageBusLabel(label, sourceNode, targetNode);

    const {
      points,
      totalLen,
      segLens,
      getPointAtFraction
    } = window.NudgeRenderer.connectionLabelPlacement.createLineSampler(section, pStart, pEnd, absX, absY, hasBendPoints);

    return {
      textWidth,
      textHeight,
      sourceNode,
      targetNode,
      isConsumeBusLabel,
      preferSourceSideLabel,
      points,
      totalLen,
      segLens,
      getPointAtFraction
    };
  },

  classifyMessageBusLabel(label, sourceNode, targetNode) {
    const labelTextLower = (label.text || '').toLowerCase();
    const isMessageBusTarget =
      targetNode && targetNode.type === 'message_bus' &&
      (!sourceNode || sourceNode.type !== 'message_bus');
    const isPublishBusLabel = isMessageBusTarget && labelTextLower.includes('publish');
    const isConsumeBusLabel = isMessageBusTarget && labelTextLower.includes('consume');
    const preferSourceSideLabel = isPublishBusLabel || isConsumeBusLabel;
    return {
      isMessageBusTarget,
      isPublishBusLabel,
      isConsumeBusLabel,
      preferSourceSideLabel
    };
  },

  getAnchorOrder(preferSourceSideLabel) {
    return preferSourceSideLabel
      ? ['source', 'target']
      : ['target', 'source'];
  },

  createElementObstacles(allComponents, boundaryBorderObstacles) {
    return [...allComponents, ...boundaryBorderObstacles];
  },

  createLabelObstacles(allComponents, boundaryBorderObstacles, placedLabels) {
    return [...allComponents, ...boundaryBorderObstacles, ...placedLabels];
  },

  createCollisionAccessors({
    H_PAD,
    V_PAD,
    allEdgesPoints,
    edge,
    targetNode,
    targetId,
    placedLabels
  }) {
    function checkLabelCollision(cx, cy, w, h, nodesList) {
      return window.NudgeRenderer.connectionLabelPlacement.checkLabelCollision(cx, cy, w, h, nodesList, H_PAD, V_PAD);
    }

    function labelBoxAt(cx, cy, w, h) {
      return window.NudgeRenderer.connectionLabelPlacement.labelBoxAt(cx, cy, w, h, H_PAD, V_PAD);
    }

    function labelEdgeHitCount(labelBox) {
      return window.NudgeRenderer.connectionLabelPlacement.labelEdgeHitCount(labelBox, allEdgesPoints, edge.id);
    }

    function checkLabelEdgeCollision(cx, cy, w, h) {
      const labelBox = labelBoxAt(cx, cy, w, h);
      return labelEdgeHitCount(labelBox) > 0;
    }

    function sharedTargetDatabaseLabelPressure(labelBox) {
      return window.NudgeRenderer.connectionLabelPlacement.sharedTargetDatabaseLabelPressure(labelBox, targetNode, targetId, placedLabels);
    }

    return {
      checkLabelCollision,
      checkLabelEdgeCollision,
      labelBoxAt,
      labelEdgeHitCount,
      sharedTargetDatabaseLabelPressure
    };
  },

  createCandidateScorer({
    textWidth,
    textHeight,
    obstacles,
    placedLabels,
    allComponents,
    preferSourceSideLabel,
    pStart,
    pointToBoxDist,
    labelBoxAt,
    checkLabelCollision,
    labelEdgeHitCount,
    sharedTargetDatabaseLabelPressure,
    boxesOverlap
  }) {
    return function labelCandidateScore(cx, cy, segLen = 0) {
      return window.NudgeRenderer.connectionLabelPlacement.scoreCandidate({
        cx,
        cy,
        segLen,
        textWidth,
        textHeight,
        obstacles,
        placedLabels,
        allComponents,
        preferSourceSideLabel,
        pStart,
        pointToBoxDist,
        labelBoxAt,
        checkLabelCollision,
        labelEdgeHitCount,
        sharedTargetDatabaseLabelPressure,
        boxesOverlap
      });
    };
  },

  createPlacementAdapters({
    preferSourceSideLabel,
    points,
    totalLen,
    segLens,
    pStart,
    textWidth,
    textHeight,
    getPointAtFraction,
    labelCandidateScore,
    hasBendPoints,
    obstacles,
    checkLabelCollision,
    checkLabelEdgeCollision
  }) {
    function labelAnchorCandidate(anchor) {
      return window.NudgeRenderer.connectionLabelPlacement.createAnchorCandidate({
        anchor,
        points,
        totalLen,
        textWidth,
        textHeight,
        getPointAtFraction,
        labelCandidateScore
      });
    }

    function tryPlaceAnchor(anchor, acceptPlacement) {
      const placement = window.NudgeRenderer.connectionLabelPlacement.tryAnchorPlacement(anchor, labelAnchorCandidate);
      if (!placement) return false;
      return acceptPlacement(placement);
    }

    function tryPlaceSourceSideRouteBand(acceptPlacement) {
      const placement = window.NudgeRenderer.connectionLabelPlacement.findSourceSideRouteBandPlacement({
        preferSourceSideLabel,
        points,
        totalLen,
        segLens,
        pStart,
        labelCandidateScore
      });
      if (!placement) return false;
      return acceptPlacement(placement);
    }

    function tryPlaceClearMidpoint(acceptPlacement) {
      const placement = window.NudgeRenderer.connectionLabelPlacement.findClearMidpointPlacement({
        hasBendPoints,
        getPointAtFraction,
        textWidth,
        textHeight,
        obstacles,
        checkLabelCollision,
        checkLabelEdgeCollision
      });
      if (!placement) return false;
      return acceptPlacement(placement);
    }

    return {
      tryPlaceAnchor,
      labelAnchorCandidate,
      tryPlaceSourceSideRouteBand,
      tryPlaceClearMidpoint
    };
  },

  chooseInitialLabelPlacement({
    preferSourceSideLabel,
    isConsumeBusLabel,
    anchorOrder,
    tryPlaceClearMidpoint,
    tryPlaceSourceSideRouteBand,
    tryPlaceAnchor,
    labelAnchorCandidate,
    points,
    textWidth,
    textHeight,
    labelCandidateScore
  }) {
    let midX, midY;
    let placed = false;

    function acceptPlacement(placement) {
      midX = placement.x;
      midY = placement.y;
      return true;
    }

    // First Pass: Try to place label avoiding BOTH component collisions and other connection line crossings
    placed = tryPlaceClearMidpoint(acceptPlacement);

    if (preferSourceSideLabel) {
      if (isConsumeBusLabel) {
        if (!placed) placed = tryPlaceSourceSideRouteBand(acceptPlacement);
        if (!placed) placed = tryPlaceAnchor('source', acceptPlacement);
      } else {
        if (!placed) placed = tryPlaceAnchor('source', acceptPlacement);
        if (!placed) placed = tryPlaceSourceSideRouteBand(acceptPlacement);
      }
    } else {
      for (const anchor of anchorOrder) {
        if (!placed) placed = tryPlaceAnchor(anchor, acceptPlacement);
      }
    }

    // Second Pass (Fallback): prefer edge-clear anchor positions, then relax only if needed.
    if (!placed) {
      placed = tryPlaceClearMidpoint(acceptPlacement);
    }

    if (!placed && !preferSourceSideLabel) {
      placed = tryPlaceSourceSideRouteBand(acceptPlacement);
    }

    if (!placed && preferSourceSideLabel) {
      const placement = window.NudgeRenderer.connectionLabelPlacement.findRelaxedSourceAnchorPlacement(anchorOrder, labelAnchorCandidate);
      if (placement) {
        midX = placement.x;
        midY = placement.y;
        placed = true;
      }
    }

    for (const anchor of anchorOrder) {
      if (!placed) placed = tryPlaceAnchor(anchor, acceptPlacement);
    }

    // Rule 3: Fallback to Middle Gutter Clearance
    if (!placed) {
      const placement = window.NudgeRenderer.connectionLabelPlacement.findMiddleGutterPlacement({
        points,
        textWidth,
        textHeight,
        labelCandidateScore
      });
      midX = placement.x;
      midY = placement.y;
    }

    return { midX, midY };
  },

  adjustFinalLabelPlacement({
    midX,
    midY,
    points,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD,
    placedLabels,
    obstacleNodes,
    boxesOverlap,
    checkLabelCollision,
    labelBoxAt,
    targetNode,
    targetId,
    labelEdgeHitCount
  }) {
    // Post-placement nudge: if final position overlaps an already-placed label
    // (Rule 3 / straight-middle don't check placedLabels during scoring), try vertical offsets.
    midY = window.NudgeRenderer.connectionLabelPlacement.nudgeLabelVertically({
      midX,
      midY,
      textWidth,
      textHeight,
      H_PAD,
      V_PAD,
      placedLabels,
      obstacleNodes,
      boxesOverlap,
      checkLabelCollision
    });

    {
      const placement = window.NudgeRenderer.connectionLabelPlacement.spreadSameTargetDatabaseLabel({
        midX,
        midY,
        textWidth,
        textHeight,
        H_PAD,
        V_PAD,
        targetNode,
        targetId,
        placedLabels,
        obstacleNodes,
        boxesOverlap,
        checkLabelCollision,
        labelEdgeHitCount
      });
      midX = placement.x;
      midY = placement.y;
    }

    {
      const placement = window.NudgeRenderer.connectionLabelPlacement.rescueLabelFromConnectionLineHits({
        midX,
        midY,
        points,
        textWidth,
        textHeight,
        H_PAD,
        V_PAD,
        placedLabels,
        obstacleNodes,
        boxesOverlap,
        checkLabelCollision,
        labelBoxAt,
        labelEdgeHitCount
      });
      midX = placement.x;
      midY = placement.y;
    }

    return { midX, midY };
  },

  // Last-resort relocation when the chosen position still sits on another
  // connection line: walk the label's own route (with small perpendicular
  // offsets) for the nearest spot clear of elements, labels, and lines.
  rescueLabelFromConnectionLineHits({
    midX,
    midY,
    points,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD,
    placedLabels,
    obstacleNodes,
    boxesOverlap,
    checkLabelCollision,
    labelBoxAt,
    labelEdgeHitCount
  }) {
    if (!points || points.length < 2) return { x: midX, y: midY };
    if (labelEdgeHitCount(labelBoxAt(midX, midY, textWidth, textHeight)) === 0) {
      return { x: midX, y: midY };
    }

    const halfW = textWidth / 2 + H_PAD;
    const halfH = textHeight / 2 + V_PAD;
    const candidates = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (len < 1) continue;
      const isHorizontal = Math.abs(p1.y - p2.y) < 2;
      const steps = Math.max(2, Math.min(24, Math.round(len / 30)));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const x = p1.x + (p2.x - p1.x) * t;
        const y = p1.y + (p2.y - p1.y) * t;
        candidates.push({ x, y });
        if (isHorizontal) {
          candidates.push({ x, y: y - (halfH + 2) });
          candidates.push({ x, y: y + (halfH + 2) });
        } else {
          candidates.push({ x: x - (halfW + 2), y });
          candidates.push({ x: x + (halfW + 2), y });
        }
      }
    }

    let best = null;
    for (const cand of candidates) {
      const box = labelBoxAt(cand.x, cand.y, textWidth, textHeight);
      if (labelEdgeHitCount(box) > 0) continue;
      if (checkLabelCollision(cand.x, cand.y, textWidth, textHeight, obstacleNodes)) continue;
      if (placedLabels.some(pl => boxesOverlap(box, pl))) continue;
      const dist = Math.hypot(cand.x - midX, cand.y - midY);
      if (!best || dist < best.dist) best = { x: cand.x, y: cand.y, dist };
    }
    return best ? { x: best.x, y: best.y } : { x: midX, y: midY };
  },

  boxesOverlap(boxA, boxB) {
    return (
      boxA.x < boxB.x + boxB.width &&
      boxA.x + boxA.width > boxB.x &&
      boxA.y < boxB.y + boxB.height &&
      boxA.y + boxA.height > boxB.y
    );
  },

  lineSegmentIntersectsBox(p1, p2, box) {
    const rx = box.x;
    const ry = box.y;
    const rw = box.width;
    const rh = box.height;

    function lineSegmentsIntersect(a1, a2, b1, b2) {
      const det = (a2.x - a1.x) * (b2.y - b1.y) - (b2.x - b1.x) * (a2.y - a1.y);
      if (det === 0) return false;
      const lambda = ((b2.y - b1.y) * (b2.x - a1.x) + (b1.x - b2.x) * (b2.y - a1.y)) / det;
      const gamma = ((a1.y - a2.y) * (b2.x - a1.x) + (a2.x - a1.x) * (b2.y - a1.y)) / det;
      return (0 <= lambda && lambda <= 1) && (0 <= gamma && gamma <= 1);
    }

    if (p1.x >= rx && p1.x <= rx + rw && p1.y >= ry && p1.y <= ry + rh) return true;
    if (p2.x >= rx && p2.x <= rx + rw && p2.y >= ry && p2.y <= ry + rh) return true;

    const rTopLeft = { x: rx, y: ry };
    const rTopRight = { x: rx + rw, y: ry };
    const rBotLeft = { x: rx, y: ry + rh };
    const rBotRight = { x: rx + rw, y: ry + rh };

    if (lineSegmentsIntersect(p1, p2, rTopLeft, rTopRight)) return true;
    if (lineSegmentsIntersect(p1, p2, rTopRight, rBotRight)) return true;
    if (lineSegmentsIntersect(p1, p2, rBotRight, rBotLeft)) return true;
    if (lineSegmentsIntersect(p1, p2, rBotLeft, rTopLeft)) return true;

    return false;
  },

  labelBoxAt(cx, cy, w, h, H_PAD, V_PAD) {
    return {
      x: cx - w / 2 - H_PAD,
      y: cy - h / 2 - V_PAD,
      width: w + 2 * H_PAD,
      height: h + 2 * V_PAD
    };
  },

  labelEdgeHitCount(labelBox, allEdgesPoints, currentEdgeId) {
    let hits = 0;
    for (const otherEdge of allEdgesPoints) {
      if (otherEdge.id === currentEdgeId) continue;
      for (let i = 0; i < otherEdge.points.length - 1; i++) {
        const p1 = otherEdge.points[i];
        const p2 = otherEdge.points[i + 1];
        if (window.NudgeRenderer.connectionLabelPlacement.lineSegmentIntersectsBox(p1, p2, labelBox)) {
          hits++;
          break;
        }
      }
    }
    return hits;
  },

  checkLabelCollision(cx, cy, w, h, nodesList, H_PAD, V_PAD) {
    const labelBox = window.NudgeRenderer.connectionLabelPlacement.labelBoxAt(cx, cy, w, h, H_PAD, V_PAD);
    for (const comp of nodesList) {
      const compBox = {
        x: comp.x,
        y: comp.y,
        width: comp.width,
        height: comp.height
      };
      if (window.NudgeRenderer.connectionLabelPlacement.boxesOverlap(labelBox, compBox)) {
        return true;
      }
    }
    return false;
  },

  sharedTargetDatabaseLabelPressure(labelBox, targetNode, targetId, placedLabels) {
    if (!targetNode || targetNode.type !== 'database') return 0;
    let pressure = 0;
    for (const placed of placedLabels) {
      if (placed.targetId !== targetId) continue;
      if (window.NudgeRenderer.connectionLabelPlacement.boxesOverlap(labelBox, placed)) {
        pressure += 1000;
        continue;
      }
      const dx = Math.max(0, Math.max(placed.x - (labelBox.x + labelBox.width), labelBox.x - (placed.x + placed.width)));
      const dy = Math.max(0, Math.max(placed.y - (labelBox.y + labelBox.height), labelBox.y - (placed.y + placed.height)));
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < 42) pressure += 42 - distance;
    }
    return pressure;
  },

  scoreCandidate({
    cx,
    cy,
    segLen,
    textWidth,
    textHeight,
    obstacles,
    placedLabels,
    allComponents,
    preferSourceSideLabel,
    pStart,
    pointToBoxDist,
    labelBoxAt,
    checkLabelCollision,
    labelEdgeHitCount,
    sharedTargetDatabaseLabelPressure,
    boxesOverlap
  }) {
    const labelBox = labelBoxAt(cx, cy, textWidth, textHeight);
    const nodeCollision = checkLabelCollision(cx, cy, textWidth, textHeight, obstacles) ? 1 : 0;
    const edgeHits = labelEdgeHitCount(labelBox);
    const labelHits = placedLabels.filter(pl => boxesOverlap(labelBox, pl)).length;
    const sharedTargetPressure = sharedTargetDatabaseLabelPressure(labelBox);
    const centerClearance = allComponents.length > 0
      ? Math.min(...allComponents.map(n => pointToBoxDist(cx, cy, n)))
      : 200;
    const sourceDistanceBias = preferSourceSideLabel
      ? Math.min(180, Math.hypot(cx - pStart.x, cy - pStart.y)) * 5
      : 0;
    return {
      nodeCollision,
      edgeHits,
      labelHits,
      score:
        nodeCollision * 100000 +
        labelHits * 50000 +
        edgeHits * 9000 -
        sharedTargetPressure * 260 -
        Math.min(centerClearance, 180) * 12 -
        segLen * 0.3 +
        sourceDistanceBias
    };
  },

  createAnchorCandidate({
    anchor,
    points,
    totalLen,
    textWidth,
    textHeight,
    getPointAtFraction,
    labelCandidateScore
  }) {
    if (points.length < 2) return null;

    const isSource = anchor === 'source';
    const pA = isSource ? points[0] : points[points.length - 2];
    const pB = isSource ? points[1] : points[points.length - 1];
    const isHorizontal = Math.abs(pA.y - pB.y) < 2;
    const anchorDist = isHorizontal
      ? Math.max(45, (textWidth / 2) + 20)
      : Math.max(45, (textHeight / 2) + 20);

    if (totalLen < 2 * anchorDist) return false;

    const fraction = isSource
      ? anchorDist / totalLen
      : (totalLen - anchorDist) / totalLen;
    const cand = getPointAtFraction(fraction);
    return {
      anchor,
      x: cand.x,
      y: cand.y,
      ...labelCandidateScore(cand.x, cand.y, anchorDist)
    };
  },

  tryAnchorPlacement(anchor, labelAnchorCandidate) {
    const candidate = labelAnchorCandidate(anchor);
    if (!candidate) return false;
    if (candidate.nodeCollision > 0 || candidate.edgeHits > 0 || candidate.labelHits > 0) return false;
    return {
      x: candidate.x,
      y: candidate.y
    };
  },

  findSourceSideRouteBandPlacement({
    preferSourceSideLabel,
    points,
    totalLen,
    segLens,
    pStart,
    labelCandidateScore
  }) {
    if (!preferSourceSideLabel || points.length < 2 || totalLen <= 0) return false;

    const candidates = [];
    let accumulated = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const len = segLens[i];
      const isHorizontal = Math.abs(p1.y - p2.y) < 2;
      if (len < 1) {
        accumulated += len;
        continue;
      }

      for (const fraction of [0.25, 0.5, 0.75]) {
        const distanceAlongRoute = accumulated + len * fraction;
        if (distanceAlongRoute / totalLen > 0.38) continue;

        const x = p1.x + (p2.x - p1.x) * fraction;
        const y = p1.y + (p2.y - p1.y) * fraction;
        const candidate = {
          x,
          y,
          routeDistance: distanceAlongRoute,
          sourceDistance: Math.hypot(x - pStart.x, y - pStart.y),
          isHorizontal,
          ...labelCandidateScore(x, y, len)
        };
        if (candidate.nodeCollision === 0 && candidate.labelHits === 0) {
          candidates.push(candidate);
        }
      }

      accumulated += len;
    }

    candidates.sort((a, b) =>
      Number(b.isHorizontal) - Number(a.isHorizontal) ||
      a.sourceDistance - b.sourceDistance ||
      a.edgeHits - b.edgeHits ||
      a.score - b.score ||
      a.routeDistance - b.routeDistance
    );

    const best = candidates[0];
    if (!best) return false;
    return {
      x: best.x,
      y: best.y
    };
  },

  findClearMidpointPlacement({
    hasBendPoints,
    getPointAtFraction,
    textWidth,
    textHeight,
    obstacles,
    checkLabelCollision,
    checkLabelEdgeCollision
  }) {
    const candMid = getPointAtFraction(0.5);
    if (!checkLabelCollision(candMid.x, candMid.y, textWidth, textHeight, obstacles) &&
        !checkLabelEdgeCollision(candMid.x, candMid.y, textWidth, textHeight)) {
      return {
        x: candMid.x,
        y: candMid.y
      };
    }
    return false;
  },

  findRelaxedSourceAnchorPlacement(anchorOrder, labelAnchorCandidate) {
    const anchorCandidates = anchorOrder
      .map(anchor => labelAnchorCandidate(anchor))
      .filter(Boolean)
      .filter(candidate => candidate.nodeCollision === 0 && candidate.labelHits === 0)
      .map(candidate => ({
        ...candidate,
        score: candidate.score + (candidate.anchor === 'source' ? -12000 : 0)
      }))
      .sort((a, b) =>
        a.score - b.score ||
        a.edgeHits - b.edgeHits ||
        a.labelHits - b.labelHits
      );

    const bestAnchor = anchorCandidates[0];
    if (!bestAnchor) return false;
    return {
      x: bestAnchor.x,
      y: bestAnchor.y
    };
  },

  findMiddleGutterPlacement({
    points,
    textWidth,
    textHeight,
    labelCandidateScore
  }) {
    const candidates = [];
    let bestScore = -Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1) continue;

      for (const fraction of [0.25, 0.5, 0.75]) {
        const x = p1.x + dx * fraction;
        const y = p1.y + dy * fraction;
        const candidate = { x, y, p1, p2, len, ...labelCandidateScore(x, y, len) };
        candidates.push(candidate);
        if (candidate.score > bestScore) bestScore = candidate.score;
      }
    }

    candidates.sort((a, b) =>
      a.score - b.score ||
      a.edgeHits - b.edgeHits ||
      a.labelHits - b.labelHits ||
      a.nodeCollision - b.nodeCollision
    );

    const best = candidates[0];
    if (best) {
      const isHorizontal = Math.abs(best.p1.y - best.p2.y) < 2;
      const isVertical = Math.abs(best.p1.x - best.p2.x) < 2;
      let midX = best.x;
      let midY = best.y;
      if (isHorizontal) {
        const minX = Math.min(best.p1.x, best.p2.x);
        const maxX = Math.max(best.p1.x, best.p2.x);
        const padX = (textWidth / 2) + 20;
        midX = (maxX - minX >= 2 * padX)
          ? Math.max(minX + padX, Math.min(maxX - padX, best.x))
          : best.x;
      } else if (isVertical) {
        const minY = Math.min(best.p1.y, best.p2.y);
        const maxY = Math.max(best.p1.y, best.p2.y);
        const padY = (textHeight / 2) + 20;
        midY = (maxY - minY >= 2 * padY)
          ? Math.max(minY + padY, Math.min(maxY - padY, best.y))
          : best.y;
      }
      return { x: midX, y: midY };
    }

    return {
      x: (points[0].x + points[points.length - 1].x) / 2,
      y: (points[0].y + points[points.length - 1].y) / 2
    };
  },

  nudgeLabelVertically({
    midX,
    midY,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD,
    placedLabels,
    obstacleNodes,
    boxesOverlap,
    checkLabelCollision
  }) {
    const labelH = textHeight + 2 * V_PAD;
    const labelW = textWidth + 2 * H_PAD;
    const proposedBox = () => ({ x: midX - labelW / 2, y: midY - labelH / 2, width: labelW, height: labelH });
    if (placedLabels.some(pl => boxesOverlap(proposedBox(), pl)) ||
        checkLabelCollision(midX, midY, textWidth, textHeight, obstacleNodes)) {
      const step = labelH + 4;
      for (const dy of [-step, step, -2 * step, 2 * step, -3 * step, 3 * step]) {
        const ty = midY + dy;
        const testBox = { x: midX - labelW / 2, y: ty - labelH / 2, width: labelW, height: labelH };
        if (!placedLabels.some(pl => boxesOverlap(testBox, pl)) &&
            !checkLabelCollision(midX, ty, textWidth, textHeight, obstacleNodes)) {
          return ty;
        }
      }
    }
    return midY;
  },

  spreadSameTargetDatabaseLabel({
    midX,
    midY,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD,
    targetNode,
    targetId,
    placedLabels,
    obstacleNodes,
    boxesOverlap,
    checkLabelCollision,
    labelEdgeHitCount
  }) {
    if (!targetNode || targetNode.type !== 'database') return { x: midX, y: midY };

    const labelH = textHeight + 2 * V_PAD;
    const labelW = textWidth + 2 * H_PAD;
    const sameTargetLabels = placedLabels.filter(pl => pl.targetId === targetId);
    if (sameTargetLabels.length === 0) return { x: midX, y: midY };

    const boxAt = (cx, cy) => ({ x: cx - labelW / 2, y: cy - labelH / 2, width: labelW, height: labelH });
    const expanded = (box, pad) => ({
      x: box.x - pad,
      y: box.y - pad,
      width: box.width + pad * 2,
      height: box.height + pad * 2
    });
    const sameTargetScore = (cx, cy) => {
      const box = boxAt(cx, cy);
      const nodeCollision = checkLabelCollision(cx, cy, textWidth, textHeight, obstacleNodes) ? 1 : 0;
      const labelOverlapCount = placedLabels.filter(pl => boxesOverlap(box, pl)).length;
      const sameTargetCloseCount = sameTargetLabels.filter(pl => boxesOverlap(expanded(box, 28), expanded(pl, 28))).length;
      return (
        nodeCollision * 100000 +
        labelOverlapCount * 50000 +
        sameTargetCloseCount * 12000 +
        labelEdgeHitCount(box) * 2500 +
        Math.hypot(cx - midX, cy - midY) * 3
      );
    };

    const stepX = Math.max(labelW * 0.75, 78);
    const stepY = labelH + 12;
    const candidates = [{ x: midX, y: midY }];
    for (const dx of [-stepX, stepX, -2 * stepX, 2 * stepX, -3 * stepX, 3 * stepX]) {
      candidates.push({ x: midX + dx, y: midY });
    }
    for (const dy of [-stepY, stepY, -2 * stepY, 2 * stepY]) {
      candidates.push({ x: midX, y: midY + dy });
      candidates.push({ x: midX - stepX, y: midY + dy });
      candidates.push({ x: midX + stepX, y: midY + dy });
    }

    candidates.sort((a, b) => sameTargetScore(a.x, a.y) - sameTargetScore(b.x, b.y));
    const best = candidates[0];
    if (!best) return { x: midX, y: midY };
    return {
      x: best.x,
      y: best.y
    };
  }
};

