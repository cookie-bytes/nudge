window.NudgeRenderer.routeCandidateRules = {
  createCandidateRules({
    sourceReservedBottomDrops,
    MIN_ROUTE_LINE_GAP,
    ROUTE_BOUNDARY_CLEARANCE,
    V_GAP,
    bndX,
    bndY,
    bndW,
    leftCorrGap,
    rightCorrGap,
    incomingEdges,
    allEdges,
    childIds,
    childPos,
    leftSet,
    rightSet,
    nodeLayerIdx,
    getAbs,
    getSz,
    getNode
  }) {
    function sourceSafeBottomExitXs({ e, sp, ss, scx }, preferRight) {
      const drops = sourceReservedBottomDrops(e);
      if (drops.length === 0) return [];

      const candidates = [];
      const minX = sp.x + ss.w * 0.15;
      const maxX = sp.x + ss.w * 0.85;
      for (const drop of drops) {
        const offset = MIN_ROUTE_LINE_GAP * 2;
        candidates.push(preferRight ? drop.a.x + offset : drop.a.x - offset);
        candidates.push(preferRight ? drop.a.x - offset : drop.a.x + offset);
      }

      return [...new Set(candidates
        .map(x => Math.min(maxX, Math.max(minX, x)))
        .map(x => Math.round(x * 10) / 10))]
        .filter(x => Math.abs(x - scx) > 4);
    }

    function orderedMessageBusGutterX({ e, idx, targetNode, tp, ts }, preferRight) {
      if (!targetNode || targetNode.type !== 'message_bus') {
        return preferRight ? bndX + bndW - 35 : bndX + 35;
      }

      const busCenterX = tp.x + ts.w / 2;
      const sameSideEdges = (incomingEdges.get(e.to) || [])
        .filter(edgeIdx => {
          const incoming = allEdges[edgeIdx];
          if (!incoming || !childIds.has(incoming.from)) return false;
          const incomingPos = getAbs(incoming.from);
          const incomingSize = getSz(incoming.from);
          const incomingCx = incomingPos.x + incomingSize.w / 2;
          return preferRight ? incomingCx >= busCenterX : incomingCx < busCenterX;
        })
        .sort((a, b) => {
          const edgeA = allEdges[a];
          const edgeB = allEdges[b];
          const posA = getAbs(edgeA.from);
          const posB = getAbs(edgeB.from);
          const sizeA = getSz(edgeA.from);
          const sizeB = getSz(edgeB.from);
          return (posA.y + sizeA.h / 2) - (posB.y + sizeB.h / 2);
        });

      const rank = Math.max(0, sameSideEdges.indexOf(idx));
      const step = MIN_ROUTE_LINE_GAP;
      const outer = preferRight ? bndX + bndW - 35 : bndX + 35;
      const innerLimit = preferRight
        ? tp.x + ts.w + ROUTE_BOUNDARY_CLEARANCE
        : tp.x - ROUTE_BOUNDARY_CLEARANCE;
      const lane = preferRight ? outer - rank * step : outer + rank * step;
      return preferRight
        ? Math.max(innerLimit, lane)
        : Math.min(innerLimit, lane);
    }

    function sideExternalRouteCandidates({
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
    }) {
      const candidates = [];
      const targetOnRight = sp.x + ss.w <= tp.x + 10;
      const targetOnLeft = tp.x + ts.w <= sp.x + 10;
      if (!targetOnRight && !targetOnLeft) return candidates;

      const endX = targetOnRight ? tp.x : tp.x + ts.w;
      const sideY = tCy;
      const horizontalPad = targetOnRight ? 32 : -32;
      const sourceSideX = targetOnRight ? sp.x + ss.w : sp.x;
      const sideLaneX = targetOnRight
        ? Math.max(sourceSideX + 20, Math.min(tp.x - 20, endX + horizontalPad))
        : Math.min(sourceSideX - 20, Math.max(tp.x + ts.w + 20, endX + horizontalPad));

      const topSlot = targetOnRight ? 0.76 : 0.24;
      const bottomSlot = targetOnRight ? 0.76 : 0.24;
      const topX = sourceTopSlot(topSlot);
      const bottomX = sourceBottomSlot(bottomSlot);

      if (tCy <= sCy + 20) {
        candidates.push({
          startPoint: { x: topX, y: sTop },
          endPoint: { x: endX, y: sideY },
          bendPoints: [
            { x: topX, y: sideY },
            { x: endX, y: sideY }
          ],
          _scoreBias: -70
        });
        candidates.push({
          startPoint: { x: topX, y: sTop },
          endPoint: { x: endX, y: sideY },
          bendPoints: [
            { x: topX, y: sTop - V_GAP / 2 },
            { x: sideLaneX, y: sTop - V_GAP / 2 },
            { x: sideLaneX, y: sideY }
          ],
          _scoreBias: -25
        });
      }

      if (tCy >= sCy - 20) {
        candidates.push({
          startPoint: { x: bottomX, y: sBot },
          endPoint: { x: endX, y: sideY },
          bendPoints: [
            { x: bottomX, y: sideY },
            { x: endX, y: sideY }
          ],
          _scoreBias: -70
        });
        candidates.push({
          startPoint: { x: bottomX, y: sBot },
          endPoint: { x: endX, y: sideY },
          bendPoints: [
            { x: bottomX, y: sBot + V_GAP / 2 },
            { x: sideLaneX, y: sBot + V_GAP / 2 },
            { x: sideLaneX, y: sideY }
          ],
          _scoreBias: -25
        });
      }

      return candidates;
    }

    function targetFacingRouteCandidates({
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
    }) {
      const candidates = [];
      const targetOnRight = sp.x + ss.w <= tp.x + 10;
      const targetOnLeft = tp.x + ts.w <= sp.x + 10;
      if (!targetOnRight && !targetOnLeft) return candidates;

      const naturalSide = targetOnRight ? 'left' : 'right';
      const sourceSlot = targetOnRight ? 0.76 : 0.24;
      const sourceX = sp.x + ss.w * sourceSlot;
      const sideY = tCy;

      function routeToTargetSide(side, scoreBias) {
        const sideEndX = side === 'left' ? tp.x : tp.x + ts.w;
        const sideLaneX = side === 'left' ? tp.x - 24 : tp.x + ts.w + 24;

        if (tp.y >= sp.y + ss.h - 2) {
          const sourceLane = horizontalLaneBelowSource();
          return {
            startPoint: { x: sourceX, y: sBot },
            endPoint: { x: sideEndX, y: sideY },
            bendPoints: [
              { x: sourceX, y: sourceLane },
              { x: sideLaneX, y: sourceLane },
              { x: sideLaneX, y: sideY }
            ],
            _scoreBias: scoreBias
          };
        }

        if (sp.y >= tp.y + ts.h - 2) {
          const sourceLane = horizontalLaneAboveSource();
          return {
            startPoint: { x: sourceX, y: sTop },
            endPoint: { x: sideEndX, y: sideY },
            bendPoints: [
              { x: sourceX, y: sourceLane },
              { x: sideLaneX, y: sourceLane },
              { x: sideLaneX, y: sideY }
            ],
            _scoreBias: scoreBias
          };
        }

        const sourceSideX = targetOnRight ? sp.x + ss.w : sp.x;
        return {
          startPoint: { x: sourceSideX, y: sCy },
          endPoint: { x: sideEndX, y: sideY },
          bendPoints: [{ x: sideLaneX, y: sCy }, { x: sideLaneX, y: sideY }],
          _scoreBias: scoreBias + 20
        };
      }

      const naturalRoute = routeToTargetSide(naturalSide, -60);
      candidates.push(naturalRoute);

      const naturalConflicts = routeEdgeConflictStats(naturalRoute);
      if (
        checkCollision(naturalRoute) ||
        naturalConflicts.edgeCrossings > 0 ||
        naturalConflicts.edgeOverlaps > 0
      ) {
        const alternateSide = naturalSide === 'left' ? 'right' : 'left';
        candidates.push(routeToTargetSide(alternateSide, -45));
      }

      return candidates;
    }

    function hintedOrthogonalRouteCandidates(
      { routeIntent, targetNode, tcx, tp, ts, orderedMessageBusGutterX },
      sourceY,
      endY,
      sourceLane,
      targetLane,
      sourcePortXs
    ) {
      const candidates = [];
      if (!routeIntent) return candidates;
      if (targetNode && targetNode.type === 'database') return candidates;

      const wantsLeftLane = routeIntent === 'LEFT_LANE';
      const wantsRightLane = routeIntent === 'RIGHT_LANE';
      const wantsTargetOrthogonal = routeIntent === 'ORTHOGONAL_NEAR_TARGET';
      if (!wantsLeftLane && !wantsRightLane && !wantsTargetOrthogonal) return candidates;

      const sourceAboveTarget = sourceY > endY;
      const sourcePortY = sourceY;
      const leftGutterX = orderedMessageBusGutterX(false);
      const rightGutterX = orderedMessageBusGutterX(true);
      const laneBias = -720;
      const targetBias = -520;

      const uniqueSourceXs = [...new Set(sourcePortXs
        .filter(Number.isFinite)
        .map(x => Math.round(x * 10) / 10))];

      function pushViaGutter(gutterX, scoreBias) {
        for (const sourceX of uniqueSourceXs) {
          candidates.push({
            startPoint: { x: sourceX, y: sourcePortY },
            endPoint: { x: tcx, y: endY },
            bendPoints: [
              { x: sourceX, y: sourceLane },
              { x: gutterX, y: sourceLane },
              { x: gutterX, y: targetLane },
              { x: tcx, y: targetLane }
            ],
            _scoreBias: scoreBias
          });
        }
      }

      if (wantsLeftLane) pushViaGutter(leftGutterX, laneBias);
      if (wantsRightLane) pushViaGutter(rightGutterX, laneBias);

      if (wantsTargetOrthogonal) {
        for (const sourceX of uniqueSourceXs) {
          candidates.push({
            startPoint: { x: sourceX, y: sourcePortY },
            endPoint: { x: tcx, y: endY },
            bendPoints: [
              { x: sourceX, y: targetLane },
              { x: tcx, y: targetLane }
            ],
            _scoreBias: targetBias
          });
          const targetSideX = tcx >= sourceX ? tp.x + ts.w + 24 : tp.x - 24;
          candidates.push({
            startPoint: { x: sourceX, y: sourcePortY },
            endPoint: { x: tcx, y: endY },
            bendPoints: [
              { x: sourceX, y: sourceLane },
              { x: targetSideX, y: sourceLane },
              { x: targetSideX, y: targetLane },
              { x: tcx, y: targetLane }
            ],
            _scoreBias: targetBias + (sourceAboveTarget ? -40 : 0)
          });
        }
      }

      return candidates;
    }

    function sideExternalZSCurveCandidates({ sp, tp, ss, ts, sCy, tCy }) {
      const candidates = [];
      const xCandidates = [
        bndX - leftCorrGap / 2,
        bndX + bndW + rightCorrGap / 2,
        sp.x < tp.x ? tp.x - 20 : tp.x + ts.w + 20,
        sp.x < tp.x ? sp.x + ss.w + 20 : sp.x - 20
      ];
      const uniqueX = [...new Set(xCandidates.map(x => Math.round(x * 10) / 10))];
      for (const midX of uniqueX) {
        if (sp.x + ss.w <= tp.x + 10) {
          const startX = sp.x + ss.w, startY = sCy;
          const endX = tp.x, endY = tCy;
          candidates.push({
            startPoint: { x: startX, y: startY },
            endPoint: { x: endX, y: endY },
            bendPoints: [{ x: midX, y: startY }, { x: midX, y: endY }]
          });
        } else {
          const startX = sp.x, startY = sCy;
          const endX = tp.x + ts.w, endY = tCy;
          candidates.push({
            startPoint: { x: startX, y: startY },
            endPoint: { x: endX, y: endY },
            bendPoints: [{ x: midX, y: startY }, { x: midX, y: endY }]
          });
        }
      }
      return candidates;
    }

    function internalBelowTargetRouteCandidates({
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
      hintedOrthogonalRouteCandidates
    }) {
      const candidates = [];
      const sourceLane = horizontalLaneBelowSource();
      const targetLane = horizontalLaneAboveTarget();
      const endY = targetEntryY ?? tTop;
      const preferRight = scx > bndX + bndW / 2;
      const leftGutterX = orderedMessageBusGutterX(false);
      const rightGutterX = orderedMessageBusGutterX(true);
      const leftLaneBias = routeIntent === 'LEFT_LANE' ? -420 : preferRight ? 120 : -120;
      const rightLaneBias = routeIntent === 'RIGHT_LANE' ? -420 : preferRight ? -120 : 120;
      const targetLaneBias = routeIntent === 'ORTHOGONAL_NEAR_TARGET' ? -260 : 0;
      const hintedSourceXs = [scx, ...sourceSafeBottomExitXs(preferRight)];
      candidates.push(
        { startPoint: { x: scx, y: sBot }, endPoint: { x: tcx, y: endY }, bendPoints: [] },
        { startPoint: { x: scx, y: sBot }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: scx, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: targetLaneBias },
        { startPoint: { x: scx, y: sBot }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: scx, y: sourceLane }, { x: leftGutterX, y: sourceLane }, { x: leftGutterX, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: leftLaneBias },
        { startPoint: { x: scx, y: sBot }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: scx, y: sourceLane }, { x: rightGutterX, y: sourceLane }, { x: rightGutterX, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: rightLaneBias }
      );
      candidates.push(...hintedOrthogonalRouteCandidates(sBot, endY, sourceLane, targetLane, hintedSourceXs));
      for (const safeX of hintedSourceXs.filter(x => Math.abs(x - scx) > 4)) {
        candidates.push(
          { startPoint: { x: safeX, y: sBot }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: safeX, y: sourceLane }, { x: leftGutterX, y: sourceLane }, { x: leftGutterX, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: leftLaneBias + 15 },
          { startPoint: { x: safeX, y: sBot }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: safeX, y: sourceLane }, { x: rightGutterX, y: sourceLane }, { x: rightGutterX, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: rightLaneBias + 15 }
        );
      }
      return candidates;
    }

    function internalAboveTargetRouteCandidates({
      scx,
      tcx,
      sTop,
      tBot,
      targetEntryY,
      routeIntent,
      horizontalLaneAboveSource,
      horizontalLaneBelowTarget,
      orderedMessageBusGutterX,
      hintedOrthogonalRouteCandidates
    }) {
      const candidates = [];
      const sourceLane = horizontalLaneAboveSource();
      const targetLane = horizontalLaneBelowTarget();
      const endY = targetEntryY ?? tBot;
      const preferRight = scx > bndX + bndW / 2;
      const leftGutterX = orderedMessageBusGutterX(false);
      const rightGutterX = orderedMessageBusGutterX(true);
      const leftLaneBias = routeIntent === 'LEFT_LANE' ? -420 : preferRight ? 120 : -120;
      const rightLaneBias = routeIntent === 'RIGHT_LANE' ? -420 : preferRight ? -120 : 120;
      const targetLaneBias = routeIntent === 'ORTHOGONAL_NEAR_TARGET' ? -260 : 0;
      candidates.push(
        { startPoint: { x: scx, y: sTop }, endPoint: { x: tcx, y: endY }, bendPoints: [] },
        { startPoint: { x: scx, y: sTop }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: scx, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: targetLaneBias },
        { startPoint: { x: scx, y: sTop }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: scx, y: sourceLane }, { x: leftGutterX, y: sourceLane }, { x: leftGutterX, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: leftLaneBias },
        { startPoint: { x: scx, y: sTop }, endPoint: { x: tcx, y: endY }, bendPoints: [{ x: scx, y: sourceLane }, { x: rightGutterX, y: sourceLane }, { x: rightGutterX, y: targetLane }, { x: tcx, y: targetLane }], _scoreBias: rightLaneBias }
      );
      candidates.push(...hintedOrthogonalRouteCandidates(sTop, endY, sourceLane, targetLane));
      return candidates;
    }

    function standardRouteCandidate({
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
    }) {
      const tgtNode = getNode(e.to);
      const directDbRoute = directDatabaseDropRoute();
      if (directDbRoute) return directDbRoute;

      // Parent→db direct vertical: if the source sits directly above a
      // database target, route from the bottom-centre of the parent
      // straight into the top-centre of the db, bypassing the standard
      // edge-distribution logic so the pairing reads as a clean drop.
      if (tgtNode && tgtNode.type === 'database' && tp.y >= sp.y + ss.h - 2) {
        const srcCx = sp.x + ss.w / 2;
        const tgtCx = tp.x + ts.w / 2;
        if (Math.abs(srcCx - tgtCx) < Math.min(ss.w, ts.w) / 2) {
          return {
            startPoint: { x: srcCx, y: sBot },
            endPoint: { x: tgtCx, y: tTop },
            bendPoints: []
          };
        }
      }
      // Container→container directly below: snap to a clean vertical drop
      // at the shared centre X when horizontal extents overlap, so stacked
      // containers read as a straight line instead of an L-jog or diagonal.
      // Skip when the drop would cut through an intermediate node (e.g.
      // source and target span multiple layers) — fall through to standard
      // routing in that case.
      const srcNode = getNode(e.from);
      if (
        srcNode && tgtNode &&
        srcNode.type === 'container' && tgtNode.type === 'container' &&
        tp.y >= sp.y + ss.h - 2
      ) {
        const srcCx = sp.x + ss.w / 2;
        const tgtCx = tp.x + ts.w / 2;
        const overlapLeft = Math.max(sp.x, tp.x);
        const overlapRight = Math.min(sp.x + ss.w, tp.x + ts.w);
        if (overlapRight - overlapLeft > 0) {
          const sharedX = (srcCx + tgtCx) / 2;
          const clampedX = Math.min(overlapRight, Math.max(overlapLeft, sharedX));
          const candidate = {
            startPoint: { x: clampedX, y: sBot },
            endPoint: { x: clampedX, y: tTop },
            bendPoints: []
          };
          if (!checkCollision(candidate)) {
            return candidate;
          }
        }
      }
      // If the target is a message bus, try side-entry to prevent label overlap
      if (tgtNode && tgtNode.type === 'message_bus' && tp.y >= sp.y + ss.h - 2) {
        const sideLeft = scx < tcx - 50;
        const sideRoute = {
          startPoint: { x: scx, y: sBot },
          endPoint: { x: tp.x + (sideLeft ? 0 : ts.w), y: tCy },
          bendPoints: [{ x: scx, y: tCy }]
        };
        if (!checkCollision(sideRoute)) {
          return sideRoute;
        }
      }
      if (leftSet.has(e.from) || rightSet.has(e.from) || leftSet.has(e.to) || rightSet.has(e.to)) {
        const isLeft = leftSet.has(e.from) || leftSet.has(e.to);
        const _corrAssign = sideCorridorAssignments.get(idx);
        const midX = _corrAssign
          ? _corrAssign.corridorX
          : (isLeft ? (bndX - leftCorrGap / 2) : (bndX + bndW + rightCorrGap / 2));

        if (sp.x + ss.w <= tp.x + 10) {
          // Left→Right: exit right-center of source, enter left-center of target
          const startX = sp.x + ss.w;
          const startY = (_corrAssign && _corrAssign.startY !== null) ? _corrAssign.startY : sCy;
          const endX = tp.x, endY = tCy;
          if (Math.abs(startY - endY) < 5)
            return { startPoint: {x: startX, y: startY}, endPoint: {x: endX, y: endY}, bendPoints: [] };
          return { startPoint: {x: startX, y: startY}, endPoint: {x: endX, y: endY},
                   bendPoints: [{x: midX, y: startY}, {x: midX, y: endY}] };
        } else {
          // Right→Left: exit left-center of source, enter right-center of target
          const startX = sp.x, startY = sCy;
          const endX = tp.x + ts.w, endY = tCy;
          if (Math.abs(startY - endY) < 5)
            return { startPoint: {x: startX, y: startY}, endPoint: {x: endX, y: endY}, bendPoints: [] };
          return { startPoint: {x: startX, y: startY}, endPoint: {x: endX, y: endY},
                   bendPoints: [{x: midX, y: startY}, {x: midX, y: endY}] };
        }
      }

      // Check if internal edge spans multiple layers
      if (childIds.has(e.from) && childIds.has(e.to)) {
        const srcLayer = nodeLayerIdx.get(e.from);
        const tgtLayer = nodeLayerIdx.get(e.to);
        if (srcLayer !== undefined && tgtLayer !== undefined) {
          if (tgtLayer - srcLayer > 1) {
            // Spans multiple layers downwards
            if (Math.abs(scx - tcx) < 3) {
              // Vertically aligned -> route horizontally around intermediate nodes
              const offset = 120;
              const gapY1 = bndY + childPos[e.from].y + ss.h + V_GAP / 2;
              const gapY2 = bndY + childPos[e.to].y - V_GAP / 2;
              return {
                startPoint: { x: scx, y: sBot },
                endPoint: { x: tcx, y: tTop },
                bendPoints: [
                  { x: scx, y: gapY1 },
                  { x: scx + offset, y: gapY1 },
                  { x: scx + offset, y: gapY2 },
                  { x: tcx, y: gapY2 }
                ]
              };
            } else {
              // Route vertical down to target gap first, then horizontal jog
              const gapY2 = bndY + childPos[e.to].y - V_GAP / 2;
              return {
                startPoint: { x: scx, y: sBot },
                endPoint: { x: tcx, y: tTop },
                bendPoints: [{ x: scx, y: gapY2 }, { x: tcx, y: gapY2 }]
              };
            }
          } else if (srcLayer - tgtLayer > 1) {
            // Spans multiple layers upwards
            if (Math.abs(scx - tcx) < 3) {
              const offset = 120;
              const gapY1 = bndY + childPos[e.from].y - V_GAP / 2;
              const gapY2 = bndY + childPos[e.to].y + ts.h + V_GAP / 2;
              return {
                startPoint: { x: scx, y: sTop },
                endPoint: { x: tcx, y: tBot },
                bendPoints: [
                  { x: scx, y: gapY1 },
                  { x: scx + offset, y: gapY1 },
                  { x: scx + offset, y: gapY2 },
                  { x: tcx, y: gapY2 }
                ]
              };
            } else {
              // Route vertical up to target gap first, then horizontal jog
              const gapY2 = bndY + childPos[e.to].y + ts.h + V_GAP / 2;
              return {
                startPoint: { x: scx, y: sTop },
                endPoint: { x: tcx, y: tBot },
                bendPoints: [{ x: scx, y: gapY2 }, { x: tcx, y: gapY2 }]
              };
            }
          }
        }
      }

      if (tp.y >= sp.y + ss.h - 2) {
        // Target below
        const endY = targetEntryY ?? tTop;
        if (Math.abs(scx - tcx) < 3) return { startPoint: {x: scx, y: sBot}, endPoint: {x: tcx, y: endY}, bendPoints: [] };
        const my = (sBot + endY) / 2;
        return { startPoint: {x: scx, y: sBot}, endPoint: {x: tcx, y: endY}, bendPoints: [{x: scx, y: my}, {x: tcx, y: my}] };
      }
      if (sp.y >= tp.y + ts.h - 2) {
        // Target above
        const endY = targetEntryY ?? tBot;
        if (Math.abs(scx - tcx) < 3) return { startPoint: {x: scx, y: sTop}, endPoint: {x: tcx, y: endY}, bendPoints: [] };
        const my = (sTop + endY) / 2;
        return { startPoint: {x: scx, y: sTop}, endPoint: {x: tcx, y: endY}, bendPoints: [{x: scx, y: my}, {x: tcx, y: my}] };
      }
      // Same row — horizontal
      if (sp.x + ss.w <= tp.x) return { startPoint: {x: sp.x + ss.w, y: sCy}, endPoint: {x: tp.x, y: tCy}, bendPoints: [] };
      if (tp.x + ts.w <= sp.x) return { startPoint: {x: sp.x, y: sCy},        endPoint: {x: tp.x + ts.w, y: tCy}, bendPoints: [] };
      // Fallback: route above both
      const routeY = Math.min(sp.y, tp.y) - 40;
      return { startPoint: {x: scx, y: sTop}, endPoint: {x: tcx, y: tTop}, bendPoints: [{x: scx, y: routeY}, {x: tcx, y: routeY}] };
    }

    return {
      sourceSafeBottomExitXs,
      orderedMessageBusGutterX,
      sideExternalRouteCandidates,
      targetFacingRouteCandidates,
      hintedOrthogonalRouteCandidates,
      sideExternalZSCurveCandidates,
      internalBelowTargetRouteCandidates,
      internalAboveTargetRouteCandidates,
      standardRouteCandidate
    };
  }
};
