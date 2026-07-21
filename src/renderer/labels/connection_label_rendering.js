window.NudgeRenderer.connectionLabelRendering = {
  renderConnectionLabel({
    edge,
    labelsLayer,
    flatNodeById,
    sourceId,
    targetId,
    section,
    pStart,
    pEnd,
    absX,
    absY,
    hasBendPoints,
    allEdgesPoints,
    placedLabels,
    allComponents,
    boundaryBorderObstacles,
    pointToBoxDist,
    wrapText,
    MAX_LABEL_WIDTH,
    LINE_HEIGHT,
    labelHints
  }) {
    const label = edge.labels[0];

    const {
      textWidth,
      textHeight,
      targetNode,
      isConsumeBusLabel,
      preferSourceSideLabel,
      points,
      totalLen,
      segLens,
      getPointAtFraction
    } = window.NudgeRenderer.connectionLabelPlacement.prepareLabelContext({
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
    });

    const H_PAD = 10;
    const V_PAD = 3;
    const {
      boxesOverlap,
      lineSegmentIntersectsBox
    } = window.NudgeRenderer.connectionLabelPlacement;

    const {
      checkLabelCollision,
      checkLabelEdgeCollision,
      labelBoxAt,
      labelEdgeHitCount,
      sharedTargetLabelPressure
    } = window.NudgeRenderer.connectionLabelPlacement.createCollisionAccessors({
      H_PAD,
      V_PAD,
      allEdgesPoints,
      edge,
      targetNode,
      targetId,
      placedLabels
    });

    let midX, midY;

    const obstacleNodes = window.NudgeRenderer.connectionLabelPlacement.createElementObstacles(allComponents, boundaryBorderObstacles);
    const obstacles = window.NudgeRenderer.connectionLabelPlacement.createLabelObstacles(allComponents, boundaryBorderObstacles, placedLabels);
    const labelCandidateScore = window.NudgeRenderer.connectionLabelPlacement.createCandidateScorer({
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
      sharedTargetLabelPressure,
      boxesOverlap
    });

    const {
      tryPlaceAnchor,
      labelAnchorCandidate,
      tryPlaceSourceSideRouteBand,
      tryPlaceClearMidpoint
    } = window.NudgeRenderer.connectionLabelPlacement.createPlacementAdapters({
      preferSourceSideLabel,
      arrowAtSource: isConsumeBusLabel,
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
    });

    const anchorOrder = window.NudgeRenderer.connectionLabelPlacement.getAnchorOrder(preferSourceSideLabel);

    ({ midX, midY } = window.NudgeRenderer.connectionLabelPlacement.chooseInitialLabelPlacement({
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
      labelCandidateScore,
      edge,
      labelHints
    }));

    ({ midX, midY } = window.NudgeRenderer.connectionLabelPlacement.adjustFinalLabelPlacement({
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
    }));

    window.NudgeRenderer.connectionLabelRendering.renderAndRecordLabel({
      label,
      labelsLayer,
      midX,
      midY,
      absX,
      absY,
      textWidth,
      textHeight,
      H_PAD,
      V_PAD,
      wrapText,
      MAX_LABEL_WIDTH,
      LINE_HEIGHT,
      placedLabels,
      sourceId,
      targetId,
      targetNode
    });
  },

  appendLabelBackground({
    labelsLayer,
    midX,
    midY,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD
  }) {
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("x", midX - textWidth / 2 - H_PAD);
    bgRect.setAttribute("y", midY - textHeight / 2 - V_PAD);
    bgRect.setAttribute("width", textWidth + 2 * H_PAD);
    bgRect.setAttribute("height", textHeight + 2 * V_PAD);
    bgRect.setAttribute("fill", "#0f172a");
    bgRect.setAttribute("rx", "4");
    bgRect.setAttribute("class", "edge-label-bg");
    labelsLayer.appendChild(bgRect);
  },

  appendLabelText({
    labelsLayer,
    labelText,
    midX,
    midY,
    wrapText,
    MAX_LABEL_WIDTH,
    LINE_HEIGHT
  }) {
    const match = labelText.match(/^(.*?)\s*\[(.*?)\]$/);
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
        textEl.setAttribute("fill", "#cbd5e1");
        textEl.setAttribute("text-anchor", "middle");
        textEl.setAttribute("class", "edge-label-text");
        textEl.textContent = line;
        labelsLayer.appendChild(textEl);
        lineY += LINE_HEIGHT;
      }

      const techEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      techEl.setAttribute("x", midX);
      techEl.setAttribute("y", lineY);
      techEl.setAttribute("fill", "#cbd5e1");
      techEl.setAttribute("text-anchor", "middle");
      techEl.setAttribute("class", "edge-label-text");
      techEl.setAttribute("style", "opacity: 0.85; font-size: 10px;");
      techEl.textContent = techText;
      labelsLayer.appendChild(techEl);
    } else {
      const lines = wrapText(labelText, MAX_LABEL_WIDTH, 11);
      const blockHeight = lines.length * LINE_HEIGHT;
      let lineY = midY - blockHeight / 2 + LINE_HEIGHT * 0.8;

      for (const line of lines) {
        const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        textEl.setAttribute("x", midX);
        textEl.setAttribute("y", lineY);
        textEl.setAttribute("fill", "#cbd5e1");
        textEl.setAttribute("text-anchor", "middle");
        textEl.setAttribute("class", "edge-label-text");
        textEl.textContent = line;
        labelsLayer.appendChild(textEl);
        lineY += LINE_HEIGHT;
      }
    }
  },

  renderAndRecordLabel({
    label,
    labelsLayer,
    midX,
    midY,
    absX,
    absY,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD,
    wrapText,
    MAX_LABEL_WIDTH,
    LINE_HEIGHT,
    placedLabels,
    sourceId,
    targetId,
    targetNode
  }) {
    label.x = midX - absX;
    label.y = midY - absY;
    window.NudgeRenderer.connectionLabelRendering.appendLabelBackground({
      labelsLayer,
      midX,
      midY,
      textWidth,
      textHeight,
      H_PAD,
      V_PAD
    });

    window.NudgeRenderer.connectionLabelRendering.appendLabelText({
      labelsLayer,
      labelText: label.text,
      midX,
      midY,
      wrapText,
      MAX_LABEL_WIDTH,
      LINE_HEIGHT
    });

    placedLabels.push(window.NudgeRenderer.connectionLabelRendering.createPlacedLabelRecord({
      midX,
      midY,
      textWidth,
      textHeight,
      H_PAD,
      V_PAD,
      sourceId,
      targetId,
      targetNode
    }));
  },

  createPlacedLabelRecord({
    midX,
    midY,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD,
    sourceId,
    targetId,
    targetNode
  }) {
    return {
      x: midX - (textWidth + 2 * H_PAD) / 2,
      y: midY - (textHeight + 2 * V_PAD) / 2,
      width: textWidth + 2 * H_PAD,
      height: textHeight + 2 * V_PAD,
      sourceId,
      targetId,
      targetType: targetNode && targetNode.type
    };
  }
};

