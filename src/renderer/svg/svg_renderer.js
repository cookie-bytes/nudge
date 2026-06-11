window.NudgeRenderer.svgRenderer = {
  clearLayers() {
    const layers = ["title-layer", "boundaries-layer", "edges-layer", "nodes-layer", "edge-labels-layer"];
    layers.forEach(l => {
      const el = document.getElementById(l);
      if (el) el.innerHTML = "";
    });
  },

  renderDiagramTitle(diagramData, DIAGRAM_H_PAD) {
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
    return titleText;
  },

  configureViewport({ svg, graph, titleText, DIAGRAM_H_PAD, measureTextWidth }) {
    const titleWidth = measureTextWidth(titleText, 16, true) + 60;
    const finalWidth = Math.max(graph.width + DIAGRAM_H_PAD * 2, titleWidth);

    // Adjust viewport size dynamically (shifted vertically by +50px for title)
    const DIAGRAM_B_PAD = 40;
    svg.setAttribute("viewBox", `0 0 ${finalWidth} ${graph.height + 50 + DIAGRAM_B_PAD}`);
    svg.style.width = `${finalWidth}px`;
    svg.style.height = `${graph.height + 50 + DIAGRAM_B_PAD}px`;
    return finalWidth;
  },

  prepareDrawContext({ graph, DIAGRAM_H_PAD, flattenNodes, flattenEdges }) {
    const flatNodes = flattenNodes(graph, DIAGRAM_H_PAD, 50);
    const flatNodeById = new Map(flatNodes.map(n => [n.id, n]));
    const allComponents = flatNodes.filter(n => n.type !== 'boundary');
    const boundaryBorderObstacles = window.NudgeRenderer.svgRenderer.buildBoundaryBorderObstacles(flatNodes);

    // Gather all edges and their exact drawn points to check for label-edge crossings
    const flatEdges = flattenEdges(graph, DIAGRAM_H_PAD, 50);
    const allEdgesPoints = window.NudgeRenderer.connectionLineRendering.buildAllEdgesPoints(flatEdges);

    return {
      flatNodes,
      flatNodeById,
      allComponents,
      boundaryBorderObstacles,
      flatEdges,
      allEdgesPoints
    };
  },

  buildBoundaryBorderObstacles(flatNodes) {
    return flatNodes
      .filter(n => n.type === 'boundary')
      .flatMap(n => {
        const clearance = 12;
        return [
          { x: n.x - clearance, y: n.y - clearance, width: n.width + clearance * 2, height: clearance * 2 },
          { x: n.x - clearance, y: n.y + n.height - clearance, width: n.width + clearance * 2, height: clearance * 2 },
          { x: n.x - clearance, y: n.y - clearance, width: clearance * 2, height: n.height + clearance * 2 },
          { x: n.x + n.width - clearance, y: n.y - clearance, width: clearance * 2, height: n.height + clearance * 2 }
        ];
      });
  },

  renderNodeTree({
    node,
    shapeStrategies,
    absoluteParentX = 0,
    absoluteParentY = 0
  }) {
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
      node.children.forEach(c => window.NudgeRenderer.svgRenderer.renderNodeTree({
        node: c,
        shapeStrategies,
        absoluteParentX: absX,
        absoluteParentY: absY
      }));
    }
  },

  renderEdges({
    node,
    absoluteParentX = 0,
    absoluteParentY = 0,
    flatNodeById,
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
    const absX = absoluteParentX + (node.x || 0);
    const absY = absoluteParentY + (node.y || 0);

    if (node.edges) {
      const edgesLayer = document.getElementById("edges-layer");
      const labelsLayer = document.getElementById("edge-labels-layer");

      for (const edge of node.edges) {
        if (!edge.sections || edge.sections.length === 0) continue;
        
        const {
          section,
          pStart,
          pEnd,
          sourceId,
          targetId,
          hasBendPoints
        } = window.NudgeRenderer.connectionLineRendering.renderConnectionLine({
          edge,
          absX,
          absY,
          edgesLayer,
          flatNodeById
        });

        // Draw labels on the segment with the most clearance from nearby nodes
        if (edge.labels && edge.labels.length > 0) {
          window.NudgeRenderer.connectionLabelRendering.renderConnectionLabel({
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
          });
        }
      }
    }

    if (node.children) {
      node.children.forEach(c => window.NudgeRenderer.svgRenderer.renderEdges({
        node: c,
        absoluteParentX: absX,
        absoluteParentY: absY,
        flatNodeById,
        allEdgesPoints,
        placedLabels,
        allComponents,
        boundaryBorderObstacles,
        pointToBoxDist,
        wrapText,
        MAX_LABEL_WIDTH,
        LINE_HEIGHT,
        labelHints
      }));
    }
  },

  drawGraph({
    graph,
    diagramData,
    DIAGRAM_H_PAD,
    BOUNDARY_H_PAD,
    measureTextWidth,
    flattenNodes,
    flattenEdges,
    pointToBoxDist,
    wrapText,
    MAX_LABEL_WIDTH,
    LINE_HEIGHT
  }) {
    const svg = document.getElementById("svg-root");
    // Clear layers
    window.NudgeRenderer.svgRenderer.clearLayers();

    // Render diagram title
    const titleText = window.NudgeRenderer.svgRenderer.renderDiagramTitle(diagramData, DIAGRAM_H_PAD);

    const finalWidth = window.NudgeRenderer.svgRenderer.configureViewport({
      svg,
      graph,
      titleText,
      DIAGRAM_H_PAD,
      measureTextWidth
    });

    const {
      flatNodeById,
      allComponents,
      boundaryBorderObstacles,
      allEdgesPoints
    } = window.NudgeRenderer.svgRenderer.prepareDrawContext({
      graph,
      DIAGRAM_H_PAD,
      flattenNodes,
      flattenEdges
    });
    const placedLabels = [];

    const shapeStrategies = window.NudgeRenderer.architectureElementShapes.createShapeStrategies({
      BOUNDARY_H_PAD
    });

    // 1. Draw nodes and boundary boxes (with vertical offset of 50px)
    window.NudgeRenderer.svgRenderer.renderNodeTree({
      node: graph,
      shapeStrategies,
      absoluteParentX: DIAGRAM_H_PAD,
      absoluteParentY: 50
    });

    const labelHints = diagramData._layoutOverrides?.labelHints;

    // 2. Draw connector lines (edges) recursively (with vertical offset of 50px)
    window.NudgeRenderer.svgRenderer.renderEdges({
      node: graph,
      absoluteParentX: DIAGRAM_H_PAD,
      absoluteParentY: 50,
      flatNodeById,
      allEdgesPoints,
      placedLabels,
      allComponents,
      boundaryBorderObstacles,
      pointToBoxDist,
      wrapText,
      MAX_LABEL_WIDTH,
      LINE_HEIGHT,
      labelHints
    });
  }
};

