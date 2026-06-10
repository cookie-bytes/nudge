window.NudgeRenderer.utilityRowRules = {
  applyMessageBusWidthScaling(layers, allEdges) {
    // Step up the width of a message bus based on its connection count, so a
    // busy hub reads as a wide spine. Buses with 4+ connections are sized
    // to 3× their base width, while those with 3+ connections are 2×.
    for (const layer of layers) {
      for (const n of layer) {
        if (n.type !== 'message_bus') continue;
        const connections = allEdges.reduce(
          (count, e) => count + (e.from === n.id || e.to === n.id ? 1 : 0), 0);
        if (n._layoutBaseWidth === undefined) n._layoutBaseWidth = n.width || 200;
        if (connections >= 4) n.width = n._layoutBaseWidth * 3;
        else if (connections >= 3) n.width = n._layoutBaseWidth * 2;
        else n.width = n._layoutBaseWidth;
      }
    }
  },

  isPairedLayer(l) {
    return l.length > 0 && l.every(n => n.type === 'database' || (n.type === 'message_bus' && n.local));
  }
};
