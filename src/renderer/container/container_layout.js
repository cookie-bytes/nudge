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
    V_GAP,
    allEdges,
    children,
    childPos
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

    // Helper to align left/right nodes to their connected internal nodes
    const alignSideNodes = (nodes, isLeft) => {
      const nodeItems = nodes.map((n, idx) => {
        const connectedChildIds = new Set();
        if (allEdges) {
          for (const edge of allEdges) {
            if (edge.from === n.id && children.some(c => c.id === edge.to)) {
              connectedChildIds.add(edge.to);
            }
            if (edge.to === n.id && children.some(c => c.id === edge.from)) {
              connectedChildIds.add(edge.from);
            }
          }
        }

        let idealY = bndY + idx * ((n.height || 80) + V_GAP);
        if (connectedChildIds.size > 0 && childPos) {
          let sumY = 0;
          let count = 0;
          for (const cid of connectedChildIds) {
            const pos = childPos[cid];
            const childNode = children.find(c => c.id === cid);
            if (pos && childNode) {
              const absChildY = bndY + pos.y;
              sumY += absChildY + (childNode.height || 80) / 2;
              count++;
            }
          }
          if (count > 0) {
            idealY = (sumY / count) - (n.height || 80) / 2;
          }
        }

        return {
          node: n,
          idealY,
          height: n.height || 80
        };
      });

      nodeItems.sort((a, b) => a.idealY - b.idealY);

      const iterations = 50;
      for (let iter = 0; iter < iterations; iter++) {
        for (let i = 0; i < nodeItems.length - 1; i++) {
          const a = nodeItems[i];
          const b = nodeItems[i + 1];
          const minSpacing = a.height + V_GAP;
          if (b.idealY < a.idealY + minSpacing) {
            const overlap = (a.idealY + minSpacing) - b.idealY;
            a.idealY -= overlap / 2;
            b.idealY += overlap / 2;
          }
        }
      }

      for (const item of nodeItems) {
        const x = isLeft
          ? bndX - (item.node.width || 200) - leftCorrGap
          : bndX + bndW + rightCorrGap;
        absPos[item.node.id] = { x, y: Math.max(0, item.idealY) };
      }
    };

    alignSideNodes(leftNodes, true);
    alignSideNodes(rightNodes, false);

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
        // Anchor each paired node at the barycenter of ALL its consumers
        // (weighted by connection-line count), so a shared database drifts
        // between its consumers while a single-owner database stays
        // column-aligned beneath its owner for the Direct Database Drop.
        const placements = layer.map((node, origIdx) => {
          const consumerCenters = [];
          for (const e of intEdges) {
            const otherId = e.from === node.id ? e.to : (e.to === node.id ? e.from : null);
            if (!otherId || !childPos[otherId]) continue;
            const otherNode = children.find(c => c.id === otherId);
            if (!otherNode) continue;
            consumerCenters.push(childPos[otherId].x + (otherNode.width || 200) / 2);
          }
          const idealCenter = consumerCenters.length > 0
            ? consumerCenters.reduce((s, v) => s + v, 0) / consumerCenters.length
            : contentLeft + contentW / 2;
          return { node, origIdx, idealX: idealCenter - (node.width || 200) / 2 };
        });
        placements.sort((a, b) => a.idealX - b.idealX || a.origIdx - b.origIdx);

        // Iteratively push overlapping neighbours apart so each node stays
        // as close to its own barycenter as spacing allows.
        for (let iter = 0; iter < 50; iter++) {
          for (let p = 0; p < placements.length - 1; p++) {
            const a = placements[p], b = placements[p + 1];
            const minSpacing = (a.node.width || 200) + H_GAP;
            if (b.idealX < a.idealX + minSpacing) {
              const overlap = (a.idealX + minSpacing) - b.idealX;
              a.idealX -= overlap / 2;
              b.idealX += overlap / 2;
            }
          }
        }

        // Clamp the whole cluster inside the boundary.
        const clusterLeft  = placements[0].idealX;
        const clusterRight = placements[placements.length - 1].idealX + (placements[placements.length - 1].node.width || 200);
        let shift = 0;
        if (clusterLeft < contentLeft) shift = contentLeft - clusterLeft;
        else if (clusterRight > contentRight) shift = Math.max(contentLeft - clusterLeft, contentRight - clusterRight);

        for (const p of placements) {
          childPos[p.node.id] = { x: p.idealX + shift, y: ry };
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
    let maxX = totalW;
    let maxY = totalH;
    for (const n of extNodes) {
      const p = absPos[n.id]; if (!p) continue;
      maxX = Math.max(maxX, p.x + (n.width || 200));
      maxY = Math.max(maxY, p.y + (n.height || 80));
    }
    const out = { id: 'root', x: 0, y: 0, width: maxX, height: maxY, children: [], edges: [] };

    for (const n of extNodes) {
      const p = absPos[n.id]; if (!p) continue;
      out.children.push({ id: n.id, x: p.x, y: p.y, width: n.width || 200, height: n.height || 80, type: n.type, label: n.label, tech: n.tech || '', description: n.description || '', edges: [] });
    }
    out.children.push({
      id: boundaryNode.id, x: bndX, y: bndY, width: bndW, height: bndH,
      type: 'boundary', label: boundaryNode.label, description: boundaryNode.description || '',
      _synthetic: !!boundaryNode._synthetic,
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

