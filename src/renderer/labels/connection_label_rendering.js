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

    const P = window.NudgeRenderer.connectionLabelPlacement;
    const obstacleNodes = P.createElementObstacles(allComponents, boundaryBorderObstacles);
    const obstacles = P.createLabelObstacles(allComponents, boundaryBorderObstacles, placedLabels);
    const bounds = P.contentBounds(obstacleNodes);

    // Placement as a constrained search over label *geometry*, not just
    // position (INC-16). A corridor too narrow for a 120px-wide box may have
    // room for the same text re-wrapped to 80px — narrower and taller. Each
    // width is a full placement attempt; the first that satisfies wins, and if
    // none does the outcome is UNSATISFIABLE and gets a declared degradation
    // rather than a silently buried label.
    const attemptPlacement = (textWidth, textHeight) => {
      // Element-only obstacles for the scorer. `obstacles` already contains
      // every placed label, and `scoreCandidate` counts those again via
      // `placedLabels`, so a label grazing another label was charged
      // 100 000 + 50 000 = 150 000 while burying a label *inside an
      // architecture element* cost only 100 000 — the placer preferred the more
      // severe defect. Element-only obstacles make `nodeCollision` mean "buried
      // in an element" and restore the severity ordering. (INC-12 / Option A.)
      const labelCandidateScore = P.createCandidateScorer({
        textWidth,
        textHeight,
        obstacles: obstacleNodes,
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
      } = P.createPlacementAdapters({
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

      const anchorOrder = P.getAnchorOrder(preferSourceSideLabel);

      let { midX, midY } = P.chooseInitialLabelPlacement({
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
      });

      ({ midX, midY } = P.adjustFinalLabelPlacement({
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

      const failure = P.placementFailure({
        midX,
        midY,
        textWidth,
        textHeight,
        H_PAD,
        V_PAD,
        elementObstacles: obstacleNodes,
        placedLabels,
        bounds,
        boxesOverlap
      });

      return { midX, midY, textWidth, textHeight, failure };
    };

    // Widths to try, widest first. The first is the label's natural width, so a
    // label that already fits is placed exactly as before and re-wrapping costs
    // nothing on diagrams that do not need it.
    const REWRAP_WIDTHS = [MAX_LABEL_WIDTH, 92, 72, 56];
    const { createConnectionLabel } = window.NudgeRenderer.sharedText;

    // UNSATISFIABLE means specifically **"no in-canvas position exists"**.
    //
    // Burial and label-on-label overlap stay what they already were: scored
    // defects, priced by the candidate scorer and held flat by the quality
    // ratchet. Treating them as unsatisfiable too was measured and was worse —
    // re-wrapping a label that merely grazed another one perturbed placements
    // that were previously fine, and because a re-wrapped box changes what the
    // *next* label sees as occupied, it cascaded: 1 off-canvas label traded for
    // 9 new label overlaps across the corpus. Only the canvas edge is a hard
    // constraint, so only the canvas edge triggers the fallback.
    const isUnplaceable = (candidate) => candidate.failure === 'off-canvas';

    let attempt = null;
    let usedMaxWidth = MAX_LABEL_WIDTH;
    for (const maxWidth of REWRAP_WIDTHS) {
      const dims = maxWidth === MAX_LABEL_WIDTH
        ? { width: textWidth, height: textHeight }
        : createConnectionLabel(label.text, maxWidth);
      // Re-wrapping that does not actually narrow the box cannot help.
      if (attempt && dims.width >= attempt.textWidth) continue;

      const candidate = attemptPlacement(dims.width, dims.height);
      if (!attempt || (isUnplaceable(attempt) && !isUnplaceable(candidate))) {
        attempt = candidate;
        usedMaxWidth = maxWidth;
      }
      if (!isUnplaceable(attempt)) break;
    }

    // Still unplaceable at every width: the corridor genuinely has no room, and
    // no search finds space that does not exist. Degrade in a declared, tested
    // way — clamp back inside the canvas, mark the label, report it — instead of
    // drawing it off the edge and reporting success.
    let unsatisfiable = null;
    if (isUnplaceable(attempt)) {
      unsatisfiable = attempt.failure;
      const clamped = P.clampToBounds({
        midX: attempt.midX,
        midY: attempt.midY,
        textWidth: attempt.textWidth,
        textHeight: attempt.textHeight,
        H_PAD,
        V_PAD,
        bounds
      });
      attempt.midX = clamped.x;
      attempt.midY = clamped.y;
    }

    window.NudgeRenderer.connectionLabelRendering.renderAndRecordLabel({
      label,
      labelsLayer,
      midX: attempt.midX,
      midY: attempt.midY,
      absX,
      absY,
      textWidth: attempt.textWidth,
      textHeight: attempt.textHeight,
      H_PAD,
      V_PAD,
      wrapText,
      MAX_LABEL_WIDTH: usedMaxWidth,
      LINE_HEIGHT,
      placedLabels,
      sourceId,
      targetId,
      targetNode,
      unsatisfiable
    });

    return unsatisfiable
      ? { edgeId: edge.id, text: label.text, reason: unsatisfiable }
      : null;
  },

  appendLabelBackground({
    labelsLayer,
    midX,
    midY,
    textWidth,
    textHeight,
    H_PAD,
    V_PAD,
    unsatisfiable = null
  }) {
    const bgRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bgRect.setAttribute("x", midX - textWidth / 2 - H_PAD);
    bgRect.setAttribute("y", midY - textHeight / 2 - V_PAD);
    bgRect.setAttribute("width", textWidth + 2 * H_PAD);
    bgRect.setAttribute("height", textHeight + 2 * V_PAD);
    bgRect.setAttribute("fill", "#0f172a");
    bgRect.setAttribute("rx", "4");
    // A label placement declared UNSATISFIABLE is marked in the output rather
    // than shipped as if it were fine. The degradation is visible to a reader
    // and greppable in the exported SVG (INC-16).
    bgRect.setAttribute("class", unsatisfiable ? "edge-label-bg edge-label-bg-crowded" : "edge-label-bg");
    if (unsatisfiable) bgRect.setAttribute("data-nudge-unsatisfiable", unsatisfiable);
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
    targetNode,
    unsatisfiable = null
  }) {
    label.x = midX - absX;
    label.y = midY - absY;
    // Re-wrapping changes the box, and the critic scores `label.width/height`
    // (see estimateLabelBox in src/core/geometry.js). Without this the critic
    // would measure the pre-wrap box and judge a position nothing was drawn at.
    label.width = textWidth;
    label.height = textHeight;
    if (unsatisfiable) label.unsatisfiable = unsatisfiable;

    window.NudgeRenderer.connectionLabelRendering.appendLabelBackground({
      labelsLayer,
      midX,
      midY,
      textWidth,
      textHeight,
      H_PAD,
      V_PAD,
      unsatisfiable
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

