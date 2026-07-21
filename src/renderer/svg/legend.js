window.NudgeRenderer.legend = {
  // Horizontal legend for the bottom-left of container/context diagrams. Only
  // the element kinds actually present in the diagram get a row. Icons reuse the
  // real shape drawers (`architectureElementShapes.*`) so they never drift from
  // the full-size nodes; the cap floors are shrunk for the small icon boxes.
  //
  // Each spec draws its icon relative to (x = icon-slot left, cy = row centre).

  SVGNS: "http://www.w3.org/2000/svg",

  // Canonical left-to-right order.
  ORDER: ['person', 'inScope', 'system', 'supporting', 'external', 'database', 'message_bus'],

  SPECS: {
    person: {
      label: 'Person',
      draw: (l, x, cy) => window.NudgeRenderer.architectureElementShapes.drawPersonShape(l, x + 4, cy - 16, 18, 30)
    },
    inScope: {
      label: 'System in scope',
      draw: (l, x, cy) => window.NudgeRenderer.architectureElementShapes.drawRectShape(l, x, cy - 11, 26, 22, 'node node-container')
    },
    system: {
      label: 'System',
      draw: (l, x, cy) => window.NudgeRenderer.architectureElementShapes.drawRectShape(l, x, cy - 11, 26, 22, 'node node-container')
    },
    supporting: {
      label: 'Internal system',
      draw: (l, x, cy) => window.NudgeRenderer.architectureElementShapes.drawRectShape(l, x, cy - 11, 26, 22, 'node node-supporting')
    },
    external: {
      label: 'External system',
      draw: (l, x, cy) => window.NudgeRenderer.architectureElementShapes.drawRectShape(l, x, cy - 11, 26, 22, 'node node-external')
    },
    database: {
      label: 'Database',
      draw: (l, x, cy) => window.NudgeRenderer.architectureElementShapes.drawDatabaseShape(l, x + 2, cy - 13, 22, 26, 4)
    },
    message_bus: {
      label: 'Message bus',
      draw: (l, x, cy) => window.NudgeRenderer.architectureElementShapes.drawMessageBusShape(l, x, cy - 9, 28, 18, 4)
    }
  },

  // Layout constants.
  PAD: 18,        // panel inner padding (left/right)
  ICON_W: 28,     // icon slot width
  GAP: 8,         // icon → label gap
  ITEM_GAP: 24,   // gap between items
  HEIGHT: 46,     // panel height

  // Which element kinds does this diagram actually contain? Returns a Set of
  // spec keys. Boundaries (synthetic or real) are never shown.
  presentKinds(flatNodes) {
    const present = new Set();
    const hasFocal = (flatNodes || []).some(n => n && n.type === 'container' && n.inScope);
    for (const n of flatNodes || []) {
      if (!n || n.type === 'boundary') continue;
      switch (n.type) {
        case 'person': present.add('person'); break;
        case 'external': present.add('external'); break;
        case 'database': present.add('database'); break;
        case 'message_bus': present.add('message_bus'); break;
        case 'container':
          if (n.inScope) present.add('inScope');
          else if (n.supporting) present.add('supporting');
          else present.add(hasFocal ? 'supporting' : 'system');
          break;
        default: break;
      }
    }
    return present;
  },

  // Build the positioned legend model, or null when there is nothing to show.
  // `measureTextWidth(text, fontSize, bold)` comes from the render engine.
  build(flatNodes, measureTextWidth) {
    const present = this.presentKinds(flatNodes);
    const items = this.ORDER
      .filter(k => present.has(k))
      .map(k => ({ key: k, label: this.SPECS[k].label, draw: this.SPECS[k].draw }));
    if (items.length === 0) return null;

    let x = this.PAD;
    for (const it of items) {
      it._x = x;
      it._labelW = measureTextWidth(it.label, 13, false);
      x += this.ICON_W + this.GAP + it._labelW + this.ITEM_GAP;
    }
    const width = x - this.ITEM_GAP + this.PAD;
    return { items, width, height: this.HEIGHT };
  },

  // Draw the legend into #legend-layer at (originX, originY).
  render({ model, originX, originY }) {
    const layer = document.getElementById('legend-layer');
    if (!layer || !model) return;

    const panel = document.createElementNS(this.SVGNS, 'rect');
    panel.setAttribute('x', originX);
    panel.setAttribute('y', originY);
    panel.setAttribute('width', model.width);
    panel.setAttribute('height', model.height);
    panel.setAttribute('class', 'legend-panel');
    layer.appendChild(panel);

    const cy = originY + model.height / 2;
    for (const it of model.items) {
      const x = originX + it._x;
      const g = document.createElementNS(this.SVGNS, 'g');
      g.setAttribute('class', 'legend-icon');
      layer.appendChild(g);
      it.draw(g, x, cy);

      const t = document.createElementNS(this.SVGNS, 'text');
      t.setAttribute('x', x + this.ICON_W + this.GAP);
      t.setAttribute('y', cy + 5);
      t.setAttribute('class', 'legend-label');
      t.textContent = it.label;
      layer.appendChild(t);
    }
  }
};
