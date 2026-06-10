window.NudgeRenderer.containerPlan = {
  buildContainerZonePlan(diagramData) {
    const boundaryNode = (diagramData.nodes || []).find(n => n.type === 'boundary');
    if (!boundaryNode) return null;

    const children = boundaryNode.children || [];
    const childIds = new Set(children.map(c => c.id));
    const allEdges = diagramData.edges || [];
    const intEdges = allEdges.filter(e => childIds.has(e.from) && childIds.has(e.to));
    const extEdges = allEdges.filter(e => childIds.has(e.from) !== childIds.has(e.to));

    // Exclude message buses and databases from the topological sort. Both
    // node types get their own dedicated rows reinserted after the rest of
    // the layout has settled: buses as a horizontal spine in the middle,
    // databases as a dedicated row directly beneath their connecting
    // service so storage sits visually paired with its owner.
    const busIds = new Set(children.filter(n => n.type === 'message_bus').map(n => n.id));
    const dbIds  = new Set(children.filter(n => n.type === 'database').map(n => n.id));
    const excludeIds = new Set([...busIds, ...dbIds]);
    const sortChildren = excludeIds.size > 0 ? children.filter(n => !excludeIds.has(n.id)) : children;
    const sortEdges = excludeIds.size > 0
      ? intEdges.filter(e => !excludeIds.has(e.from) && !excludeIds.has(e.to))
      : intEdges;

    // Kahn topological layer assignment
    const hasExternalIn = new Set();
    for (const e of extEdges) { if (childIds.has(e.to)) hasExternalIn.add(e.to); }
    const inDeg = new Map(sortChildren.map(n => [n.id, 0]));
    const adj   = new Map(sortChildren.map(n => [n.id, []]));
    for (const e of sortEdges) {
      inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
      adj.get(e.from)?.push(e.to);
    }
    const layers = [];
    const done   = new Set();
    const zeroIndeg = sortChildren.filter(n => inDeg.get(n.id) === 0);
    layers.push(zeroIndeg);
    for (const n of zeroIndeg) {
      done.add(n.id);
      for (const nxt of (adj.get(n.id) || [])) inDeg.set(nxt, inDeg.get(nxt) - 1);
    }
    while (done.size < sortChildren.length) {
      const layer = sortChildren.filter(n => !done.has(n.id) && inDeg.get(n.id) === 0);
      if (layer.length === 0) { layers.push(sortChildren.filter(n => !done.has(n.id))); break; }
      layers.push(layer);
      for (const n of layer) {
        done.add(n.id);
        for (const nxt of (adj.get(n.id) || [])) inDeg.set(nxt, inDeg.get(nxt) - 1);
      }
    }

    // Barycenter sort within each layer to reduce edge crossings.
    // Two-pass sweep:
    // 1. Downward (1 to N): pull each layer toward its parents above.
    // 2. Upward (N-1 to 0): pull each layer toward its children below.
    const colMap = new Map();
    const nodeToLayerIdx = new Map();
    layers.forEach((l, idx) => l.forEach(n => nodeToLayerIdx.set(n.id, idx)));

    const runSweep = (reverse) => {
      const start = reverse ? layers.length - 2 : 1;
      const end = reverse ? -1 : layers.length;
      const step = reverse ? -1 : 1;

      for (let i = start; i !== end; i += step) {
        const originalIndices = new Map(layers[i].map((n, idx) => [n.id, idx]));
        const barycenter = (node) => {
          const positions = [];
          for (const e of sortEdges) {
            const other = (e.to === node.id) ? e.from : (e.from === node.id ? e.to : null);
            if (other && colMap.has(other)) {
              const otherLayerIdx = nodeToLayerIdx.get(other);
              if (reverse ? (otherLayerIdx > i) : (otherLayerIdx < i)) {
                positions.push(colMap.get(other));
              }
            }
          }
          if (positions.length === 0) return colMap.get(node.id);
          return positions.reduce((a, b) => a + b, 0) / positions.length;
        };

        layers[i] = [...layers[i]].sort((a, b) => {
          const bA = barycenter(a);
          const bB = barycenter(b);
          if (Math.abs(bA - bB) > 0.001) return bA - bB;
          return originalIndices.get(a.id) - originalIndices.get(b.id);
        });
        layers[i].forEach((n, idx) => colMap.set(n.id, idx));
      }
    };

    // Initial map from Layer 0
    layers[0].forEach((n, idx) => colMap.set(n.id, idx));
    runSweep(false); // Downward
    runSweep(true);  // Upward

    const internalOrder = diagramData._layoutOverrides?.internalOrder || diagramData._internalOrder || {};
    for (const [layerKey, orderedIds] of Object.entries(internalOrder)) {
      if (!Array.isArray(orderedIds)) continue;
      const layerIdx = Number(layerKey);
      if (!Number.isInteger(layerIdx) || !layers[layerIdx]) continue;

      const orderRank = new Map(orderedIds.map((id, idx) => [id, idx]));
      if (!layers[layerIdx].some(node => orderRank.has(node.id))) continue;

      const originalRank = new Map(layers[layerIdx].map((node, idx) => [node.id, idx]));
      layers[layerIdx] = [...layers[layerIdx]].sort((a, b) => {
        const rankA = orderRank.has(a.id) ? orderRank.get(a.id) : orderedIds.length + originalRank.get(a.id);
        const rankB = orderRank.has(b.id) ? orderRank.get(b.id) : orderedIds.length + originalRank.get(b.id);
        return rankA - rankB;
      });
    }

    // Give message buses their own dedicated layer at the very bottom
    // of the boundary (corner-anchored) rather than competing with service
    // containers in the same row. This keeps the message bus as a clear
    // terminal hub in the bottom-right.
    // 'Local' message buses are excluded from corner-anchoring and instead
    // behave like databases (paired with their parent service).
    const cornerBusIds = new Set();
    if (busIds.size > 0 && layers.length > 0) {
      const busNodes = children.filter(n => busIds.has(n.id));
      for (const bus of busNodes) {
        if (bus.local) continue;
        const connCount = allEdges.reduce(
          (n, e) => n + (e.from === bus.id || e.to === bus.id ? 1 : 0), 0);
        bus._cornerAnchor = true;
        if (bus._cornerAnchor) {
          cornerBusIds.add(bus.id);
        }
      }
    }

    // Give each database (and 'local' message bus) its own dedicated row
    // directly beneath the deepest service that connects to it, so storage
    // is visually paired with its owner instead of being lumped into a
    // service row.
    const pairedIds = new Set([...dbIds, ...children.filter(n => n.type === 'message_bus' && n.local).map(n => n.id)]);
    if (pairedIds.size > 0 && layers.length > 0) {
      const pairedNodes = children.filter(n => pairedIds.has(n.id));
      const nodeLayer = new Map();
      layers.forEach((l, idx) => l.forEach(n => nodeLayer.set(n.id, idx)));
      const grouped = new Map();
      for (const node of pairedNodes) {
        let deepestLayer = -1;
        for (const e of intEdges) {
          const other = e.from === node.id ? e.to : (e.to === node.id ? e.from : null);
          if (other && nodeLayer.has(other)) {
            const l = nodeLayer.get(other);
            if (l > deepestLayer) deepestLayer = l;
          }
        }
        if (deepestLayer === -1) deepestLayer = layers.length - 1;
        if (!grouped.has(deepestLayer)) grouped.set(deepestLayer, []);
        grouped.get(deepestLayer).push(node);
      }
      const insertionPoints = [...grouped.keys()].sort((a, b) => b - a);
      for (const k of insertionPoints) {
        const nodes = grouped.get(k);
        layers.splice(k + 1, 0, nodes);
        nodes.forEach((n, idx) => colMap.set(n.id, idx));
      }
    }

    // Corner-anchor buses go in the very last row, right-aligned (handled
    // by the positioning pass). Appended after db rows so they sit beneath.
    if (cornerBusIds.size > 0) {
      const cornerBuses = children.filter(n => cornerBusIds.has(n.id));
      layers.push(cornerBuses);
      cornerBuses.forEach((n, idx) => colMap.set(n.id, idx));
    }

    // Layer and column index maps
    const nodeLayerIdx = new Map();
    for (let li = 0; li < layers.length; li++) {
      for (const n of layers[li]) nodeLayerIdx.set(n.id, li);
    }
    const maxLayerIdx = Math.max(0, layers.length - 1);
    const nodeColIdx  = new Map();
    for (let li = 0; li < layers.length; li++) {
      for (let ci = 0; ci < layers[li].length; ci++) nodeColIdx.set(layers[li][ci].id, ci);
    }

    // Classify external nodes by connectivity pattern and target layer depth
    const extNodes = (diagramData.nodes || []).filter(n => n.type !== 'boundary');
    const extMap   = new Map(extNodes.map(n => [n.id, n]));
    const zoneMap  = new Map();
    const unconnectedExt = [];

    for (const node of extNodes) {
      const callsIn  = extEdges.filter(e => e.from === node.id && childIds.has(e.to));
      const callsOut = extEdges.filter(e => e.to   === node.id && childIds.has(e.from));
      if (callsIn.length > 0 && callsOut.length === 0) {
        const allLayer0 = callsIn.every(e => (nodeLayerIdx.get(e.to) ?? 0) === 0);
        zoneMap.set(node.id, allLayer0 ? 'above' : 'left');
      } else if (callsOut.length > 0 && callsIn.length === 0) {
        const allDeepest = callsOut.every(e => (nodeLayerIdx.get(e.from) ?? maxLayerIdx) === maxLayerIdx);
        zoneMap.set(node.id, allDeepest ? 'below' : 'right');
      } else if (callsIn.length > 0 && callsOut.length > 0) {
        zoneMap.set(node.id, 'right');
      } else {
        unconnectedExt.push(node);
      }
    }

    const interExtEdges = allEdges.filter(e => extMap.has(e.from) && extMap.has(e.to));
    for (const node of unconnectedExt) {
      let zone = 'above';
      for (const e of interExtEdges) {
        const partnerId = e.from === node.id ? e.to : (e.to === node.id ? e.from : null);
        if (!partnerId) continue;
        const partnerZone = zoneMap.get(partnerId);
        if (partnerZone) { zone = partnerZone; break; }
      }
      zoneMap.set(node.id, zone);
    }

    let aboveNodes = extNodes.filter(n => zoneMap.get(n.id) === 'above');
    let belowNodes = extNodes.filter(n => zoneMap.get(n.id) === 'below');
    let leftNodes  = extNodes.filter(n => zoneMap.get(n.id) === 'left');
    let rightNodes = extNodes.filter(n => zoneMap.get(n.id) === 'right');

    // Connectivity-based stable sort within each zone
    const extNodeIndex = new Map(extNodes.map((n, idx) => [n.id, idx]));

    const getConnectedAvgLayer = (node) => {
      const connected = [];
      for (const e of extEdges) {
        if (e.from === node.id && childIds.has(e.to)) {
          const idx = nodeLayerIdx.get(e.to);
          if (idx !== undefined) connected.push(idx);
        } else if (e.to === node.id && childIds.has(e.from)) {
          const idx = nodeLayerIdx.get(e.from);
          if (idx !== undefined) connected.push(idx);
        }
      }
      if (connected.length === 0) return Infinity;
      return connected.reduce((a, b) => a + b, 0) / connected.length;
    };

    const getConnectedAvgCol = (node) => {
      const connected = [];
      for (const e of extEdges) {
        if (e.from === node.id && childIds.has(e.to)) {
          const idx = nodeColIdx.get(e.to);
          if (idx !== undefined) connected.push(idx);
        } else if (e.to === node.id && childIds.has(e.from)) {
          const idx = nodeColIdx.get(e.from);
          if (idx !== undefined) connected.push(idx);
        }
      }
      if (connected.length === 0) return Infinity;
      return connected.reduce((a, b) => a + b, 0) / connected.length;
    };

    const stableSort = (arr, getValueFn) => arr.sort((a, b) => {
      const valA = getValueFn(a), valB = getValueFn(b);
      if (valA !== valB) return valA - valB;
      return extNodeIndex.get(a.id) - extNodeIndex.get(b.id);
    });

    aboveNodes = stableSort(aboveNodes, getConnectedAvgCol);
    belowNodes = stableSort(belowNodes, getConnectedAvgCol);
    leftNodes  = stableSort(leftNodes,  getConnectedAvgLayer);
    rightNodes = stableSort(rightNodes, getConnectedAvgLayer);

    // Apply LM layout overrides (_layoutOverrides injected by cli.js checkpoint pipeline)
    const _ov = diagramData._layoutOverrides || {};
    if (_ov.zoneOverrides && Object.keys(_ov.zoneOverrides).length > 0) {
      for (const [nodeId, newZone] of Object.entries(_ov.zoneOverrides)) {
        aboveNodes = aboveNodes.filter(n => n.id !== nodeId);
        belowNodes = belowNodes.filter(n => n.id !== nodeId);
        leftNodes  = leftNodes.filter(n => n.id !== nodeId);
        rightNodes = rightNodes.filter(n => n.id !== nodeId);
        const node = extMap.get(nodeId);
        if (!node) continue;
        if (newZone === 'above')      aboveNodes.push(node);
        else if (newZone === 'below') belowNodes.push(node);
        else if (newZone === 'left')  leftNodes.push(node);
        else if (newZone === 'right') rightNodes.push(node);
      }
    }
    if (_ov.swapCommands && _ov.swapCommands.length > 0) {
      for (const cmd of _ov.swapCommands) {
        if (cmd.type !== 'SHIFT_ZONE') continue;
        const node = extMap.get(cmd.nodeId);
        if (!node) continue;
        aboveNodes = aboveNodes.filter(n => n.id !== cmd.nodeId);
        belowNodes = belowNodes.filter(n => n.id !== cmd.nodeId);
        leftNodes  = leftNodes.filter(n => n.id !== cmd.nodeId);
        rightNodes = rightNodes.filter(n => n.id !== cmd.nodeId);
        if (cmd.to === 'above')      aboveNodes.push(node);
        else if (cmd.to === 'below') belowNodes.push(node);
        else if (cmd.to === 'left')  leftNodes.push(node);
        else if (cmd.to === 'right') rightNodes.push(node);
      }
      const applySwaps = arr => {
        for (const cmd of _ov.swapCommands) {
          if (cmd.type !== 'SWAP_NODE_ORDER') continue;
          const iA = arr.findIndex(n => n.id === cmd.nodeA);
          const iB = arr.findIndex(n => n.id === cmd.nodeB);
          if (iA >= 0 && iB >= 0) [arr[iA], arr[iB]] = [arr[iB], arr[iA]];
        }
        return arr;
      };
      aboveNodes = applySwaps([...aboveNodes]);
      belowNodes = applySwaps([...belowNodes]);
      leftNodes  = applySwaps([...leftNodes]);
      rightNodes = applySwaps([...rightNodes]);
    }

    return {
      boundaryNode, children, childIds, allEdges, intEdges,
      extNodes, extMap, layers, nodeLayerIdx, nodeColIdx,
      aboveNodes, belowNodes, leftNodes, rightNodes
    };
  }
};
