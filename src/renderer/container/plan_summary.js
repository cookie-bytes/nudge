window.NudgeRenderer.containerPlanSummary = {
  compute(diagramData, buildContainerZonePlan) {
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
  }
};
