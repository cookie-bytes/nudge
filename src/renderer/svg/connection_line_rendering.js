window.NudgeRenderer.connectionLineRendering = {
  buildAllEdgesPoints(flatEdges) {
    return flatEdges.map(fe => {
      const pStart = fe.sections[0].startPoint;
      const pEnd = fe.sections[0].endPoint;
      const points = [pStart];
      if (fe.sections[0].bendPoints && fe.sections[0].bendPoints.length > 0) {
        points.push(...fe.sections[0].bendPoints);
      }
      points.push(pEnd);
      return { id: fe.id, points };
    });
  },

  prepareSection(edge, absX, absY) {
    const section = edge.sections[0];
    const pStart = { x: section.startPoint.x + absX, y: section.startPoint.y + absY };
    const pEnd = { x: section.endPoint.x + absX, y: section.endPoint.y + absY };
    const sourceId = edge.sources[0];
    const targetId = edge.targets[0];
    const hasBendPoints = section.bendPoints && section.bendPoints.length > 0;
    return {
      section,
      pStart,
      pEnd,
      sourceId,
      targetId,
      hasBendPoints
    };
  },

  shouldArrowPointToStart(edge, flatNodeById) {
    const sourceId = edge.sources && edge.sources[0];
    const targetId = edge.targets && edge.targets[0];
    const sourceNode = flatNodeById.get(sourceId);
    const targetNode = flatNodeById.get(targetId);
    const labelText = (edge.labels || []).map(label => label.text || '').join(' ').toLowerCase();

    if (!labelText.includes('consume')) return false;

    const sourceIsBus = sourceNode && sourceNode.type === 'message_bus';
    const targetIsBus = targetNode && targetNode.type === 'message_bus';
    return targetIsBus && !sourceIsBus;
  },

  buildPathData(section, pStart, pEnd, absX, absY) {
    const hasBendPoints = section.bendPoints && section.bendPoints.length > 0;

    let pathD = '';
    if (hasBendPoints) {
      // Honour the chosen route while rounding turns generously so
      // obstacle-avoiding paths read as soft routes rather than boxy
      // right-angle wiring.
      const CORNER_RADIUS = 32;
      const allPts = [
        pStart,
        ...section.bendPoints.map(b => ({ x: b.x + absX, y: b.y + absY })),
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
        const ax = lenIn > 0 ? cur.x - (dxIn / lenIn) * r : cur.x;
        const ay = lenIn > 0 ? cur.y - (dyIn / lenIn) * r : cur.y;
        const bx = lenOut > 0 ? cur.x + (dxOut / lenOut) * r : cur.x;
        const by = lenOut > 0 ? cur.y + (dyOut / lenOut) * r : cur.y;
        pathD += ` L ${ax} ${ay} Q ${cur.x} ${cur.y} ${bx} ${by}`;
      }
      pathD += ` L ${allPts[allPts.length - 1].x} ${allPts[allPts.length - 1].y}`;
    } else {
      pathD = `M ${pStart.x} ${pStart.y} L ${pEnd.x} ${pEnd.y}`;
    }
    return pathD;
  },

  appendConnectionLine(edgesLayer, pathD, shouldPointToStart) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathD);
    path.setAttribute("class", "edge-line");
    if (shouldPointToStart) {
      path.setAttribute("marker-start", "url(#arrow)");
    } else {
      path.setAttribute("marker-end", "url(#arrow)");
    }
    edgesLayer.appendChild(path);
  },

  renderConnectionLine({ edge, absX, absY, edgesLayer, flatNodeById }) {
    const prepared = window.NudgeRenderer.connectionLineRendering.prepareSection(edge, absX, absY);
    const pathD = window.NudgeRenderer.connectionLineRendering.buildPathData(prepared.section, prepared.pStart, prepared.pEnd, absX, absY);
    const shouldPointToStart = window.NudgeRenderer.connectionLineRendering.shouldArrowPointToStart(edge, flatNodeById);
    window.NudgeRenderer.connectionLineRendering.appendConnectionLine(edgesLayer, pathD, shouldPointToStart);
    return prepared;
  }
};

