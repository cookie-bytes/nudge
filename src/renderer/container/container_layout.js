window.NudgeRenderer.containerLayout = {
  rowWidth(arr, H_GAP) {
    return arr.length
      ? arr.reduce((s, n) => s + (n.width || 200), 0) + (arr.length - 1) * H_GAP
      : 0;
  },

  rowHeight(arr) {
    return arr.length ? Math.max(...arr.map(n => n.height || 80)) : 0;
  },

  computeExternalCorridorGaps({ rightNodes, leftNodes, allEdges, H_GAP, MIN_CORRIDOR_SPACING }) {
    const _rc = new Set(rightNodes.map(n => n.id));
    const _lc = new Set(leftNodes.map(n => n.id));
    const rightEdgeN = allEdges.filter(e => _rc.has(e.from) || _rc.has(e.to)).length;
    const leftEdgeN  = allEdges.filter(e => _lc.has(e.from) || _lc.has(e.to)).length;
    const rightCorrGap = Math.max(H_GAP, (rightEdgeN + 1) * MIN_CORRIDOR_SPACING);
    const leftCorrGap  = Math.max(H_GAP, (leftEdgeN  + 1) * MIN_CORRIDOR_SPACING);
    return { rightEdgeN, leftEdgeN, rightCorrGap, leftCorrGap };
  },

  computeDiagramDimensions({
    aboveNodes,
    belowNodes,
    leftNodes,
    rightNodes,
    bndW,
    bndH,
    rightCorrGap,
    leftCorrGap,
    H_GAP,
    V_GAP,
    EXT_GAP
  }) {
    const rowW = arr => window.NudgeRenderer.containerLayout.rowWidth(arr, H_GAP);
    const rowH = arr => window.NudgeRenderer.containerLayout.rowHeight(arr);
    const aboveW = rowW(aboveNodes), aboveH = rowH(aboveNodes);
    const belowW = rowW(belowNodes), belowH = rowH(belowNodes);
    const innerW   = Math.max(aboveW, bndW, belowW);
    const leftOff  = leftNodes.length  ? Math.max(...leftNodes.map(x => x.width  || 200)) + leftCorrGap  : 0;
    const totalW   = innerW + leftOff + (rightNodes.length ? Math.max(...rightNodes.map(x => x.width || 200)) + rightCorrGap : 0);

    const aboveGap = aboveNodes.length ? EXT_GAP : 0;
    const belowGap = belowNodes.length ? EXT_GAP : 0;
    const leftH = leftNodes.length
      ? leftNodes.reduce((s, n) => s + (n.height || 80), 0) + (leftNodes.length - 1) * V_GAP
      : 0;
    const rightH = rightNodes.length
      ? rightNodes.reduce((s, n) => s + (n.height || 80), 0) + (rightNodes.length - 1) * V_GAP
      : 0;
    const totalH   = aboveH + aboveGap + Math.max(bndH + belowGap + belowH, leftH, rightH);

    return {
      aboveW,
      aboveH,
      belowW,
      belowH,
      innerW,
      leftOff,
      totalW,
      aboveGap,
      belowGap,
      leftH,
      rightH,
      totalH
    };
  },

  computeAbsolutePositions({
    aboveNodes,
    belowNodes,
    leftNodes,
    rightNodes,
    boundaryNode,
    aboveW,
    belowW,
    innerW,
    leftOff,
    bndW,
    bndH,
    aboveH,
    aboveGap,
    belowGap,
    leftCorrGap,
    rightCorrGap,
    H_GAP,
    V_GAP
  }) {
    const absPos = {};

    // Above row: centred over inner column
    {
      let x = leftOff + (innerW - aboveW) / 2;
      for (const n of aboveNodes) { absPos[n.id] = { x, y: 0 }; x += (n.width || 200) + H_GAP; }
    }

    // Boundary
    const bndX = leftOff + (innerW - bndW) / 2;
    const bndY = aboveH + aboveGap;
    absPos[boundaryNode.id] = { x: bndX, y: bndY };

    // Below row: centred
    {
      let x = leftOff + (innerW - belowW) / 2;
      const y = bndY + bndH + belowGap;
      for (const n of belowNodes) { absPos[n.id] = { x, y }; x += (n.width || 200) + H_GAP; }
    }

    // Left/right overflow nodes: stacked beside boundary
    { let y = bndY; for (const n of leftNodes)  { absPos[n.id] = { x: bndX - (n.width || 200) - leftCorrGap,  y }; y += (n.height || 80) + V_GAP; } }
    { let y = bndY; for (const n of rightNodes) { absPos[n.id] = { x: bndX + bndW + rightCorrGap, y }; y += (n.height || 80) + V_GAP; } }

    return { absPos, bndX, bndY };
  },

  createGeometryAccessors({
    childIds,
    bndX,
    bndY,
    childPos,
    absPos,
    extMap,
    children
  }) {
    function getAbs(id) {
      if (childIds.has(id)) return { x: bndX + childPos[id].x, y: bndY + childPos[id].y };
      return absPos[id] || { x: 0, y: 0 };
    }
    function getSz(id) {
      const n = extMap.get(id) || children.find(c => c.id === id);
      return n ? { w: n.width || 200, h: n.height || 80 } : { w: 200, h: 80 };
    }
    function getNode(id) {
      return extMap.get(id) || children.find(c => c.id === id);
    }

    return { getAbs, getSz, getNode };
  },

  // Position children relative to boundary. Database rows (and local buses)
  // are centred around the centroid of their parent nodes' centres so the
  // cluster reads as "belonging to" those services regardless of how many
  // share the same parent.
  computeChildPositions({
    layers,
    layerW,
    layerH,
    B_PAD,
    H_GAP,
    contentW,
    contentLeft,
    contentRight,
    intEdges,
    children,
    gapBefore
  }) {
    const childPos = {};
    let ry = B_PAD;
    for (let i = 0; i < layers.length; i++) {
      ry += gapBefore(i);
      const layer = layers[i];
      const isPairedRow = layer.length > 0 && layer.every(n => n.type === 'database' || (n.type === 'message_bus' && n.local));
      if (isPairedRow) {
        const placements = layer.map(node => {
          let deepest = null, deepestRow = -1;
          for (const e of intEdges) {
            const otherId = e.from === node.id ? e.to : (e.to === node.id ? e.from : null);
            if (!otherId) continue;
            const otherNode = children.find(c => c.id === otherId);
            if (!otherNode || !childPos[otherNode.id]) continue;
            const rowIdx = layers.findIndex(l => l.includes(otherNode));
            if (rowIdx > deepestRow) { deepestRow = rowIdx; deepest = otherNode; }
          }
          const parentX = deepest && childPos[deepest.id] ? childPos[deepest.id].x : contentLeft + (contentW - (node.width || 200)) / 2;
          const parentCenter = parentX + (deepest ? (deepest.width || 200) : 200) / 2;
          return { node, parentX, parentCenter };
        });
        placements.sort((a, b) => a.parentX - b.parentX);

        // Pack nodes left-to-right from each parent's x (preserves relative order)
        const rawPositions = [];
        let nextX = -Infinity;
        for (const p of placements) {
          const x = Math.max(p.parentX, nextX);
          rawPositions.push({ node: p.node, x });
          nextX = x + (p.node.width || 200) + H_GAP;
        }

        // Shift the packed cluster so it is centred on the parent centroid,
        // then clamp so no node can escape the boundary.
        const clusterLeft  = rawPositions[0].x;
        const clusterRight = rawPositions[rawPositions.length - 1].x + (rawPositions[rawPositions.length - 1].node.width || 200);
        const clusterWidth = clusterRight - clusterLeft;
        const parentCentroid = placements.reduce((s, p) => s + p.parentCenter, 0) / placements.length;
        const desiredStart  = parentCentroid - clusterWidth / 2;
        const clampedStart  = Math.max(contentLeft, Math.min(contentRight - clusterWidth, desiredStart));
        const shift = clampedStart - clusterLeft;

        for (const p of rawPositions) {
          childPos[p.node.id] = { x: p.x + shift, y: ry };
        }
      } else if (layer.some(n => n._cornerAnchor)) {
        // Corner-anchor row (e.g. message bus): right-align
        // so the node hugs the bottom-right of the boundary rather than
        // centring under the other rows.
        let rx = contentRight - layerW[i];
        for (const n of layer) {
          childPos[n.id] = { x: rx, y: ry };
          rx += (n.width || 200) + H_GAP;
        }
      } else {
        let rx = contentLeft + (contentW - layerW[i]) / 2;
        for (const n of layer) {
          childPos[n.id] = { x: rx, y: ry };
          rx += (n.width || 200) + H_GAP;
        }
      }
      ry += layerH[i];
    }
    return childPos;
  },

  assembleRootGraph({
    totalW,
    totalH,
    extNodes,
    absPos,
    boundaryNode,
    bndX,
    bndY,
    bndW,
    bndH,
    children,
    childPos
  }) {
    const out = { id: 'root', x: 0, y: 0, width: totalW, height: totalH, children: [], edges: [] };

    for (const n of extNodes) {
      const p = absPos[n.id]; if (!p) continue;
      out.children.push({ id: n.id, x: p.x, y: p.y, width: n.width || 200, height: n.height || 80, type: n.type, label: n.label, tech: n.tech || '', description: n.description || '', edges: [] });
    }
    out.children.push({
      id: boundaryNode.id, x: bndX, y: bndY, width: bndW, height: bndH,
      type: 'boundary', label: boundaryNode.label, description: boundaryNode.description || '',
      edges: [],
      children: children.map(n => ({ id: n.id, x: childPos[n.id].x, y: childPos[n.id].y, width: n.width || 200, height: n.height || 80, type: n.type, label: n.label, tech: n.tech || '', description: n.description || '', edges: [] }))
    });

    return out;
  },

  buildOutputEdges({ allEdges, routedSections, createConnectionLabel }) {
    const edges = [];
    for (let idx = 0; idx < allEdges.length; idx++) {
      const e = allEdges[idx];
      const section = routedSections[idx];
      const labels = e.label ? [createConnectionLabel(e.label)] : [];
      edges.push({ id: `edge_${idx}`, sources: [e.from], targets: [e.to], labels, sections: [section] });
    }
    return edges;
  }
};

