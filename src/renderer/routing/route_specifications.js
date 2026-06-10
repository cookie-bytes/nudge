window.NudgeRenderer.routeSpecifications = {
  createBundleSpecification({ leftSet, rightSet, aboveNodes, belowNodes, childIds }) {
    function normalizeBundleLabel(edge) {
      return (edge.label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function nodeRouteZone(id) {
      if (leftSet.has(id)) return 'left';
      if (rightSet.has(id)) return 'right';
      if (aboveNodes.some(n => n.id === id)) return 'above';
      if (belowNodes.some(n => n.id === id)) return 'below';
      if (childIds.has(id)) return 'inside';
      return 'unknown';
    }

    function canBundleEdges(edgeA, edgeB) {
      if (!edgeA || !edgeB || edgeA === edgeB) return false;
      const label = normalizeBundleLabel(edgeA);
      if (!label || label !== normalizeBundleLabel(edgeB)) return false;
      if (edgeA.from !== edgeB.from || edgeA.to === edgeB.to) return false;

      const targetZone = nodeRouteZone(edgeA.to);
      return targetZone !== 'inside' &&
             targetZone !== 'unknown' &&
             targetZone === nodeRouteZone(edgeB.to);
    }

    return {
      normalizeBundleLabel,
      nodeRouteZone,
      canBundleEdges
    };
  },

  createReservedDropSpecification({ allEdges, childIds, outgoingEdges, getAbs, getSz, getNode }) {
    function sourceReservedBottomDrops(edge) {
      if (!edge || !childIds.has(edge.from)) return [];

      const sourcePos = getAbs(edge.from);
      const sourceSize = getSz(edge.from);
      const sourceCx = sourcePos.x + sourceSize.w / 2;
      const sourceBot = sourcePos.y + sourceSize.h;
      const outgoing = outgoingEdges.get(edge.from) || [];
      const drops = [];

      for (const edgeIdx of outgoing) {
        const outgoingEdge = allEdges[edgeIdx];
        if (!outgoingEdge || outgoingEdge === edge) continue;

        const targetNode = getNode(outgoingEdge.to);
        if (!targetNode || (targetNode.type !== 'database' && targetNode.type !== 'container')) continue;

        const targetPos = getAbs(outgoingEdge.to);
        const targetSize = getSz(outgoingEdge.to);
        if (targetPos.y < sourceBot - 2) continue;

        const targetCx = targetPos.x + targetSize.w / 2;
        let dropX = null;
        if (targetNode.type === 'database') {
          if (Math.abs(sourceCx - targetCx) < Math.min(sourceSize.w, targetSize.w) / 2) {
            dropX = sourceCx;
          }
        } else {
          const overlapLeft = Math.max(sourcePos.x, targetPos.x);
          const overlapRight = Math.min(sourcePos.x + sourceSize.w, targetPos.x + targetSize.w);
          if (overlapRight - overlapLeft > 0) {
            const sharedX = (sourceCx + targetCx) / 2;
            dropX = Math.min(overlapRight, Math.max(overlapLeft, sharedX));
          }
        }

        if (dropX === null) continue;
        drops.push({
          a: { x: dropX, y: sourceBot },
          b: { x: dropX, y: targetPos.y }
        });
      }

      return drops;
    }

    function sourceReservedDropCrossings(segments, edge) {
      const drops = sourceReservedBottomDrops(edge);
      if (drops.length === 0) return 0;

      let crossings = 0;
      for (const segment of segments) {
        const horizontal = Math.abs(segment.a.y - segment.b.y) < 2;
        if (!horizontal) continue;

        const y = segment.a.y;
        const minX = Math.min(segment.a.x, segment.b.x);
        const maxX = Math.max(segment.a.x, segment.b.x);
        for (const drop of drops) {
          const minY = Math.min(drop.a.y, drop.b.y);
          const maxY = Math.max(drop.a.y, drop.b.y);
          if (
            y > minY + 4 &&
            y < maxY - 4 &&
            minX < drop.a.x - 4 &&
            maxX > drop.a.x + 4
          ) {
            crossings++;
          }
        }
      }

      return crossings;
    }

    return {
      sourceReservedBottomDrops,
      sourceReservedDropCrossings
    };
  },

  createDirectDropSpecification({ allEdges, getNode, getAbs, getSz }) {
    const isPaired = (node) => node && (node.type === 'database' || (node.type === 'message_bus' && node.local));
    function isDirectPairedEntry(edgeIdx) {
      const incoming = allEdges[edgeIdx];
      const incomingTarget = getNode(incoming.to);
      if (!isPaired(incomingTarget)) return false;

      const srcPos = getAbs(incoming.from);
      const srcSize = getSz(incoming.from);
      const tgtPos = getAbs(incoming.to);
      const tgtSize = getSz(incoming.to);
      const srcCx = srcPos.x + srcSize.w / 2;
      const tgtCx = tgtPos.x + tgtSize.w / 2;
      return tgtPos.y >= srcPos.y + srcSize.h - 2 &&
             Math.abs(srcCx - tgtCx) < Math.min(srcSize.w, tgtSize.w) / 2;
    }

    function isCenterReservedDbEdge(edgeIdx, { sp, ss, sourceCenterX }) {
      const outgoing = allEdges[edgeIdx];
      const targetNode = getNode(outgoing.to);
      if (!targetNode || targetNode.type !== 'database') return false;

      const targetPos = getAbs(outgoing.to);
      const targetSize = getSz(outgoing.to);
      const targetCenterX = targetPos.x + targetSize.w / 2;
      return targetPos.y >= sp.y + ss.h - 2 &&
             Math.abs(sourceCenterX - targetCenterX) < Math.min(ss.w, targetSize.w) / 2;
    }

    function directDatabaseDropRoute({ e, sp, tp, ss, ts, sBot, tTop, checkCollision }) {
      const tgtNode = getNode(e.to);
      if (!tgtNode || tgtNode.type !== 'database' || tp.y < sp.y + ss.h - 2) return null;

      const srcCx = sp.x + ss.w / 2;
      const tgtCx = tp.x + ts.w / 2;
      const centerTolerance = Math.min(ss.w, ts.w) / 2;
      if (Math.abs(srcCx - tgtCx) >= centerTolerance) return null;

      const candidate = {
        startPoint: { x: srcCx, y: sBot },
        endPoint: { x: tgtCx, y: tTop },
        bendPoints: []
      };
      return checkCollision(candidate) ? null : candidate;
    }

    return {
      isPaired,
      isDirectPairedEntry,
      isCenterReservedDbEdge,
      directDatabaseDropRoute
    };
  }
};
