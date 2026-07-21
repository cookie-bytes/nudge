const elk = new ELK();
    let ranks = {};
    const DIAGRAM_H_PAD = 80;

    // Google Fonts serves Outfit with `unicode-range`, so the faces load lazily on
    // first use and `document.fonts.ready` resolves before any of them are fetched.
    //
    // Layout no longer depends on this: `renderer/shared/text.js` measures against
    // baked glyph metrics, so geometry is identical whether or not the font ever
    // arrives (INC-9). What still depends on it is what the PNG screenshot *looks*
    // like — text rasterised in the fallback face renders visibly differently from
    // Outfit. So this pass is now about pixel fidelity, not determinism.
    const FONT_SPECS = [];
    for (const size of [9, 10, 11, 12, 13, 14, 16]) {
      for (const weight of ['normal', 'bold', '300', '400', '500', '600', '700']) {
        FONT_SPECS.push(`${weight} ${size}px Outfit`);
      }
    }
    // `load()` only fetches the subsets matching its test string. Latin plus digits
    // and common punctuation covers every corpus label; non-Latin labels can still
    // re-trigger the lazy fetch on first measurement.
    const FONT_SAMPLE =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;!?\'"()[]{}<>/\\|-_+=@#$%&*';
    let fontsLoaded = null;
    function loadRendererFonts() {
      if (fontsLoaded) return fontsLoaded;
      // `allSettled`, never `all`: with fonts.gstatic.com unreachable every `load()`
      // rejects, and a rejection here would abort the render and emit no diagram.
      fontsLoaded = Promise.allSettled(
        FONT_SPECS.map(spec => document.fonts.load(spec, FONT_SAMPLE))
      );
      return fontsLoaded;
    }
    window.loadRendererFonts = loadRendererFonts;

    // Main layout and rendering entrypoint called by Playwright
    window.renderDiagram = async function (diagramData) {
      try {
        await document.fonts.ready;
        await loadRendererFonts();
        const hasBoundary = (diagramData.nodes || []).some(n => n.type === 'boundary');
        let laidOutGraph;

        if (hasBoundary) {
          // Two-phase layout: size/centre boundary contents first, then place
          // external nodes above/below and route all edges manually.
          laidOutGraph = await layoutContainerDiagram(diagramData);

          // --- Algorithmic Layout Optimization Rule ---
          const plan = diagramData._skipFaceRule
            ? null
            : window.NudgeRenderer.containerPlan.buildContainerZonePlan(diagramData);
          if (plan) {
            const { extNodes } = plan;
            
            const getLaidOutNodes = (graph) => {
              const res = [];
              for (const item of graph.children || []) {
                if (item.type === 'boundary') {
                  res.push({ id: item.id, x: item.x, y: item.y, width: item.width, height: item.height, type: 'boundary' });
                  for (const child of item.children || []) {
                    res.push({ id: child.id, x: item.x + child.x, y: item.y + child.y, width: child.width, height: child.height });
                  }
                } else {
                  res.push({ id: item.id, x: item.x, y: item.y, width: item.width, height: item.height });
                }
              }
              return res;
            };

            const edgeHasCollision = (edge, nodes) => {
              const section = edge.sections?.[0];
              if (!section) return false;
              const pts = [section.startPoint, ...(section.bendPoints || []), section.endPoint];
              for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i], p2 = pts[i + 1];
                for (const node of nodes) {
                  if (node.type === 'boundary' || node.id === 'boundary') continue;
                  if (edge.sources?.includes(node.id) || edge.targets?.includes(node.id)) continue;
                  
                  // Add a safety margin to check for tight clearance/proximity collisions (e.g. 45px)
                  const marginX = 45;
                  const marginY = 10;
                  const rect = { 
                    x: node.x - marginX, 
                    y: node.y - marginY, 
                    width: node.width + marginX * 2, 
                    height: node.height + marginY * 2 
                  };
                  if (lineSegmentIntersectsRect(p1, p2, rect)) {
                    return true;
                  }
                }
              }
              return false;
            };

            // Detect connection-line crossings: a proper interior intersection
            // between this connection line and any other routed line. Touches
            // at shared connection points do not count.
            const sectionPts = (edge) => {
              const s = edge.sections?.[0];
              if (!s) return [];
              return [s.startPoint, ...(s.bendPoints || []), s.endPoint];
            };
            const properIntersect = (a, b, c, d) => {
              const orient = (p, q, r) => {
                const v = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
                if (Math.abs(v) < 1e-9) return 0;
                return v > 0 ? 1 : -1;
              };
              const o1 = orient(a, b, c), o2 = orient(a, b, d);
              const o3 = orient(c, d, a), o4 = orient(c, d, b);
              return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
            };
            const edgeCrossesOtherLines = (edge, graph) => {
              const ptsA = sectionPts(edge);
              for (const other of graph.edges || []) {
                if (other === edge || other.id === edge.id) continue;
                const ptsB = sectionPts(other);
                for (let i = 0; i < ptsA.length - 1; i++) {
                  for (let j = 0; j < ptsB.length - 1; j++) {
                    if (properIntersect(ptsA[i], ptsA[i + 1], ptsB[j], ptsB[j + 1])) return true;
                  }
                }
              }
              return false;
            };

            // Count the connection points actually present on each face of the
            // destination element, classified from the routed sections rather
            // than inferred from plan layers/zones. Skips the connection line
            // being rerouted (excludeExtId) and lines from external entities
            // this pass already relocated (skipExtIds): a face stays eligible
            // when its only connection points came from earlier moves.
            const getFaceCounts = (destNodeId, graph, nodes, excludeExtId, skipExtIds) => {
              const counts = { top: 0, bottom: 0, left: 0, right: 0 };
              const dest = nodes.find(n => n.id === destNodeId);
              if (!dest) return counts;
              for (const ge of graph.edges || []) {
                const src = ge.sources?.[0], tgt = ge.targets?.[0];
                if (src !== destNodeId && tgt !== destNodeId) continue;
                const otherId = src === destNodeId ? tgt : src;
                if (otherId === excludeExtId) continue;
                if (skipExtIds && skipExtIds.has(otherId)) continue;
                const section = ge.sections?.[0];
                if (!section) continue;
                const pt = src === destNodeId ? section.startPoint : section.endPoint;
                const dTop = Math.abs(pt.y - dest.y);
                const dBottom = Math.abs(pt.y - (dest.y + dest.height));
                const dLeft = Math.abs(pt.x - dest.x);
                const dRight = Math.abs(pt.x - (dest.x + dest.width));
                const min = Math.min(dTop, dBottom, dLeft, dRight);
                if (min === dTop) counts.top++;
                else if (min === dBottom) counts.bottom++;
                else if (min === dLeft) counts.left++;
                else counts.right++;
              }
              return counts;
            };

            let currentNodes = getLaidOutNodes(laidOutGraph);
            diagramData._layoutOverrides = diagramData._layoutOverrides || {};
            diagramData._layoutOverrides.zoneOverrides = diagramData._layoutOverrides.zoneOverrides || {};

            const movedByLoop = new Set();
            console.log("[Optimizer] Loop started. extNodes count:", extNodes.length);
            for (const extNode of extNodes) {
              const connectedEdges = (laidOutGraph.edges || []).filter(e =>
                e.sources?.includes(extNode.id) || e.targets?.includes(extNode.id)
              );
              console.log(`[Optimizer] Ext node '${extNode.id}': edges count = ${connectedEdges.length}`);
              if (connectedEdges.length !== 1) continue;

              const edge = connectedEdges[0];

              const hasCol = edgeHasCollision(edge, currentNodes);
              const hasCross = !hasCol && edgeCrossesOtherLines(edge, laidOutGraph);
              console.log(`[Optimizer] Ext node '${extNode.id}' edge collision check: ${hasCol}, line crossing check: ${hasCross}`);
              if (hasCol || hasCross) {
                const destId = edge.sources[0] === extNode.id ? edge.targets[0] : edge.sources[0];
                const faceCounts = getFaceCounts(destId, laidOutGraph, currentNodes, extNode.id, movedByLoop);
                console.log(`[Optimizer] Face counts for '${destId}': ${JSON.stringify(faceCounts)}`);
                // Free faces first, then least-occupied; the collision
                // re-check below still gates every candidate move.
                const orderedFaces = ['bottom', 'left', 'right', 'top']
                  .sort((a, b) => faceCounts[a] - faceCounts[b]);

                for (const face of orderedFaces) {
                  const newZone = face === 'top' ? 'above' : (face === 'bottom' ? 'below' : face);
                  const oldZone = diagramData._layoutOverrides.zoneOverrides[extNode.id];
                  
                  diagramData._layoutOverrides.zoneOverrides[extNode.id] = newZone;
                  
                  const testGraph = await layoutContainerDiagram(diagramData);
                  if (testGraph) {
                    const testNodes = getLaidOutNodes(testGraph);
                    const testEdges = (testGraph.edges || []).filter(e =>
                      e.sources?.includes(extNode.id) || e.targets?.includes(extNode.id)
                    );
                    if (testEdges.length === 1 &&
                        !edgeHasCollision(testEdges[0], testNodes) &&
                        !edgeCrossesOtherLines(testEdges[0], testGraph)) {
                      laidOutGraph = testGraph;
                      currentNodes = testNodes;
                      movedByLoop.add(extNode.id);
                      console.log(`[Optimizer] Shifted external node '${extNode.id}' to face '${face}' (${newZone}) to resolve collision.`);
                      break;
                    }
                  }
                  if (oldZone !== undefined) {
                    diagramData._layoutOverrides.zoneOverrides[extNode.id] = oldZone;
                  } else {
                    delete diagramData._layoutOverrides.zoneOverrides[extNode.id];
                  }
                }
              }
            }
          }
        } else {
          // Standard ELK layered layout for flat diagrams (C4Context etc.)
          const { graph: elkGraph, ranks: newRanks } = window.NudgeRenderer.elkGraphTransform.transformToElkGraph({
            diagramData,
            createConnectionLabel,
            measureTextWidth,
            BOUNDARY_H_PAD
          });
          ranks = newRanks;
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

        window.NudgeRenderer.routeGeometry.orthogonalizeGraphConnectionLines(laidOutGraph);

        // Post-layout note positioning. Notes are annotations, not layout
        // participants: they are placed here, after the elements have been laid
        // out, using the same absolute coordinate space as the returned nodes
        // (DIAGRAM_H_PAD, 50). Positioned boxes are handed to the draw step and
        // returned so the geometry critic and exporter can see them.
        const noteWarnings = [];
        const flatNodesForNotes = flattenNodes(laidOutGraph, DIAGRAM_H_PAD, 50);
        const positionedNotes = positionNotes(
          diagramData.notes || [],
          flatNodesForNotes,
          (diagramData._layoutOverrides && diagramData._layoutOverrides.notePlacements) || {},
          noteWarnings
        );

        // Canvas must grow to fit any note extending past the node bounds on the
        // right/bottom (top/left overflow is handled by clamping in positionNotes).
        const NOTE_CANVAS_MARGIN = 16;
        let notesRight = 0, notesBottom = 0;
        for (const n of positionedNotes) {
          notesRight = Math.max(notesRight, n.x + n.width + NOTE_CANVAS_MARGIN);
          notesBottom = Math.max(notesBottom, n.y + n.height + NOTE_CANVAS_MARGIN);
        }

        const displayType = diagramData && diagramData.diagramType === "C4Container" ? "C4 Container Diagram" : "C4 Context Diagram";
        const titleText = `${displayType} : ${(diagramData && diagramData.title) || "Untitled"}`;
        const titleWidth = measureTextWidth(titleText, 16, true) + 60;
        const DIAGRAM_B_PAD = 40;

        // Legend (bottom-left): a horizontal key of the element kinds actually
        // present. Built before canvas sizing so its height/width can be
        // reserved, then positioned against the final canvas bottom.
        const legendModel = window.NudgeRenderer.legend.build(flatNodesForNotes, measureTextWidth);
        const LEGEND_MARGIN_TOP = 12, LEGEND_MARGIN_BOTTOM = 12;
        const legendReserve = legendModel ? LEGEND_MARGIN_TOP + legendModel.height + LEGEND_MARGIN_BOTTOM : 0;

        const finalWidth = Math.max(
          laidOutGraph.width + DIAGRAM_H_PAD * 2,
          titleWidth,
          notesRight,
          legendModel ? DIAGRAM_H_PAD * 2 + legendModel.width : 0
        );
        const finalHeight = Math.max(laidOutGraph.height + 50 + DIAGRAM_B_PAD, notesBottom) + legendReserve;

        const legendOriginX = DIAGRAM_H_PAD;
        const legendOriginY = legendModel ? finalHeight - LEGEND_MARGIN_BOTTOM - legendModel.height : 0;

        // Render the graph using SVG (with 50px vertical offset for title)
        const drawResult = window.NudgeRenderer.svgRenderer.drawGraph({
          graph: laidOutGraph,
          diagramData,
          notes: positionedNotes,
          canvasWidth: finalWidth,
          canvasHeight: finalHeight,
          DIAGRAM_H_PAD,
          BOUNDARY_H_PAD,
          measureTextWidth,
          flattenNodes,
          flattenEdges,
          pointToBoxDist,
          wrapText,
          MAX_LABEL_WIDTH,
          LINE_HEIGHT,
          legendModel,
          legendOriginX,
          legendOriginY
        });

        return {
          success: true,
          width: finalWidth,
          height: finalHeight,
          nodes: flattenNodes(laidOutGraph, DIAGRAM_H_PAD, 50),
          edges: flattenEdges(laidOutGraph, DIAGRAM_H_PAD, 50),
          notes: positionedNotes,
          warnings: [
            ...noteWarnings,
            // Declared UNSATISFIABLE label placements (INC-16). A saturated
            // corridor now produces a named, counted outcome instead of a
            // buried label and a success report.
            ...(drawResult?.unsatisfiableLabels ?? []).map(u =>
              `Connection Label "${u.text}" could not be placed clear of the layout (${u.reason}); it was re-wrapped and clamped into the canvas.`
            )
          ],
          unsatisfiableLabels: drawResult?.unsatisfiableLabels ?? [],
          // Surfaced so a test can assert the grid router handled every
          // relationship — the measurable retirement criterion for the legacy
          // router (docs/IMPROVEMENT_PLAN.md INC-20). Absent for flat/ELK
          // diagrams, which never enter the container routing pass.
          routerStats: laidOutGraph.routerStats ?? null
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
      const portHints = (diagramData._layoutOverrides && diagramData._layoutOverrides.portHints) ||
                        diagramData._portHints ||
                        {};
      const routeHints = (diagramData._layoutOverrides && diagramData._layoutOverrides.routeHints) ||
                         diagramData._routeHints ||
                         {};
      const H_GAP   = Number(options["elk.spacing.nodeNode"] || 80);
      const V_GAP   = Number(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80);
      const B_PAD   = 80;   // boundary left/right/top padding
      const B_BOT   = 84;   // boundary bottom clearance (label area)
      const EXT_GAP = Number(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80);
      const MIN_ROUTE_LINE_GAP = Math.max(18, Number(options["nudge.routing.minLineGap"] || 18));

      const plan = window.NudgeRenderer.containerPlan.buildContainerZonePlan(diagramData);
      if (!plan) return null;
      const { boundaryNode, children, childIds, allEdges, intEdges, extNodes, extMap, layers, nodeLayerIdx, nodeColIdx } = plan;
      let { aboveNodes, belowNodes, leftNodes, rightNodes } = plan;

      const incomingEdges = new Map();
      const outgoingEdges = new Map();
      allEdges.forEach((e, idx) => {
        if (!incomingEdges.has(e.to)) incomingEdges.set(e.to, []);
        incomingEdges.get(e.to).push(idx);

        if (!outgoingEdges.has(e.from)) outgoingEdges.set(e.from, []);
        outgoingEdges.get(e.from).push(idx);
      });

      window.NudgeRenderer.utilityRowRules.applyMessageBusWidthScaling(layers, allEdges);

      // Boundary dimensions. DB rows (and local buses) use the same vertical 
      // gap as service rows; visual pairing with the parent is established 
      // by x-centering.
      const DB_V_GAP = V_GAP;
      const isPairedLayer = window.NudgeRenderer.utilityRowRules.isPairedLayer;
      const layerW = layers.map(l => l.reduce((s, n) => s + (n.width || 200), 0) + Math.max(0, l.length - 1) * H_GAP);
      const layerH = layers.map(l => Math.max(0, ...l.map(n => n.height || 80)));
      const maxLW  = Math.max(...layerW, 200);
      const contentW = maxLW;

      function estimateLayerCenters() {
        const centers = new Map();
        for (let i = 0; i < layers.length; i++) {
          const layer = layers[i];
          const rowX = layer.some(n => n._cornerAnchor)
            ? contentW - layerW[i]
            : (contentW - layerW[i]) / 2;
          let x = rowX;
          for (const n of layer) {
            centers.set(n.id, { x: x + (n.width || 200) / 2, row: i, width: n.width || 200 });
            x += (n.width || 200) + H_GAP;
          }
        }
        return centers;
      }

      function estimateConnectorLaneCounts(centers) {
        const laneCounts = Array(layers.length).fill(0);

        function likelyDirectVertical(edge, src, tgt) {
          const srcNode = children.find(n => n.id === edge.from);
          const tgtNode = children.find(n => n.id === edge.to);
          if (!srcNode || !tgtNode) return false;
          if (Math.abs(src.row - tgt.row) !== 1) return false;
          const tolerance = Math.min(src.width, tgt.width) / 2;
          const isPaired = (node) => node.type === 'database' || (node.type === 'message_bus' && node.local);
          return Math.abs(src.x - tgt.x) < tolerance &&
                 (srcNode.type === 'container' || isPaired(srcNode)) &&
                 (tgtNode.type === 'container' || isPaired(tgtNode));
        }

        for (const edge of intEdges) {
          const src = centers.get(edge.from);
          const tgt = centers.get(edge.to);
          if (!src || !tgt || src.row === tgt.row) continue;
          if (likelyDirectVertical(edge, src, tgt)) continue;

          const isDown = tgt.row > src.row;
          const firstGap = isDown ? src.row + 1 : src.row;
          if (firstGap > 0 && firstGap < laneCounts.length) laneCounts[firstGap]++;

          const targetGap = isDown ? tgt.row : tgt.row + 1;
          if (Math.abs(tgt.row - src.row) > 1 && targetGap > 0 && targetGap < laneCounts.length) {
            laneCounts[targetGap]++;
          }
        }

        return laneCounts;
      }

      const connectorLaneCounts = estimateConnectorLaneCounts(estimateLayerCenters());
      const ROUTE_BAND_MARGIN = 18;
      const MAX_CONNECTOR_GAP_EXTRA = 80;
      const gapBefore = (i) => {
        if (i === 0) return 0;
        const baseGap = isPairedLayer(layers[i]) ? DB_V_GAP : V_GAP;
        const laneCount = connectorLaneCounts[i] || 0;
        if (laneCount <= 1) return baseGap;

        const requiredGap = ROUTE_BAND_MARGIN * 2 + laneCount * MIN_ROUTE_LINE_GAP;
        const extra = Math.min(MAX_CONNECTOR_GAP_EXTRA, Math.max(0, requiredGap - baseGap));
        return baseGap + extra;
      };

      function estimateInternalRoutePressure() {
        const centers = estimateLayerCenters();

        const pressure = { left: 0, right: 0 };
        for (const e of intEdges) {
          const src = centers.get(e.from);
          const tgt = centers.get(e.to);
          if (!src || !tgt) continue;
          const rowDistance = Math.abs(src.row - tgt.row);
          if (rowDistance < 2) continue;

          const sideX = Math.max(src.x, tgt.x);
          const leftX = Math.min(src.x, tgt.x);
          if (sideX > contentW * 0.62) pressure.right += rowDistance;
          if (leftX < contentW * 0.38) pressure.left += rowDistance;
        }
        return pressure;
      }

      const routePressure = estimateInternalRoutePressure();
      function corridorExtraForPressure(pressure) {
        if (pressure >= 8) return 120;
        if (pressure >= 4) return 80;
        return 0;
      }
      const leftPad = B_PAD + corridorExtraForPressure(routePressure.left);
      const rightPad = B_PAD + corridorExtraForPressure(routePressure.right);
      const contentLeft = leftPad;
      const contentRight = contentLeft + contentW;
      const bndW   = contentW + leftPad + rightPad;
      const bndH   = layerH.reduce((s, h) => s + h, 0) + layers.reduce((s, _, i) => s + gapBefore(i), 0) + B_PAD + B_BOT;

      const childPos = window.NudgeRenderer.containerLayout.computeChildPositions({
        layers, layerW, layerH, B_PAD, H_GAP, contentW, contentLeft, contentRight,
        intEdges, children, gapBefore
      });

      // ── Phase 2b: Row widths and diagram dimensions ────────────────────────
      const MIN_CORRIDOR_SPACING = 20;
      const { rightEdgeN, leftEdgeN, rightCorrGap, leftCorrGap } = window.NudgeRenderer.containerLayout.computeExternalCorridorGaps({
        rightNodes,
        leftNodes,
        allEdges,
        H_GAP,
        MIN_CORRIDOR_SPACING
      });

      const {
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
      } = window.NudgeRenderer.containerLayout.computeDiagramDimensions({
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
      });


      // ── Phase 2c: Absolute positions ──────────────────────────────────────
      const { absPos, bndX, bndY } = window.NudgeRenderer.containerLayout.computeAbsolutePositions({
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
      });

      // ── Phase 2d: Edge routing ─────────────────────────────────────────────
      const { getAbs, getSz, getNode } = window.NudgeRenderer.containerLayout.createGeometryAccessors({
        childIds,
        bndX,
        bndY,
        childPos,
        absPos,
        extMap,
        children
      });

      const leftSet  = new Set(leftNodes.map(n => n.id));
      const rightSet = new Set(rightNodes.map(n => n.id));
      const routedEdgeSegments = [];
      const ROUTE_BOUNDARY_CLEARANCE = 24;
      const LANE_OFFSETS = [
        0,
        -MIN_ROUTE_LINE_GAP,
        MIN_ROUTE_LINE_GAP,
        -MIN_ROUTE_LINE_GAP * 2,
        MIN_ROUTE_LINE_GAP * 2,
        -MIN_ROUTE_LINE_GAP * 3,
        MIN_ROUTE_LINE_GAP * 3
      ];
      const LANE_OVERLAP_THRESHOLD = 24;

      const {
        canBundleEdges
      } = window.NudgeRenderer.routeSpecifications.createBundleSpecification({
        leftSet,
        rightSet,
        aboveNodes,
        belowNodes,
        childIds
      });

      const {
        sectionToPoints,
        pointsToSection,
        pointsToSegments,
        clonePoints
      } = window.NudgeRenderer.routeGeometry;

      const {
        segmentOverlapLength,
        segmentParallelProximity,
        segmentOrientation,
        pointsNear,
        pointOnSegment,
        segmentsCross
      } = window.NudgeRenderer.routeGeometry.createConflictHelpers(MIN_ROUTE_LINE_GAP);

      function internalBoundaryClearanceHits(segments, edge) {
        if (!edge || !childIds.has(edge.from) || !childIds.has(edge.to)) return 0;

        let hits = 0;
        const leftLimit = bndX + ROUTE_BOUNDARY_CLEARANCE;
        const rightLimit = bndX + bndW - ROUTE_BOUNDARY_CLEARANCE;
        const topLimit = bndY + ROUTE_BOUNDARY_CLEARANCE;
        const bottomLimit = bndY + bndH - ROUTE_BOUNDARY_CLEARANCE;

        for (const segment of segments) {
          const minX = Math.min(segment.a.x, segment.b.x);
          const maxX = Math.max(segment.a.x, segment.b.x);
          const minY = Math.min(segment.a.y, segment.b.y);
          const maxY = Math.max(segment.a.y, segment.b.y);
          if (minX < leftLimit || maxX > rightLimit || minY < topLimit || maxY > bottomLimit) {
            hits++;
          }
        }

        return hits;
      }

      const {
        sourceReservedBottomDrops,
        sourceReservedDropCrossings
      } = window.NudgeRenderer.routeSpecifications.createReservedDropSpecification({
        allEdges,
        childIds,
        outgoingEdges,
        getAbs,
        getSz,
        getNode
      });

      const candidateRules = window.NudgeRenderer.routeCandidateRules.createCandidateRules({
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
      });

      function edgeConflictScore(points, edge) {
        const segments = pointsToSegments(points);
        let crossings = 0;
        let overlaps = 0;
        let overlapPx = 0;
        let closeParallels = 0;
        let closePx = 0;
        const boundaryHits = internalBoundaryClearanceHits(segments, edge);
        const sourceDropCrossings = sourceReservedDropCrossings(segments, edge);
        let nodeCrossings = 0;

        for (const segment of segments) {
          for (const existing of routedEdgeSegments) {
            const overlap = segmentOverlapLength(segment, existing);
            if (overlap > 20) {
              if (canBundleEdges(edge, allEdges[existing.edgeIndex])) continue;
              overlaps++;
              overlapPx += overlap;
            } else if (segmentsCross(segment, existing)) {
              crossings++;
            } else {
              const close = segmentParallelProximity(segment, existing);
              if (close > 20) {
                if (canBundleEdges(edge, allEdges[existing.edgeIndex])) continue;
                closeParallels++;
                closePx += close;
              }
            }
          }

          const allNodes = [...children, ...extNodes];
          for (const node of allNodes) {
            if (node.id === edge.from || node.id === edge.to) continue;
            const pos = getAbs(node.id);
            const sz = getSz(node.id);
            const rect = { x: pos.x, y: pos.y, width: sz.w, height: sz.h };
            if (lineSegmentIntersectsRect(segment.a, segment.b, rect)) {
              nodeCrossings++;
              break;
            }
          }
        }

        return {
          crossings,
          overlaps,
          overlapPx,
          closeParallels,
          closePx,
          boundaryHits,
          sourceDropCrossings,
          nodeCrossings,
          score:
            nodeCrossings * 10000 +
            boundaryHits * 5000 +
            sourceDropCrossings * 900 +
            overlaps * 120 +
            overlapPx +
            closeParallels * 90 +
            closePx * 0.8 +
            crossings * 180
        };
      }

      const {
        reserveRouteLanes
      } = window.NudgeRenderer.connectionLineRouter.createLaneReserver({
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
      });

      const {
        setRoutedSegmentsForSections,
        evaluateRouteSet
      } = window.NudgeRenderer.routeSetAnalysis.createEvaluator({
        allEdges,
        children,
        extNodes,
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
      });

      const {
        improveRoutedSections
      } = window.NudgeRenderer.connectionLineRouter.createImprover({
        allEdges,
        setRoutedSegmentsForSections,
        reserveRouteLanes,
        routeEdge,
        evaluateRouteSet
      });

      function routeEdge(e, idx) {
        return edgeRouter.routeEdge(e, idx);
      }

      // ── Build output graph ─────────────────────────────────────────────────
      const out = window.NudgeRenderer.containerLayout.assembleRootGraph({
        totalW, totalH, extNodes, absPos, boundaryNode, bndX, bndY, bndW, bndH, children, childPos
      });

      const hubPortAssignments = window.NudgeRenderer.connectionLineRouter.computeHubPortAssignments({
        children,
        allEdges,
        getAbs,
        getSz,
        portHints,
        rightSet,
        leftSet,
        MIN_ROUTE_LINE_GAP
      });
      const sideCorridorAssignments = window.NudgeRenderer.connectionLineRouter.computeSideCorridorAssignments({
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
      });
      const edgeRouter = window.NudgeRenderer.connectionLineRouter.createEdgeRouter({
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
        extNodes
      });
      // Grid router (default): A* over the orthogonal visibility graph.
      // Lines it cannot route (e.g. endpoints that are not placed leaf
      // elements) fall back to the legacy candidate router per edge.
      // NUDGE_ROUTER=legacy switches the whole pass back to the old router.
      const routerMode = diagramData._router || window.__nudgeRouter || 'grid';
      const useGridRouter = routerMode !== 'legacy';
      const routedSections = [];
      if (useGridRouter) {
        const routableBoxes = [...children, ...extNodes].map(n => {
          const pos = getAbs(n.id);
          const sz = getSz(n.id);
          // A person's drawn silhouette (torso) is inset W*0.1 on each side of
          // its bounding box (see architectureElementShapes.person). Route to
          // that narrower silhouette so left/right dock points land on the body
          // instead of in the blank margin beside it.
          if (n.type === 'person') {
            const inset = sz.w * 0.1;
            return { id: n.id, type: n.type, x: pos.x + inset, y: pos.y, width: sz.w - 2 * inset, height: sz.h };
          }
          return { id: n.id, type: n.type, x: pos.x, y: pos.y, width: sz.w, height: sz.h };
        });
        const gridSections = window.NudgeRenderer.gridConnectionLineRouter.routeAllEdges({
          allEdges,
          obstacles: routableBoxes,
          bounds: { x: 0, y: 0, width: totalW, height: totalH },
          boundaryRect: { x: bndX, y: bndY, width: bndW, height: bndH },
          childIds,
          canBundleEdges
        });
        gridSections.forEach((section, idx) => {
          if (!section) return;
          routedSections[idx] = section;
          routedEdgeSegments.push(...pointsToSegments(sectionToPoints(section), idx));
        });
        // Record which relationships the grid router could not route, so
        // "retire the legacy router once every fixture routes fully on the
        // grid" is a number a test can assert rather than a condition nothing
        // measures (docs/IMPROVEMENT_PLAN.md INC-20).
        const legacyFallbacks = [];
        allEdges.forEach((e, idx) => {
          if (routedSections[idx]) return;
          legacyFallbacks.push(e.id ?? `edge_${idx}`);
          const section = reserveRouteLanes(routeEdge(e, idx), e);
          routedSections[idx] = section;
          routedEdgeSegments.push(...pointsToSegments(sectionToPoints(section), idx));
        });
        out.routerStats = {
          mode: 'grid',
          totalEdges: allEdges.length,
          legacyFallbacks: legacyFallbacks.length,
          legacyFallbackEdgeIds: legacyFallbacks
        };
      } else {
        for (let idx = 0; idx < allEdges.length; idx++) {
          const e = allEdges[idx];
          const section = reserveRouteLanes(routeEdge(e, idx), e);
          routedSections[idx] = section;
          routedEdgeSegments.push(...pointsToSegments(sectionToPoints(section), idx));
        }

        improveRoutedSections(routedSections);
        out.routerStats = {
          mode: 'legacy',
          totalEdges: allEdges.length,
          legacyFallbacks: allEdges.length,
          legacyFallbackEdgeIds: allEdges.map((e, idx) => e.id ?? `edge_${idx}`)
        };
      }

      out.edges = window.NudgeRenderer.containerLayout.buildOutputEdges({
        allEdges, routedSections, createConnectionLabel
      });

      console.log(`[ContainerLayout] boundary ${bndW}×${bndH} | above=${aboveNodes.length} below=${belowNodes.length} left=${leftNodes.length} right=${rightNodes.length}`);
      return out;
    }

    // Returns a structured layout plan for LM verification checkpoints (no SVG rendered)
    window.computeContainerPlan = async function(diagramData) {
      await document.fonts.ready;
      await loadRendererFonts();
      return window.NudgeRenderer.containerPlanSummary.compute(
        diagramData,
        window.NudgeRenderer.containerPlan.buildContainerZonePlan
      );
    };

    // ─── Annotation note positioning ───────────────────────────────────────────
    const NOTE_GAP = 24;         // clear gap between a note and its anchor
    const NOTE_PAD = 8;          // inner text padding
    const NOTE_FOLD = 12;        // dog-ear corner size
    const NOTE_FONT = 12;        // note text font size
    const NOTE_LINE_H = 16;      // note line height
    const NOTE_MAX_WIDTH = 220;  // hard width cap (also used for far-apart `over`)
    const NOTE_MIN_WIDTH = 100;
    const NOTE_MIN_HEIGHT = 46;
    const NOTE_CANVAS_MIN_X = 8;  // keep clear of the left edge
    const NOTE_CANVAS_MIN_Y = 46; // keep clear of the title band (title text ~y35)

    // Wrap a note's text (honouring <br/>) and derive the box dimensions.
    function measureNoteBox(text) {
      const segments = String(text || '').split(/<br\s*\/?>/i);
      const textCap = NOTE_MAX_WIDTH - 2 * NOTE_PAD - NOTE_FOLD;
      const lines = [];
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (!trimmed) { lines.push(''); continue; }
        const wrapped = wrapText(trimmed, textCap, NOTE_FONT);
        if (wrapped.length === 0) lines.push('');
        else lines.push(...wrapped);
      }
      if (lines.length === 0) lines.push('');
      const contentW = Math.max(
        NOTE_MIN_WIDTH - 2 * NOTE_PAD - NOTE_FOLD,
        ...lines.map(l => measureTextWidth(l, NOTE_FONT))
      );
      const width = Math.min(NOTE_MAX_WIDTH, Math.ceil(contentW) + 2 * NOTE_PAD + NOTE_FOLD);
      const height = Math.max(NOTE_MIN_HEIGHT, lines.length * NOTE_LINE_H + 2 * NOTE_PAD);
      return { width, height, lines };
    }

    // Place each parsed note relative to its anchor element(s). The effective
    // placement is the auto-placement override when present, else the author's
    // parsed hint. `over` means ABOVE the anchor (non-occluding), a deliberate
    // divergence from Mermaid's covering `over`. Unresolved anchors are skipped
    // with a warning (fail-safe). Never mutates layout.
    function positionNotes(notes, flatNodes, notePlacements, warnings) {
      const byId = new Map(flatNodes.map(n => [n.id, n]));

      // Content bounding box of the laid-out nodes — the reference frame for
      // margin-pinned floating notes (those with no anchor).
      const contentMinX = flatNodes.length ? Math.min(...flatNodes.map(n => n.x)) : NOTE_CANVAS_MIN_X;
      const contentMinY = flatNodes.length ? Math.min(...flatNodes.map(n => n.y)) : NOTE_CANVAS_MIN_Y;
      const contentMaxX = flatNodes.length ? Math.max(...flatNodes.map(n => n.x + n.width)) : NOTE_CANVAS_MIN_X;
      const contentMaxY = flatNodes.length ? Math.max(...flatNodes.map(n => n.y + n.height)) : NOTE_CANVAS_MIN_Y;

      const out = [];
      for (const note of notes || []) {
        const refs = note.refs || [];

        // Floating note (no anchor): pin to a canvas corner in the margin.
        // Bottom corners drop into the empty band below the content; top
        // corners sit above it (clamped below the title band). Always outside
        // the node bbox, so a floating note never occludes an element.
        if (refs.length === 0) {
          const { width, height, lines } = measureNoteBox(note.text);
          const corner = note.position || 'bottom-right';
          const isBottom = corner.startsWith('bottom');
          const isRight = corner.endsWith('right');
          let x = isRight ? contentMaxX - width : contentMinX;
          let y = isBottom ? contentMaxY + NOTE_GAP : contentMinY - NOTE_GAP - height;
          x = Math.max(x, NOTE_CANVAS_MIN_X);
          y = Math.max(y, NOTE_CANVAS_MIN_Y);
          out.push({
            id: note.id,
            x: Math.round(x),
            y: Math.round(y),
            width,
            height,
            type: 'note',
            text: note.text,
            refs: [],
            position: corner,
            lines
          });
          continue;
        }

        const refNodes = refs.map(r => byId.get(r)).filter(Boolean);
        if (refNodes.length === 0 || refNodes.length !== refs.length) {
          warnings.push(`Note ${note.id} skipped: could not resolve anchor(s) ${JSON.stringify(refs)}.`);
          continue;
        }

        // Union bbox of the anchor element(s); for a single ref this is the node.
        const minX = Math.min(...refNodes.map(n => n.x));
        const minY = Math.min(...refNodes.map(n => n.y));
        const maxX = Math.max(...refNodes.map(n => n.x + n.width));
        const maxY = Math.max(...refNodes.map(n => n.y + n.height));
        const anchor = {
          x: minX, y: minY, width: maxX - minX, height: maxY - minY,
          cx: (minX + maxX) / 2, cy: (minY + maxY) / 2
        };

        const { width, height, lines } = measureNoteBox(note.text);
        const placement = notePlacements[note.id] || note.position || 'over';

        let x, y;
        switch (placement) {
          case 'left':
            x = anchor.x - NOTE_GAP - width;
            y = anchor.cy - height / 2;
            break;
          case 'right':
            x = anchor.x + anchor.width + NOTE_GAP;
            y = anchor.cy - height / 2;
            break;
          case 'below':
            x = anchor.cx - width / 2;
            y = anchor.y + anchor.height + NOTE_GAP;
            break;
          case 'over':
          default:
            // Above the anchor, horizontally centred — never on top of it.
            x = anchor.cx - width / 2;
            y = anchor.y - NOTE_GAP - height;
            break;
        }

        // Clamp into the drawable canvas: never above the title band or left of
        // the margin (those areas clip). A hint that would push a note off the
        // top/left instead lands it against the anchor — the critic then sees an
        // overlap and the auto-placement loop relocates it to a clear side. The
        // right/bottom edges need no clamp; the canvas grows to fit them.
        x = Math.max(x, NOTE_CANVAS_MIN_X);
        y = Math.max(y, NOTE_CANVAS_MIN_Y);

        out.push({
          id: note.id,
          x: Math.round(x),
          y: Math.round(y),
          width,
          height,
          type: 'note',
          text: note.text,
          refs,
          position: placement,
          lines
        });
      }
      return out;
    }

    const {
      measureTextWidth,
      wrapText,
      createConnectionLabel,
      MAX_LABEL_WIDTH,
      LINE_HEIGHT,
      BOUNDARY_H_PAD
    } = window.NudgeRenderer.sharedText;

    const {
      pointToBoxDist,
      lineSegmentIntersectsRect,
      flattenNodes,
      flattenEdges
    } = window.NudgeRenderer.sharedGeometry;
