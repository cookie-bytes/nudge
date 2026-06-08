const elk = new ELK();
    let ranks = {};
    const DIAGRAM_H_PAD = 80;

    // Main layout and rendering entrypoint called by Playwright
    window.renderDiagram = async function (diagramData) {
      try {
        const hasBoundary = (diagramData.nodes || []).some(n => n.type === 'boundary');
        let laidOutGraph;

        if (hasBoundary) {
          // Two-phase layout: size/centre boundary contents first, then place
          // external nodes above/below and route all edges manually.
          laidOutGraph = await layoutContainerDiagram(diagramData);
        } else {
          // Standard ELK layered layout for flat diagrams (C4Context etc.)
          const elkGraph = transformToElkGraph(diagramData);
          laidOutGraph = await elk.layout(elkGraph);

          // Pass 2: Refine port side connections based on actual Pass 1 coordinates
          let needsSecondPass = false;

          function findNodeInGraph(graphNode, id) {
            if (graphNode.id === id) return graphNode;
            if (graphNode.children) {
              for (const child of graphNode.children) {
                const found = findNodeInGraph(child, id);
                if (found) return found;
              }
            }
            return null;
          }

          function updatePortSide(nodeId, portId, side) {
            const node = findNodeInGraph(elkGraph, nodeId);
            if (node) {
              if (!node.ports) node.ports = [];
              let port = node.ports.find(p => p.id === portId);
              if (port) {
                if (!port.properties) port.properties = {};
                port.properties["port.side"] = side;
                port.properties["org.eclipse.elk.port.side"] = side;
                if (!port.layoutOptions) port.layoutOptions = {};
                port.layoutOptions["port.side"] = side;
                port.layoutOptions["org.eclipse.elk.port.side"] = side;
              } else {
                node.ports.push({
                  id: portId, width: 1, height: 1,
                  properties: { "port.side": side, "org.eclipse.elk.port.side": side },
                  layoutOptions: { "port.side": side, "org.eclipse.elk.port.side": side }
                });
              }
              node.layoutOptions["elk.portConstraints"] = "FIXED_SIDE";
              node.layoutOptions["portConstraints"] = "FIXED_SIDE";
              node.layoutOptions["org.eclipse.elk.portConstraints"] = "FIXED_SIDE";
              needsSecondPass = true;
            }
          }

          const direction = diagramData.layoutOptions && diagramData.layoutOptions["elk.direction"] || "DOWN";
          if (direction === "DOWN" && diagramData.edges) {
            const flatEdgesList = flattenEdges(laidOutGraph);
            const flatNodesList = flattenNodes(laidOutGraph, 0, 0);

            diagramData.edges.forEach((e, idx) => {
              const edgeId = `edge_${idx}`;
              const flatEdge = flatEdgesList.find(fe => fe.id === edgeId);
              if (flatEdge && flatEdge.sections && flatEdge.sections.length > 0) {
                const section = flatEdge.sections[0];
                const flatSrc = flatNodesList.find(fn => fn.id === e.from);
                const flatTgt = flatNodesList.find(fn => fn.id === e.to);
                if (flatSrc && flatTgt) {
                  const rankSrc = ranks[e.from] !== undefined ? ranks[e.from] : 0;
                  const rankTgt = ranks[e.to] !== undefined ? ranks[e.to] : 0;
                  if (rankSrc > rankTgt) {
                    const tgtLeft = flatTgt.x, tgtRight = flatTgt.x + flatTgt.width;
                    const srcCenter = flatSrc.x + flatSrc.width / 2;
                    const targetPortId = `${e.to}_port_in_${idx}`;
                    const pathPoints = [{ x: section.startPoint.x, y: section.startPoint.y }];
                    if (section.bendPoints) pathPoints.push(...section.bendPoints);
                    const pathMaxX = Math.max(...pathPoints.map(p => p.x));
                    const pathMinX = Math.min(...pathPoints.map(p => p.x));
                    if (srcCenter > tgtRight || pathMaxX > tgtRight) updatePortSide(e.to, targetPortId, "EAST");
                    else if (srcCenter < tgtLeft || pathMinX < tgtLeft) updatePortSide(e.to, targetPortId, "WEST");
                  }
                }
              }
            });
          }

          if (needsSecondPass) {
            console.log("Refining layout with side port constraints in Pass 2...");
            laidOutGraph = await elk.layout(elkGraph);
          }
        }

        // Render the graph using SVG (with 50px vertical offset for title)
        drawGraph(laidOutGraph, diagramData);

        const displayType = diagramData && diagramData.diagramType === "C4Container" ? "C4 Container Diagram" : "C4 Context Diagram";
        const titleText = `${displayType} : ${(diagramData && diagramData.title) || "Untitled"}`;
        const titleWidth = measureTextWidth(titleText, 16, true) + 60;
        const finalWidth = Math.max(laidOutGraph.width + DIAGRAM_H_PAD * 2, titleWidth);

        return {
          success: true,
          width: finalWidth,
          height: laidOutGraph.height + 50,
          nodes: flattenNodes(laidOutGraph, DIAGRAM_H_PAD, 50),
          edges: flattenEdges(laidOutGraph, DIAGRAM_H_PAD, 50)
        };
      } catch (err) {
        console.error("Rendering failed:", err);
        return { success: false, error: err.message };
      }
    };

    // ─── Two-phase container layout ────────────────────────────────────────────
    // Phase 1: topologically sort boundary children into layers, centre each
    //          layer inside the boundary, and derive boundary dimensions.
    // Phase 2: classify external nodes as callers (→ boundary) or callees
    //          (← boundary), place callers above and callees below, route
    //          all edges with simple orthogonal paths.
    async function layoutContainerDiagram(diagramData) {
      const options = diagramData.layoutOptions || {};
      const H_GAP   = Number(options["elk.spacing.nodeNode"] || 80);
      const V_GAP   = Number(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80);
      const B_PAD   = 80;   // boundary left/right/top padding
      const B_BOT   = 84;   // boundary bottom clearance (label area)
      const EXT_GAP = Number(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80);

      const plan = buildContainerZonePlan(diagramData);
      if (!plan) return null;
      const { boundaryNode, children, childIds, allEdges, extNodes, extMap, layers, nodeLayerIdx, nodeColIdx } = plan;
      let { aboveNodes, belowNodes, leftNodes, rightNodes } = plan;

      // Boundary dimensions
      const layerW = layers.map(l => l.reduce((s, n) => s + (n.width || 200), 0) + Math.max(0, l.length - 1) * H_GAP);
      const layerH = layers.map(l => Math.max(...l.map(n => n.height || 80)));
      const maxLW  = Math.max(...layerW, 200);
      const bndW   = maxLW + 2 * B_PAD;
      const bndH   = layerH.reduce((s, h) => s + h, 0) + Math.max(0, layers.length - 1) * V_GAP + B_PAD + B_BOT;

      // Position children relative to boundary
      const childPos = {};
      let ry = B_PAD;
      for (let i = 0; i < layers.length; i++) {
        let rx = (bndW - layerW[i]) / 2;
        for (const n of layers[i]) {
          childPos[n.id] = { x: rx, y: ry };
          rx += (n.width || 200) + H_GAP;
        }
        ry += layerH[i] + V_GAP;
      }

      // ── Phase 2b: Row widths and diagram dimensions ────────────────────────
      const rowW = arr => arr.length
        ? arr.reduce((s, n) => s + (n.width || 200), 0) + (arr.length - 1) * H_GAP
        : 0;
      const rowH = arr => arr.length ? Math.max(...arr.map(n => n.height || 80)) : 0;
      const aboveW = rowW(aboveNodes), aboveH = rowH(aboveNodes);
      const belowW = rowW(belowNodes), belowH = rowH(belowNodes);
      const sideW  = n => n.length ? Math.max(...n.map(x => x.width || 200)) + H_GAP : 0;

      const innerW   = Math.max(aboveW, bndW, belowW);
      const leftOff  = sideW(leftNodes);
      const totalW   = innerW + leftOff + sideW(rightNodes);

      const aboveGap = aboveNodes.length ? EXT_GAP : 0;
      const belowGap = belowNodes.length ? EXT_GAP : 0;
      const leftH = leftNodes.length
        ? leftNodes.reduce((s, n) => s + (n.height || 80), 0) + (leftNodes.length - 1) * V_GAP
        : 0;
      const rightH = rightNodes.length
        ? rightNodes.reduce((s, n) => s + (n.height || 80), 0) + (rightNodes.length - 1) * V_GAP
        : 0;
      const totalH   = aboveH + aboveGap + Math.max(bndH + belowGap + belowH, leftH, rightH);


      // ── Phase 2c: Absolute positions ──────────────────────────────────────
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
      { let y = bndY; for (const n of leftNodes)  { absPos[n.id] = { x: bndX - (n.width || 200) - H_GAP, y }; y += (n.height || 80) + V_GAP; } }
      { let y = bndY; for (const n of rightNodes) { absPos[n.id] = { x: bndX + bndW + H_GAP, y }; y += (n.height || 80) + V_GAP; } }

      // ── Phase 2d: Edge routing ─────────────────────────────────────────────
      function getAbs(id) {
        if (childIds.has(id)) return { x: bndX + childPos[id].x, y: bndY + childPos[id].y };
        return absPos[id] || { x: 0, y: 0 };
      }
      function getSz(id) {
        const n = extMap.get(id) || children.find(c => c.id === id);
        return n ? { w: n.width || 200, h: n.height || 80 } : { w: 200, h: 80 };
      }

      const leftSet  = new Set(leftNodes.map(n => n.id));
      const rightSet = new Set(rightNodes.map(n => n.id));

      function routeEdge(e) {
        const sp = getAbs(e.from), tp = getAbs(e.to);
        const ss = getSz(e.from),  ts = getSz(e.to);
        const scx = sp.x + ss.w / 2, tcx = tp.x + ts.w / 2;
        const sBot = sp.y + ss.h,    tTop = tp.y;
        const sTop = sp.y,           tBot = tp.y + ts.h;
        const sCy  = sp.y + ss.h / 2, tCy = tp.y + ts.h / 2;

        // Horizontal Z/S-curve routing for left/right column nodes
        if (leftSet.has(e.from) || rightSet.has(e.from) || leftSet.has(e.to) || rightSet.has(e.to)) {
          const isLeft = leftSet.has(e.from) || leftSet.has(e.to);
          const midX = isLeft ? (bndX - H_GAP / 2) : (bndX + bndW + H_GAP / 2);

          if (sp.x + ss.w <= tp.x + 10) {
            // Left→Right: exit right-center of source, enter left-center of target
            const startX = sp.x + ss.w, startY = sCy;
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
          if (Math.abs(scx - tcx) < 3) return { startPoint: {x: scx, y: sBot}, endPoint: {x: tcx, y: tTop}, bendPoints: [] };
          const my = (sBot + tTop) / 2;
          return { startPoint: {x: scx, y: sBot}, endPoint: {x: tcx, y: tTop}, bendPoints: [{x: scx, y: my}, {x: tcx, y: my}] };
        }
        if (sp.y >= tp.y + ts.h - 2) {
          // Target above
          if (Math.abs(scx - tcx) < 3) return { startPoint: {x: scx, y: sTop}, endPoint: {x: tcx, y: tBot}, bendPoints: [] };
          const my = (sTop + tBot) / 2;
          return { startPoint: {x: scx, y: sTop}, endPoint: {x: tcx, y: tBot}, bendPoints: [{x: scx, y: my}, {x: tcx, y: my}] };
        }
        // Same row — horizontal
        if (sp.x + ss.w <= tp.x) return { startPoint: {x: sp.x + ss.w, y: sCy}, endPoint: {x: tp.x, y: tCy}, bendPoints: [] };
        if (tp.x + ts.w <= sp.x) return { startPoint: {x: sp.x, y: sCy},        endPoint: {x: tp.x + ts.w, y: tCy}, bendPoints: [] };
        // Fallback: route above both
        const routeY = Math.min(sp.y, tp.y) - 40;
        return { startPoint: {x: scx, y: sTop}, endPoint: {x: tcx, y: tTop}, bendPoints: [{x: scx, y: routeY}, {x: tcx, y: routeY}] };
      }

      // ── Build output graph ─────────────────────────────────────────────────
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

      for (let idx = 0; idx < allEdges.length; idx++) {
        const e = allEdges[idx];
        const section = routeEdge(e);
        const labels = e.label ? (() => {
          const match = e.label.match(/^(.*?)\s*\[(.*?)\]$/);
          if (match) {
            const mainLines = wrapText(match[1].trim(), MAX_LABEL_WIDTH, 11);
            const techW = measureTextWidth(`[${match[2].trim()}]`, 11);
            const w = Math.max(...mainLines.map(l => measureTextWidth(l, 11)), techW);
            return [{ text: e.label, width: w, height: (mainLines.length + 1) * LINE_HEIGHT + 2 }];
          }
          const lines = wrapText(e.label, MAX_LABEL_WIDTH, 11);
          return [{ text: e.label, width: Math.max(...lines.map(l => measureTextWidth(l, 11))), height: lines.length * LINE_HEIGHT + 2 }];
        })() : [];
        out.edges.push({ id: `edge_${idx}`, sources: [e.from], targets: [e.to], labels, sections: [section] });
      }

      console.log(`[ContainerLayout] boundary ${bndW}×${bndH} | above=${aboveNodes.length} below=${belowNodes.length} left=${leftNodes.length} right=${rightNodes.length}`);
      return out;
    }

    // Shared helper: Kahn layering → barycenter sort → zone classification →
    // connectivity sort → LM override application.
    // Returns the data both layoutContainerDiagram and computeContainerPlan need.
    function buildContainerZonePlan(diagramData) {
      const boundaryNode = (diagramData.nodes || []).find(n => n.type === 'boundary');
      if (!boundaryNode) return null;

      const children = boundaryNode.children || [];
      const childIds = new Set(children.map(c => c.id));
      const allEdges = diagramData.edges || [];
      const intEdges = allEdges.filter(e => childIds.has(e.from) && childIds.has(e.to));
      const extEdges = allEdges.filter(e => childIds.has(e.from) !== childIds.has(e.to));

      // Kahn topological layer assignment
      const hasExternalIn = new Set();
      for (const e of extEdges) { if (childIds.has(e.to)) hasExternalIn.add(e.to); }
      const inDeg = new Map(children.map(n => [n.id, 0]));
      const adj   = new Map(children.map(n => [n.id, []]));
      for (const e of intEdges) {
        inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
        adj.get(e.from)?.push(e.to);
      }
      const layers = [];
      const done   = new Set();
      const zeroIndeg = children.filter(n => inDeg.get(n.id) === 0);
      layers.push(zeroIndeg);
      for (const n of zeroIndeg) {
        done.add(n.id);
        for (const nxt of (adj.get(n.id) || [])) inDeg.set(nxt, inDeg.get(nxt) - 1);
      }
      while (done.size < children.length) {
        const layer = children.filter(n => !done.has(n.id) && inDeg.get(n.id) === 0);
        if (layer.length === 0) { layers.push(children.filter(n => !done.has(n.id))); break; }
        layers.push(layer);
        for (const n of layer) {
          done.add(n.id);
          for (const nxt of (adj.get(n.id) || [])) inDeg.set(nxt, inDeg.get(nxt) - 1);
        }
      }

      // Barycenter sort within each layer to reduce edge crossings
      const colMap = new Map();
      layers[0].forEach((n, idx) => colMap.set(n.id, idx));
      for (let i = 1; i < layers.length; i++) {
        const barycenter = (node) => {
          const positions = [];
          for (const e of intEdges) {
            if (e.to === node.id && colMap.has(e.from)) positions.push(colMap.get(e.from));
            if (e.from === node.id && colMap.has(e.to)) positions.push(colMap.get(e.to));
          }
          if (positions.length === 0) return Infinity;
          return positions.reduce((a, b) => a + b, 0) / positions.length;
        };
        layers[i] = [...layers[i]].sort((a, b) => barycenter(a) - barycenter(b));
        layers[i].forEach((n, idx) => colMap.set(n.id, idx));
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
        boundaryNode, children, childIds, allEdges,
        extNodes, extMap, layers, nodeLayerIdx, nodeColIdx,
        aboveNodes, belowNodes, leftNodes, rightNodes
      };
    }

    // Returns a structured layout plan for LM verification checkpoints (no SVG rendered)
    window.computeContainerPlan = function(diagramData) {
      const MAX_ABOVE = 6;

      const plan = buildContainerZonePlan(diagramData);
      if (!plan) return null;
      const { boundaryNode, childIds, allEdges, layers, aboveNodes, belowNodes, leftNodes, rightNodes } = plan;

      const getZone = id => {
        if (childIds.has(id))              return 'boundary';
        if (aboveNodes.some(n => n.id === id)) return 'above';
        if (belowNodes.some(n => n.id === id)) return 'below';
        if (leftNodes.some(n => n.id === id))  return 'left';
        if (rightNodes.some(n => n.id === id)) return 'right';
        return 'unknown';
      };

      return {
        zones: {
          above: aboveNodes.map(n => ({ id: n.id, label: n.label, type: n.type })),
          below: belowNodes.map(n => ({ id: n.id, label: n.label, type: n.type })),
          left:  leftNodes.map(n => ({ id: n.id, label: n.label, type: n.type })),
          right: rightNodes.map(n => ({ id: n.id, label: n.label, type: n.type }))
        },
        boundary: {
          id: boundaryNode.id,
          label: boundaryNode.label,
          layers: layers.map(layer => layer.map(n => ({ id: n.id, label: n.label, type: n.type })))
        },
        crossZoneEdges: allEdges.map(e => ({
          from: e.from, to: e.to, label: e.label || '',
          fromZone: getZone(e.from), toZone: getZone(e.to)
        })),
        zoneDensity: {
          above: aboveNodes.length, below: belowNodes.length,
          left: leftNodes.length, right: rightNodes.length,
          maxAbove: MAX_ABOVE
        }
      };
    };

    // Transform raw nodes/edges/layoutOptions from YAML into ELK schema
    function transformToElkGraph(diagramData) {
      const options = diagramData.layoutOptions || {};
      
      const graph = {
        id: "root",
        layoutOptions: {
          "elk.algorithm": options["elk.algorithm"] || "layered",
          "elk.direction": options["elk.direction"] || "DOWN",
          "elk.hierarchyHandling": "INCLUDE_CHILDREN",
          "elk.spacing.nodeNode": String(options["elk.spacing.nodeNode"] || 80),
          "elk.layered.spacing.nodeNodeBetweenLayers": String(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80),
          "elk.spacing.edgeNode": String(options["elk.spacing.edgeNode"] || 40),
          "elk.spacing.edgeEdge": String(options["elk.spacing.edgeEdge"] || 30),
          "elk.padding": options["elk.padding"] || "[top=30,left=30,bottom=30,right=30]",
          // Enforce model order constraints on the layout engine
          "elk.layered.crossingMinimization.semiInteractive": "true",
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
          "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
          // Align nodes to favor straight edges
          "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
          "elk.layered.nodePlacement.favorStraightEdges": "true",
          "elk.portConstraints": "FREE",
          "elk.layered.allowNonFlowPortsToSwitchSides": "true"
        },
        children: [],
        edges: []
      };
      // Helper map to quickly find parent nodes
      const nodeMap = new Map();

      // --- LAYOUT CONSTRAINTS SOLVER ---
      const rules = diagramData.rules || [];
      ranks = {};

      // --- DIAGRAM-SPECIFIC LAYOUT POLICIES ---
      const DIAGRAM_LAYOUT_POLICIES = {
        C4Context: {
          getDefaultRank(type) {
            if (type === "person") return 0;
            if (type === "container" || type === "system") return 1;
            if (type === "external" || type === "database" || type === "message_bus") return 2;
            return 0;
          },
          applyLayerConstraints(node, rankVal) {
            if (node.type === "person") {
              node.layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST";
            } else if (node.type === "external" && rankVal >= 2) {
              node.layoutOptions["elk.layered.layering.layerConstraint"] = "LAST";
            }
          },
          applySensibleDefaults(nodes, edges, ranks) {
            if (!edges) return;
            for (const edge of edges) {
              const srcNode = findNodeById(edge.from);
              const tgtNode = findNodeById(edge.to);
              if (srcNode && tgtNode) {
                if (srcNode.type === "external" && ranks[tgtNode.id] === 0) {
                  ranks[srcNode.id] = 0;
                }
              }
            }
          }
        },

        C4Container: {
          getDefaultRank(type) {
            if (type === "person") return 0;
            if (type === "container" || type === "system") return 1;
            if (type === "database" || type === "message_bus") return 2;
            if (type === "external") return 3;
            return 0;
          },
          applyLayerConstraints(node, rankVal) {
            if (node.type === "person") {
              // node.layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST";
            } else if (node.type === "external" && rankVal >= 3) {
              node.layoutOptions["elk.layered.layering.layerConstraint"] = "LAST";
            }
          },
          applySensibleDefaults(nodes, edges, ranks) {
            if (!edges) return;
            for (const edge of edges) {
              const srcNode = findNodeById(edge.from);
              const tgtNode = findNodeById(edge.to);
              if (srcNode && tgtNode) {
                if (srcNode.type === "external" && ranks[tgtNode.id] === 0) {
                  ranks[srcNode.id] = 0;
                }
              }
            }
          }
        }
      };

      const policyType = diagramData.diagramType || "C4Context";
      const policy = DIAGRAM_LAYOUT_POLICIES[policyType] || DIAGRAM_LAYOUT_POLICIES["C4Context"];

      // Helper to find nodes by ID or Type
      function findNodesMatching(selector) {
        const matches = [];
        function traverse(nodeList) {
          for (const n of nodeList) {
            if (n.id === selector || n.type === selector) {
              matches.push(n);
            }
            if (n.children) traverse(n.children);
          }
        }
        traverse(diagramData.nodes || []);
        return matches;
      }

      // Helper to find a specific node by ID
      function findNodeById(id) {
        const matches = findNodesMatching(id);
        return matches.length > 0 ? matches[0] : null;
      }

      function initRanks(nodeList) {
        for (const n of nodeList) {
          ranks[n.id] = policy.getDefaultRank(n.type);
          if (n.children) initRanks(n.children);
        }
      }
      initRanks(diagramData.nodes || []);

      // Apply symmetrical flow adjustments for external nodes that point directly to people
      policy.applySensibleDefaults(diagramData.nodes, diagramData.edges, ranks);

      // 2. Resolve custom rules using Bellman-Ford style relaxation
      if (rules.length > 0) {
        // resolve custom ordering rules via Bellman-Ford relaxation
        for (let iter = 0; iter < 5; iter++) {
          for (const rule of rules) {
            const sources = findNodesMatching(rule.source);
            const targets = findNodesMatching(rule.target);

            for (const srcNode of sources) {
              for (const tgtNode of targets) {
                const srcVal = ranks[srcNode.id] !== undefined ? ranks[srcNode.id] : 0;
                const tgtVal = ranks[tgtNode.id] !== undefined ? ranks[tgtNode.id] : 0;

                if (rule.relation === 'above') {
                  if (srcVal >= tgtVal) {
                    ranks[tgtNode.id] = srcVal + 1;
                  }
                } else if (rule.relation === 'below') {
                  if (srcVal <= tgtVal) {
                    ranks[srcNode.id] = tgtVal + 1;
                  }
                }
              }
            }
          }
        }
      }

      // First pass: Process and register all nodes
      function processNodes(nodeList, parentNode = null) {
        // Sort nodeList using the resolved constraint ranks
        const sortedNodeList = [...nodeList].sort((a, b) => {
          const rankA = ranks[a.id] !== undefined ? ranks[a.id] : 0;
          const rankB = ranks[b.id] !== undefined ? ranks[b.id] : 0;
          return rankA - rankB;
        });

        const rankCounts = {};

        for (const rawNode of sortedNodeList) {
          const node = {
            id: rawNode.id,
            width: rawNode.width || 150,
            height: rawNode.height || 80,
            type: rawNode.type || "container",
            label: rawNode.label || rawNode.id,
            tech: rawNode.tech || "",
            description: rawNode.description || "",
            layoutOptions: {},
            edges: []
          };

          // Apply Layout Placement Hints
          const direction = options["elk.direction"] || "DOWN";
          const rankVal = ranks[node.id] !== undefined ? ranks[node.id] : 0;
          
          // Set layer constraints
          policy.applyLayerConstraints(node, rankVal);

          // Track the number of nodes in the same rank to offset them
          if (rankCounts[rankVal] === undefined) {
            rankCounts[rankVal] = 0;
          }
          const offsetIndex = rankCounts[rankVal];
          rankCounts[rankVal]++;

          // Hint coordinates for semi-interactive layout
          /*
          if (direction === "DOWN") {
            node.x = offsetIndex * 180; // Separate horizontally within the same row/layer
            node.y = rankVal * 200;
          } else {
            node.x = rankVal * 200;
            node.y = offsetIndex * 150; // Separate vertically within the same column/layer
          }
          */

          // If it's a boundary node, it's a container box for nested components
          if (rawNode.type === "boundary") {
            node.children = [];
            delete node.width;
            delete node.height;

            // Measure label width so boundary is always wide enough to display it fully.
            // CSS applies text-transform:uppercase and letter-spacing:0.05em — replicate both.
            const labelUpper = (rawNode.label || '').toUpperCase();
            const labelW = measureTextWidth(labelUpper, 14, false)
                           + labelUpper.length * (14 * 0.05);

            // Find the widest direct child so we can derive symmetric left/right padding.
            // minW is driven by whichever constraint is larger: label or content+padding.
            const maxChildW = (rawNode.children || []).reduce((mx, ch) => Math.max(mx, ch.width || 200), 0) || 200;
            const minWFromLabel   = Math.ceil(labelW + 2 * BOUNDARY_H_PAD);
            const minWFromContent = maxChildW + 2 * BOUNDARY_H_PAD;
            const minW = Math.max(minWFromLabel, minWFromContent);

            // Derive equal left/right padding so children are always centred inside the boundary.
            const hPad = Math.max(BOUNDARY_H_PAD, Math.round((minW - maxChildW) / 2));

            node.layoutOptions["elk.algorithm"] = "layered";
            // bottom = 50px clearance from last child + 14px font height + 20px below title
            node.layoutOptions["elk.padding"] = `[top=${BOUNDARY_H_PAD},left=${hPad},bottom=84,right=${hPad}]`;
            node.layoutOptions["elk.direction"] = options["elk.direction"] || "DOWN";
            node.layoutOptions["elk.layered.spacing.nodeNodeBetweenLayers"] = String(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80);
            node.layoutOptions["elk.spacing.nodeNode"] = String(options["elk.spacing.nodeNode"] || 80);
            node.layoutOptions["elk.nodeSize.constraints"] = "MINIMUM_SIZE";
            node.layoutOptions["elk.nodeSize.minimum"] = `(${minW}, 100)`;
          }

          nodeMap.set(rawNode.id, { node, parentId: parentNode ? parentNode.id : null });

          if (rawNode.children && rawNode.children.length > 0) {
            processNodes(rawNode.children, node);
          }
        }
      }

      processNodes(diagramData.nodes || []);

      // Assemble hierarchy based on node parent relationships
      for (const [id, record] of nodeMap.entries()) {
        if (record.parentId) {
          const parentRecord = nodeMap.get(record.parentId);
          parentRecord.node.children.push(record.node);
        } else {
          graph.children.push(record.node);
        }
      }

      // Helper to find ancestor path of a node ID
      function getAncestors(id) {
        const path = [];
        let current = nodeMap.get(id);
        while (current) {
          path.push(current.node.id);
          if (current.parentId) {
            current = nodeMap.get(current.parentId);
          } else {
            break;
          }
        }
        path.push("root");
        return path;
      }

      // Find closest common ancestor node or graph object
      function findClosestCommonAncestor(idA, idB) {
        const pathA = getAncestors(idA);
        const pathB = getAncestors(idB);

        for (const parentA of pathA) {
          if (pathB.includes(parentA)) {
            return parentA;
          }
        }
        return "root";
      }

      function addPortToNode(node, portId, side) {
        if (!node.ports) {
          node.ports = [];
        }
        if (!node.ports.find(p => p.id === portId)) {
          node.ports.push({
            id: portId,
            width: 1,
            height: 1,
            properties: {
              "port.side": side,
              "org.eclipse.elk.port.side": side
            },
            layoutOptions: {
              "port.side": side,
              "org.eclipse.elk.port.side": side
            }
          });
        }
        node.layoutOptions["elk.portConstraints"] = "FIXED_SIDE";
        node.layoutOptions["portConstraints"] = "FIXED_SIDE";
        node.layoutOptions["org.eclipse.elk.portConstraints"] = "FIXED_SIDE";
      }

      // Identify nodes involved in cross-hierarchy edges
      const crossHierarchyNodes = new Set();
      if (diagramData.edges) {
        diagramData.edges.forEach(e => {
          const srcRecord = nodeMap.get(e.from);
          const tgtRecord = nodeMap.get(e.to);
          if (srcRecord && tgtRecord && srcRecord.parentId !== tgtRecord.parentId) {
            crossHierarchyNodes.add(e.from);
            crossHierarchyNodes.add(e.to);
          }
        });
      }

      // Add Edges at their closest common ancestor
      if (diagramData.edges) {
        diagramData.edges.forEach((e, idx) => {
          const edge = {
            id: `edge_${idx}`,
            sources: [e.from],
            targets: [e.to],
            labels: e.label ? (() => {
              const match = e.label.match(/^(.*?)\s*\[(.*?)\]$/);
              if (match) {
                const mainText = match[1].trim();
                const techText = `[${match[2].trim()}]`;
                const mainLines = wrapText(mainText, MAX_LABEL_WIDTH, 11);
                const wrappedWidth = Math.max(...mainLines.map(l => measureTextWidth(l, 11)), measureTextWidth(techText, 11));
                return [{ text: e.label, width: wrappedWidth, height: (mainLines.length + 1) * LINE_HEIGHT + 2 }];
              } else {
                const lines = wrapText(e.label, MAX_LABEL_WIDTH, 11);
                const wrappedWidth = Math.max(...lines.map(l => measureTextWidth(l, 11)));
                return [{ text: e.label, width: wrappedWidth, height: lines.length * LINE_HEIGHT + 2 }];
              }
            })() : [],
            layoutOptions: {}
          };

          // Setup FIXED_SIDE ports based on layout direction and relative position rules
          // Only apply port-based routing when both nodes are at the same hierarchy level,
          // since cross-hierarchy edges with port references cause ELK resolution errors.
          const srcRecord = nodeMap.get(e.from);
          const tgtRecord = nodeMap.get(e.to);
          const direction = options["elk.direction"] || "DOWN";
          const sameParent = srcRecord && tgtRecord && srcRecord.parentId === tgtRecord.parentId;

          if (srcRecord && tgtRecord && direction === "DOWN") {
            const rankSrc = ranks[e.from] !== undefined ? ranks[e.from] : 0;
            const rankTgt = ranks[e.to] !== undefined ? ranks[e.to] : 0;
            const xSrc = srcRecord.node.x || 0;
            const xTgt = tgtRecord.node.x || 0;

            const isUpward = rankSrc > rankTgt;
            const isBypassing = Math.abs(rankSrc - rankTgt) > 1;

            const sourcePortId = `${e.from}_port_out_${idx}`;
            const targetPortId = `${e.to}_port_in_${idx}`;

            let srcSide = "SOUTH";
            let tgtSide = "NORTH";

            if (isUpward) {
              srcSide = "NORTH";
              if (xSrc > xTgt) {
                tgtSide = "EAST";
              } else if (xSrc < xTgt) {
                tgtSide = "WEST";
              } else {
                tgtSide = "SOUTH";
              }
            } else if (rankSrc === rankTgt) {
              srcSide = xSrc < xTgt ? "EAST" : "WEST";
              tgtSide = xSrc < xTgt ? "WEST" : "EAST";
            }

            // Override sides for message_bus symbols to support horizontal flow (left-in, right-out)
            if (tgtRecord.node.type === "message_bus") {
              tgtSide = "WEST";
            }
            if (srcRecord.node.type === "message_bus") {
              srcSide = "EAST";
            }

            const hasBoundaries = diagramData.nodes.some(n => n.type === 'boundary');
            const useSrcPort = sameParent && !crossHierarchyNodes.has(e.from) && !hasBoundaries;
            const useTgtPort = sameParent && !crossHierarchyNodes.has(e.to) && !hasBoundaries;

            if (useSrcPort) {
              addPortToNode(srcRecord.node, sourcePortId, srcSide);
              edge.sources = [sourcePortId];
            } else {
              edge.sources = [e.from];
            }

            if (useTgtPort) {
              addPortToNode(tgtRecord.node, targetPortId, tgtSide);
              edge.targets = [targetPortId];
            } else {
              edge.targets = [e.to];
            }
          }

          // Find nodes to check types for edge priority
          const srcNode = findNodeById(e.from);
          const tgtNode = findNodeById(e.to);
          if (srcNode && tgtNode) {
            // Sensible default: keep the primary user -> core container connection aligned
            if (srcNode.type === "person" && tgtNode.type === "container") {
              edge.layoutOptions["elk.layered.priority.straightness"] = "100";
            }
          }

          const ancestorId = findClosestCommonAncestor(e.from, e.to);
          if (ancestorId === "root") {
            graph.edges.push(edge);
          } else {
            const ancestorRecord = nodeMap.get(ancestorId);
            if (ancestorRecord) {
              ancestorRecord.node.edges.push(edge);
            } else {
              graph.edges.push(edge);
            }
          }
        });
      }

      return graph;
    }

    // Rough text width estimation to supply ELKjs for label spacing
    function measureTextWidth(text, fontSize, isBold = false) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const weight = isBold ? "bold" : "normal";
      ctx.font = `${weight} ${fontSize}px Outfit, sans-serif`;
      let w = ctx.measureText(text).width;
      if (isBold) {
        w += text.length * fontSize * 0.025; // Account for letter-spacing: 0.025em
      }
      return Math.ceil(w);
    }

    const MAX_LABEL_WIDTH = 120;
    const LINE_HEIGHT = 13;
    const BOUNDARY_H_PAD = 80;

    function wrapText(text, maxWidth, fontSize) {
      const words = text.split(' ');
      const lines = [];
      let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (measureTextWidth(test, fontSize) > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) lines.push(current);
      return lines;
    }

    function pointToBoxDist(px, py, box) {
      const dx = Math.max(box.x - px, 0, px - (box.x + box.width));
      const dy = Math.max(box.y - py, 0, py - (box.y + box.height));
      return Math.sqrt(dx * dx + dy * dy);
    }

    function lineSegmentIntersectsRect(p1, p2, rect) {
      // Pad the rectangle slightly so we don't graze the corners
      const pad = 8;
      const rx = rect.x - pad;
      const ry = rect.y - pad;
      const rw = rect.width + 2 * pad;
      const rh = rect.height + 2 * pad;

      function lineSegmentsIntersect(a1, a2, b1, b2) {
        const det = (a2.x - a1.x) * (b2.y - b1.y) - (b2.x - b1.x) * (a2.y - a1.y);
        if (det === 0) return false; // Parallel
        const lambda = ((b2.y - b1.y) * (b2.x - a1.x) + (b1.x - b2.x) * (b2.y - a1.y)) / det;
        const gamma = ((a1.y - a2.y) * (b2.x - a1.x) + (a2.x - a1.x) * (b2.y - a1.y)) / det;
        return (0 <= lambda && lambda <= 1) && (0 <= gamma && gamma <= 1);
      }

      // Check if either endpoint is inside the padded rect
      if (p1.x >= rx && p1.x <= rx + rw && p1.y >= ry && p1.y <= ry + rh) return true;
      if (p2.x >= rx && p2.x <= rx + rw && p2.y >= ry && p2.y <= ry + rh) return true;

      // Rect borders
      const rTopLeft = { x: rx, y: ry };
      const rTopRight = { x: rx + rw, y: ry };
      const rBotLeft = { x: rx, y: ry + rh };
      const rBotRight = { x: rx + rw, y: ry + rh };

      if (lineSegmentsIntersect(p1, p2, rTopLeft, rTopRight)) return true;
      if (lineSegmentsIntersect(p1, p2, rTopRight, rBotRight)) return true;
      if (lineSegmentsIntersect(p1, p2, rBotRight, rBotLeft)) return true;
      if (lineSegmentsIntersect(p1, p2, rBotLeft, rTopLeft)) return true;

      return false;
    }

    // Flatten nested children coordinates to absolute positions
    function flattenNodes(graphNode, parentX = 0, parentY = 0) {
      let flat = [];
      const absoluteX = parentX + (graphNode.x || 0);
      const absoluteY = parentY + (graphNode.y || 0);

      if (graphNode.id !== "root") {
        flat.push({
          id: graphNode.id,
          x: absoluteX,
          y: absoluteY,
          width: graphNode.width,
          height: graphNode.height,
          type: graphNode.type,
          label: graphNode.label
        });
      }

      if (graphNode.children) {
        for (const child of graphNode.children) {
          flat = flat.concat(flattenNodes(child, absoluteX, absoluteY));
        }
      }

      return flat;
    }

    // Flatten nested edges and convert coordinates to absolute space
    function flattenEdges(graphNode, parentX = 0, parentY = 0) {
      let flat = [];
      const absX = parentX + (graphNode.x || 0);
      const absY = parentY + (graphNode.y || 0);

      if (graphNode.edges) {
        for (const edge of graphNode.edges) {
          if (!edge.sections || edge.sections.length === 0) continue;
          
          const section = edge.sections[0];
          const flatEdge = {
            id: edge.id,
            sources: edge.sources,
            targets: edge.targets,
            sections: [{
              startPoint: { x: section.startPoint.x + absX, y: section.startPoint.y + absY },
              endPoint: { x: section.endPoint.x + absX, y: section.endPoint.y + absY }
            }],
            labels: edge.labels ? edge.labels.map(l => ({
              text: l.text,
              width: l.width,
              height: l.height
            })) : []
          };

          if (section.bendPoints) {
            flatEdge.sections[0].bendPoints = section.bendPoints.map(b => ({
              x: b.x + absX,
              y: b.y + absY
            }));
          }

          flat.push(flatEdge);
        }
      }

      if (graphNode.children) {
        for (const child of graphNode.children) {
          flat = flat.concat(flattenEdges(child, absX, absY));
        }
      }

      return flat;
    }

    // Draw graph to SVG elements
    function drawGraph(graph, diagramData) {
      const svg = document.getElementById("svg-root");
      // Clear layers
      const layers = ["title-layer", "boundaries-layer", "edges-layer", "nodes-layer", "edge-labels-layer"];
      layers.forEach(l => {
        const el = document.getElementById(l);
        if (el) el.innerHTML = "";
      });

      // Render diagram title
      const displayType = diagramData && diagramData.diagramType === "C4Container" ? "C4 Container Diagram" : "C4 Context Diagram";
      const titleText = `${displayType} : ${(diagramData && diagramData.title) || "Untitled"}`;
      const titleLayer = document.getElementById("title-layer");
      if (titleLayer) {
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", DIAGRAM_H_PAD);
        text.setAttribute("y", 35);
        text.setAttribute("class", "diagram-title-text");
        text.textContent = titleText;
        titleLayer.appendChild(text);
      }

      const titleWidth = measureTextWidth(titleText, 16, true) + 60;
      const finalWidth = Math.max(graph.width + DIAGRAM_H_PAD * 2, titleWidth);

      // Adjust viewport size dynamically (shifted vertically by +50px for title)
      svg.setAttribute("viewBox", `0 0 ${finalWidth} ${graph.height + 50}`);
      svg.style.width = `${finalWidth}px`;
      svg.style.height = `${graph.height + 50}px`;

      const allComponents = flattenNodes(graph, DIAGRAM_H_PAD, 50).filter(n => n.type !== 'boundary');
      const placedLabels = [];

      // Gather all edges and their exact drawn points to check for label-edge crossings
      const flatEdges = flattenEdges(graph, DIAGRAM_H_PAD, 50);
      const allEdgesPoints = flatEdges.map(fe => {
        const pStart = fe.sections[0].startPoint;
        const pEnd = fe.sections[0].endPoint;
        const sourceId = fe.sources[0];
        const targetId = fe.targets[0];
        const getBaseNodeId = (id) => id.split('_port_')[0];
        const srcNodeId = getBaseNodeId(sourceId);
        const tgtNodeId = getBaseNodeId(targetId);

        const collisionNodes = allComponents.filter(n => n.id !== srcNodeId && n.id !== tgtNodeId);
        let hasCollision = false;
        for (const comp of collisionNodes) {
          if (lineSegmentIntersectsRect(pStart, pEnd, comp)) {
            hasCollision = true;
            break;
          }
        }

        const points = [];
        if (hasCollision) {
          points.push(pStart);
          if (fe.sections[0].bendPoints) {
            points.push(...fe.sections[0].bendPoints);
          }
          points.push(pEnd);
        } else {
          points.push(pStart, pEnd);
        }

        return {
          id: fe.id,
          points
        };
      });

      // Helper to generate capitalized node type label, appending technology if present
      function getNodeTypeLabel(node) {
        let typeName = node.type;
        if (node.type === 'container') typeName = 'Container';
        else if (node.type === 'external') typeName = 'External System';
        else if (node.type === 'person') typeName = 'Person';
        else if (node.type === 'database') typeName = 'Database';
        else if (node.type === 'message_bus') typeName = 'Message Bus';
        else {
          typeName = node.type.charAt(0).toUpperCase() + node.type.slice(1);
        }
        return node.tech ? `${typeName}: ${node.tech}` : typeName;
      }

      // Helper for rendering the foreignObject text container
      function appendNodeText(node, x, y, width, height, typeLabelText, container) {
        const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
        fo.setAttribute("x", x);
        fo.setAttribute("y", y);
        fo.setAttribute("width", width);
        fo.setAttribute("height", height);

        const wrapper = document.createElement("div");
        wrapper.className = "node-content-wrapper";

        const title = document.createElement("div");
        title.className = "node-title";
        title.textContent = node.label;
        wrapper.appendChild(title);

        const typeLabel = document.createElement("div");
        typeLabel.className = "node-type";
        typeLabel.textContent = typeLabelText;
        wrapper.appendChild(typeLabel);

        if (node.description) {
          const desc = document.createElement("div");
          desc.className = "node-desc";
          desc.textContent = node.description;
          wrapper.appendChild(desc);
        }

        fo.appendChild(wrapper);
        container.appendChild(fo);
      }

      // Drawing strategies for different node types
      const shapeStrategies = {
        boundary(node, absX, absY, layers) {
          const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          rect.setAttribute("x", absX);
          rect.setAttribute("y", absY);
          rect.setAttribute("width", node.width);
          rect.setAttribute("height", node.height);
          rect.setAttribute("class", "boundary");
          layers.boundaries.appendChild(rect);

          const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
          text.setAttribute("x", absX + BOUNDARY_H_PAD);
          text.setAttribute("y", absY + node.height - 20); // 20px above boundary bottom edge
          text.setAttribute("class", "boundary-label");
          text.textContent = node.label;
          layers.boundaries.appendChild(text);
        },

        person(node, absX, absY, layers) {
          const W = node.width, H = node.height;
          // Head: circle at top center
          const cxHead = absX + W / 2;
          const cyHead = absY + H * 0.11;
          const rHead = H * 0.16;

          const headCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          headCircle.setAttribute("cx", cxHead);
          headCircle.setAttribute("cy", cyHead);
          headCircle.setAttribute("r", rHead);
          headCircle.setAttribute("class", "person-head");
          layers.nodes.appendChild(headCircle);

          // Shoulders / bust path: bottom half of the space (New Visual Shape Guideline)
          const yShoulderStart = absY + H * 0.25;
          const yBottomLimit = absY + H;
          const yMaxW = absY + H * 0.81;

          const inset = W * 0.1;
          const xLeft = absX + inset;
          const xRight = absX + W - inset;
          const xCenter = absX + W / 2;
          const wTorso = W - 2 * inset;
          const bodyPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          const rNeck = Math.sqrt((wTorso * 0.20) ** 2 + (yShoulderStart + 1.5 - cyHead) ** 2);
          const xPeakR = xCenter + wTorso * 0.22;
          const xPeakL = xCenter - wTorso * 0.22;

          bodyPath.setAttribute("d", [
            `M ${xCenter} ${yBottomLimit}`,
            `Q ${xRight - wTorso * 0.25} ${yBottomLimit} ${xRight} ${yMaxW}`,
            `C ${xRight} ${absY + H * 0.62}, ${xCenter + wTorso * 0.35} ${yShoulderStart + H * 0.16}, ${xCenter + wTorso * 0.24} ${yShoulderStart + 2.5}`,
            `Q ${xPeakR} ${yShoulderStart} ${xCenter + wTorso * 0.20} ${yShoulderStart + 1.5}`,
            `A ${rNeck} ${rNeck} 0 0 1 ${xCenter - wTorso * 0.20} ${yShoulderStart + 1.5}`,
            `Q ${xPeakL} ${yShoulderStart} ${xCenter - wTorso * 0.24} ${yShoulderStart + 2.5}`,
            `C ${xCenter - wTorso * 0.35} ${yShoulderStart + H * 0.16}, ${xLeft} ${absY + H * 0.62}, ${xLeft} ${yMaxW}`,
            `Q ${xLeft + wTorso * 0.25} ${yBottomLimit} ${xCenter} ${yBottomLimit}`,
            `Z`
          ].join(' '));
          bodyPath.setAttribute("class", `node node-person`);
          layers.nodes.appendChild(bodyPath);

          // Text content centered inside the shoulder/bust area
          const textY = absY + H * 0.36;
          const textH = H - (H * 0.36) - 8;
          appendNodeText(node, absX + 20, textY, W - 40, textH, `[${getNodeTypeLabel(node)}]`, layers.nodes);
        },

        database(node, absX, absY, layers) {
          const eRy = Math.max(12, Math.round(node.width * 0.08));
          const eRx = node.width / 2;
          const cxDb = absX + eRx;
          const W = node.width, H = node.height;
          const textStartTop = 2 * eRy + 8;

          // Body: left side, bottom arc (sweep=1 curves DOWN), right side.
          const bodyPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          bodyPath.setAttribute("d", [
            `M ${absX} ${absY + eRy}`,
            `L ${absX} ${absY + H - eRy}`,
            `A ${eRx} ${eRy} 0 0 0 ${absX + W} ${absY + H - eRy}`,
            `L ${absX + W} ${absY + eRy}`
          ].join(' '));
          bodyPath.setAttribute("class", `node node-database`);
          layers.nodes.appendChild(bodyPath);

          // Top ellipse cap
          const topEllipse = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
          topEllipse.setAttribute("cx", cxDb);
          topEllipse.setAttribute("cy", absY + eRy);
          topEllipse.setAttribute("rx", eRx);
          topEllipse.setAttribute("ry", eRy);
          topEllipse.setAttribute("class", "db-cap");
          layers.nodes.appendChild(topEllipse);

          appendNodeText(node, absX, absY + textStartTop, W, H - textStartTop - eRy, `[${getNodeTypeLabel(node)}]`, layers.nodes);
        },

        message_bus(node, absX, absY, layers) {
          const H = node.height, W = node.width;
          const eRy = H / 2;
          const eRx = Math.max(12, Math.round(H * 0.18));
          const cxBus = absX + eRx;

          // Body: horizontal tube.
          const bodyPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
          bodyPath.setAttribute("d", [
            `M ${absX + eRx} ${absY}`,
            `L ${absX + W - eRx} ${absY}`,
            `A ${eRx} ${eRy} 0 0 1 ${absX + W - eRx} ${absY + H}`,
            `L ${absX + eRx} ${absY + H}`
          ].join(' '));
          bodyPath.setAttribute("class", `node node-message-bus`);
          layers.nodes.appendChild(bodyPath);

          // Left ellipse cap
          const leftEllipse = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
          leftEllipse.setAttribute("cx", cxBus);
          leftEllipse.setAttribute("cy", absY + eRy);
          leftEllipse.setAttribute("rx", eRx);
          leftEllipse.setAttribute("ry", eRy);
          leftEllipse.setAttribute("class", "message-bus-cap");
          layers.nodes.appendChild(leftEllipse);

          // Text content centered inside the cylinder straight-sides area
          const textX = absX + 2 * eRx + 4;
          const textW = W - 3 * eRx - 8;
          appendNodeText(node, textX, absY, textW, H, `[${getNodeTypeLabel(node)}]`, layers.nodes);
        },

        default(node, absX, absY, layers) {
          const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          rect.setAttribute("x", absX);
          rect.setAttribute("y", absY);
          rect.setAttribute("width", node.width);
          rect.setAttribute("height", node.height);
          rect.setAttribute("class", `node node-${node.type}`);
          layers.nodes.appendChild(rect);

          appendNodeText(node, absX, absY, node.width, node.height, `[${getNodeTypeLabel(node)}]`, layers.nodes);
        }
      };

      // Helper to render nodes recursively
      function renderNodeTree(node, absoluteParentX = 0, absoluteParentY = 0) {
        const absX = absoluteParentX + (node.x || 0);
        const absY = absoluteParentY + (node.y || 0);

        if (node.id !== "root") {
          const layers = {
            boundaries: document.getElementById("boundaries-layer"),
            nodes: document.getElementById("nodes-layer")
          };

          const strategy = shapeStrategies[node.type] || shapeStrategies.default;
          strategy(node, absX, absY, layers);
        }

        if (node.children) {
          node.children.forEach(c => renderNodeTree(c, absX, absY));
        }
      }

      // Draw edges recursively with parent offset
      function renderEdges(node, absoluteParentX = 0, absoluteParentY = 0) {
        const absX = absoluteParentX + (node.x || 0);
        const absY = absoluteParentY + (node.y || 0);

        if (node.edges) {
          const edgesLayer = document.getElementById("edges-layer");
          const labelsLayer = document.getElementById("edge-labels-layer");

          for (const edge of node.edges) {
            if (!edge.sections || edge.sections.length === 0) continue;
            
            const section = edge.sections[0];
            const pStart = { x: section.startPoint.x + absX, y: section.startPoint.y + absY };
            const pEnd = { x: section.endPoint.x + absX, y: section.endPoint.y + absY };

            // Determine if a straight line would collide with any other nodes
            const sourceId = edge.sources[0];
            const targetId = edge.targets[0];
            const getBaseNodeId = (id) => id.split('_port_')[0];
            const srcNodeId = getBaseNodeId(sourceId);
            const tgtNodeId = getBaseNodeId(targetId);

            const collisionNodes = allComponents.filter(n => n.id !== srcNodeId && n.id !== tgtNodeId);
            let hasCollision = false;
            for (const comp of collisionNodes) {
              if (lineSegmentIntersectsRect(pStart, pEnd, comp)) {
                hasCollision = true;
                break;
              }
            }

            let pathD = '';
            if (hasCollision) {
              // Draw orthogonal path with rounded corners (original logic)
              const CORNER_RADIUS = 10;
              const allPts = [
                pStart,
                ...(section.bendPoints || []).map(b => ({ x: b.x + absX, y: b.y + absY })),
                pEnd
              ];
              pathD = `M ${allPts[0].x} ${allPts[0].y}`;
              for (let i = 1; i < allPts.length - 1; i++) {
                const prev = allPts[i - 1], cur = allPts[i], next = allPts[i + 1];
                const dxIn = cur.x - prev.x, dyIn = cur.y - prev.y;
                const lenIn = Math.sqrt(dxIn * dxIn + dyIn * dyIn);
                const dxOut = next.x - cur.x, dyOut = next.y - cur.y;
                const lenOut = Math.sqrt(dxOut * dxOut + dyOut * dyOut);
                const r = Math.min(CORNER_RADIUS, lenIn / 2, lenOut / 2);
                const ax = cur.x - (dxIn / lenIn) * r, ay = cur.y - (dyIn / lenIn) * r;
                const bx = cur.x + (dxOut / lenOut) * r, by = cur.y + (dyOut / lenOut) * r;
                pathD += ` L ${ax} ${ay} Q ${cur.x} ${cur.y} ${bx} ${by}`;
              }
              pathD += ` L ${allPts[allPts.length - 1].x} ${allPts[allPts.length - 1].y}`;
            } else {
              // Draw straight line path directly
              pathD = `M ${pStart.x} ${pStart.y} L ${pEnd.x} ${pEnd.y}`;
            }

            // Draw edge path
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", pathD);
            path.setAttribute("class", "edge-line");
            path.setAttribute("marker-end", "url(#arrow)");
            edgesLayer.appendChild(path);

            // Draw labels on the segment with the most clearance from nearby nodes
            if (edge.labels && edge.labels.length > 0) {
              const label = edge.labels[0];

              const textWidth = label.width;
              const textHeight = label.height;

              // Extract all points along the chosen edge line style
              const points = [];
              if (hasCollision) {
                points.push(pStart);
                if (section.bendPoints) {
                  points.push(...section.bendPoints.map(b => ({ x: b.x + absX, y: b.y + absY })));
                }
                points.push(pEnd);
              } else {
                points.push(pStart, pEnd);
              }

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

              function boxesOverlap(boxA, boxB) {
                return (
                  boxA.x < boxB.x + boxB.width &&
                  boxA.x + boxA.width > boxB.x &&
                  boxA.y < boxB.y + boxB.height &&
                  boxA.y + boxA.height > boxB.y
                );
              }

              function checkLabelCollision(cx, cy, w, h, nodesList) {
                const labelBox = {
                  x: cx - w / 2 - 4,
                  y: cy - h / 2 - 2,
                  width: w + 8,
                  height: h + 4
                };
                for (const comp of nodesList) {
                  const compBox = {
                    x: comp.x,
                    y: comp.y,
                    width: comp.width,
                    height: comp.height
                  };
                  if (boxesOverlap(labelBox, compBox)) {
                    return true;
                  }
                }
                return false;
              }

              function lineSegmentIntersectsBox(p1, p2, box) {
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
              }

              function checkLabelEdgeCollision(cx, cy, w, h) {
                const labelBox = {
                  x: cx - w / 2 - 4,
                  y: cy - h / 2 - 2,
                  width: w + 8,
                  height: h + 4
                };
                for (const otherEdge of allEdgesPoints) {
                  if (otherEdge.id === edge.id) continue;
                  for (let i = 0; i < otherEdge.points.length - 1; i++) {
                    const p1 = otherEdge.points[i];
                    const p2 = otherEdge.points[i + 1];
                    if (lineSegmentIntersectsBox(p1, p2, labelBox)) {
                      return true;
                    }
                  }
                }
                return false;
              }

              let midX, midY;
              let placed = false;

              const obstacles = [...allComponents, ...placedLabels];

              // First Pass: Try to place label avoiding BOTH component collisions and other connection line crossings
              if (!hasCollision) {
                const candMid = getPointAtFraction(0.5);
                if (!checkLabelCollision(candMid.x, candMid.y, textWidth, textHeight, obstacles) &&
                    !checkLabelEdgeCollision(candMid.x, candMid.y, textWidth, textHeight)) {
                  midX = candMid.x;
                  midY = candMid.y;
                  placed = true;
                }
              }

              if (!placed && points.length >= 2) {
                const pLastPrev = points[points.length - 2];
                const pLastEnd = points[points.length - 1];
                const lastIsHorizontal = Math.abs(pLastPrev.y - pLastEnd.y) < 2;
                const targetAnchorDist = lastIsHorizontal
                  ? Math.max(45, (textWidth / 2) + 20)
                  : Math.max(45, (textHeight / 2) + 20);

                if (totalLen >= 2 * targetAnchorDist) {
                  const targetFraction = (totalLen - targetAnchorDist) / totalLen;
                  const candA = getPointAtFraction(targetFraction);
                  if (!checkLabelCollision(candA.x, candA.y, textWidth, textHeight, obstacles) &&
                      !checkLabelEdgeCollision(candA.x, candA.y, textWidth, textHeight)) {
                    midX = candA.x;
                    midY = candA.y;
                    placed = true;
                  }
                }
              }

              if (!placed && points.length >= 2) {
                const pFirstStart = points[0];
                const pFirstEnd = points[1];
                const firstIsHorizontal = Math.abs(pFirstStart.y - pFirstEnd.y) < 2;
                const sourceAnchorDist = firstIsHorizontal
                  ? Math.max(45, (textWidth / 2) + 20)
                  : Math.max(45, (textHeight / 2) + 20);

                if (totalLen >= 2 * sourceAnchorDist) {
                  const sourceFraction = sourceAnchorDist / totalLen;
                  const candB = getPointAtFraction(sourceFraction);
                  if (!checkLabelCollision(candB.x, candB.y, textWidth, textHeight, obstacles) &&
                      !checkLabelEdgeCollision(candB.x, candB.y, textWidth, textHeight)) {
                    midX = candB.x;
                    midY = candB.y;
                    placed = true;
                  }
                }
              }

              // Second Pass (Fallback): Try placing label avoiding component collisions, even if it overlaps other connection lines
              if (!placed) {
                if (!hasCollision) {
                  const candMid = getPointAtFraction(0.5);
                  if (!checkLabelCollision(candMid.x, candMid.y, textWidth, textHeight, obstacles)) {
                    midX = candMid.x;
                    midY = candMid.y;
                    placed = true;
                  }
                }
              }

              if (!placed && points.length >= 2) {
                const pLastPrev = points[points.length - 2];
                const pLastEnd = points[points.length - 1];
                const lastIsHorizontal = Math.abs(pLastPrev.y - pLastEnd.y) < 2;
                const targetAnchorDist = lastIsHorizontal
                  ? Math.max(45, (textWidth / 2) + 20)
                  : Math.max(45, (textHeight / 2) + 20);

                if (totalLen >= 2 * targetAnchorDist) {
                  const targetFraction = (totalLen - targetAnchorDist) / totalLen;
                  const candA = getPointAtFraction(targetFraction);
                  if (!checkLabelCollision(candA.x, candA.y, textWidth, textHeight, obstacles)) {
                    midX = candA.x;
                    midY = candA.y;
                    placed = true;
                  }
                }
              }

              if (!placed && points.length >= 2) {
                const pFirstStart = points[0];
                const pFirstEnd = points[1];
                const firstIsHorizontal = Math.abs(pFirstStart.y - pFirstEnd.y) < 2;
                const sourceAnchorDist = firstIsHorizontal
                  ? Math.max(45, (textWidth / 2) + 20)
                  : Math.max(45, (textHeight / 2) + 20);

                if (totalLen >= 2 * sourceAnchorDist) {
                  const sourceFraction = sourceAnchorDist / totalLen;
                  const candB = getPointAtFraction(sourceFraction);
                  if (!checkLabelCollision(candB.x, candB.y, textWidth, textHeight, obstacles)) {
                    midX = candB.x;
                    midY = candB.y;
                    placed = true;
                  }
                }
              }

              // Rule 3: Fallback to Middle Gutter Clearance
              if (!placed) {
                const nearbyNodes = allComponents.filter(n => n.id !== sourceId && n.id !== targetId);
                let bestSeg = null;
                let bestScore = -Infinity;
                for (let i = 0; i < points.length - 1; i++) {
                  const p1 = points[i];
                  const p2 = points[i + 1];
                  const dx = p2.x - p1.x;
                  const dy = p2.y - p1.y;
                  const len = Math.sqrt(dx * dx + dy * dy);
                  const mx = (p1.x + p2.x) / 2;
                  const my = (p1.y + p2.y) / 2;
                  const clearance = nearbyNodes.length > 0
                    ? Math.min(...nearbyNodes.map(n => pointToBoxDist(mx, my, n)))
                    : Infinity;
                  const score = clearance * 10 + len;
                  if (score > bestScore) { bestScore = score; bestSeg = { p1, p2 }; }
                }

                if (bestSeg) {
                  const isHorizontal = Math.abs(bestSeg.p1.y - bestSeg.p2.y) < 2;
                  if (isHorizontal) {
                    midY = bestSeg.p1.y;
                    const minX = Math.min(bestSeg.p1.x, bestSeg.p2.x);
                    const maxX = Math.max(bestSeg.p1.x, bestSeg.p2.x);
                    const padX = (textWidth / 2) + 20;
                    const rawMidX = (bestSeg.p1.x + bestSeg.p2.x) / 2;
                    midX = (maxX - minX >= 2 * padX)
                      ? Math.max(minX + padX, Math.min(maxX - padX, rawMidX))
                      : rawMidX;
                  } else {
                    midX = (bestSeg.p1.x + bestSeg.p2.x) / 2;
                    const LABEL_TARGET_BIAS = 0.85;
                    const edgeStart = points[0];
                    const edgeEnd   = points[points.length - 1];
                    const biasedY = edgeStart.y + LABEL_TARGET_BIAS * (edgeEnd.y - edgeStart.y);
                    
                    const minY = Math.min(bestSeg.p1.y, bestSeg.p2.y);
                    const maxY = Math.max(bestSeg.p1.y, bestSeg.p2.y);
                    const padY = (textHeight / 2) + 20;
                    const rawMidY = biasedY;
                    midY = (maxY - minY >= 2 * padY)
                      ? Math.max(minY + padY, Math.min(maxY - padY, rawMidY))
                      : (minY + maxY) / 2;
                  }
                } else {
                  midX = (points[0].x + points[points.length - 1].x) / 2;
                  midY = (points[0].y + points[points.length - 1].y) / 2;
                }
              }

              // Post-placement nudge: if final position overlaps an already-placed label
              // (Rule 3 / straight-middle don't check placedLabels during scoring), try vertical offsets.
              {
                const labelH = textHeight + 4;
                const labelW = textWidth + 8;
                const proposedBox = () => ({ x: midX - labelW / 2, y: midY - labelH / 2, width: labelW, height: labelH });
                if (placedLabels.some(pl => boxesOverlap(proposedBox(), pl))) {
                  const step = labelH + 4;
                  for (const dy of [-step, step, -2 * step, 2 * step, -3 * step, 3 * step]) {
                    const ty = midY + dy;
                    const testBox = { x: midX - labelW / 2, y: ty - labelH / 2, width: labelW, height: labelH };
                    if (!placedLabels.some(pl => boxesOverlap(testBox, pl)) &&
                        !checkLabelCollision(midX, ty, textWidth, textHeight, allComponents)) {
                      midY = ty;
                      break;
                    }
                  }
                }
              }

              const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
              bgRect.setAttribute("x", midX - textWidth / 2 - 4);
              bgRect.setAttribute("y", midY - textHeight / 2 - 2);
              bgRect.setAttribute("width", textWidth + 8);
              bgRect.setAttribute("height", textHeight + 4);
              bgRect.setAttribute("class", "edge-label-bg");
              labelsLayer.appendChild(bgRect);

              const match = label.text.match(/^(.*?)\s*\[(.*?)\]$/);
              if (match) {
                const mainText = match[1].trim();
                const techText = `[${match[2].trim()}]`;
                const mainLines = wrapText(mainText, MAX_LABEL_WIDTH, 11);
                const blockHeight = (mainLines.length + 1) * LINE_HEIGHT;
                let lineY = midY - blockHeight / 2 + LINE_HEIGHT * 0.8;

                for (const line of mainLines) {
                  const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
                  textEl.setAttribute("x", midX);
                  textEl.setAttribute("y", lineY);
                  textEl.setAttribute("class", "edge-label-text");
                  textEl.textContent = line;
                  labelsLayer.appendChild(textEl);
                  lineY += LINE_HEIGHT;
                }

                const techEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
                techEl.setAttribute("x", midX);
                techEl.setAttribute("y", lineY);
                techEl.setAttribute("class", "edge-label-text");
                techEl.setAttribute("style", "opacity: 0.85; font-size: 10px;");
                techEl.textContent = techText;
                labelsLayer.appendChild(techEl);
              } else {
                const lines = wrapText(label.text, MAX_LABEL_WIDTH, 11);
                const blockHeight = lines.length * LINE_HEIGHT;
                let lineY = midY - blockHeight / 2 + LINE_HEIGHT * 0.8;

                for (const line of lines) {
                  const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
                  textEl.setAttribute("x", midX);
                  textEl.setAttribute("y", lineY);
                  textEl.setAttribute("class", "edge-label-text");
                  textEl.textContent = line;
                  labelsLayer.appendChild(textEl);
                  lineY += LINE_HEIGHT;
                }
              }

              placedLabels.push({
                x: midX - (textWidth + 8) / 2,
                y: midY - (textHeight + 4) / 2,
                width: textWidth + 8,
                height: textHeight + 4
              });
            }
          }
        }

        if (node.children) {
          node.children.forEach(c => renderEdges(c, absX, absY));
        }
      }

      // 1. Draw nodes and boundary boxes (with vertical offset of 50px)
      renderNodeTree(graph, DIAGRAM_H_PAD, 50);

      // 2. Draw connector lines (edges) recursively (with vertical offset of 50px)
      renderEdges(graph, DIAGRAM_H_PAD, 50);
    };
