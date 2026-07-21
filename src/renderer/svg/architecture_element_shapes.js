window.NudgeRenderer.architectureElementShapes = {
  // Helper to generate capitalized node type label
  getNodeTypeLabel(node) {
    if (node.typeLabel) return node.typeLabel;
    let typeName = node.type;
    if (node.type === 'container') typeName = 'Container';
    else if (node.type === 'external') typeName = 'External System';
    else if (node.type === 'person') typeName = 'Person';
    else if (node.type === 'database') typeName = 'Database';
    else if (node.type === 'message_bus') typeName = 'Message Bus';
    else {
      typeName = node.type.charAt(0).toUpperCase() + node.type.slice(1);
    }
    return typeName;
  },

  // Helper for rendering the foreignObject text container
  appendNodeText(node, x, y, width, height, typeLabelText, container) {
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

    if (node.tech) {
      const techLabel = document.createElement("div");
      techLabel.className = "node-tech";
      techLabel.textContent = node.tech;
      wrapper.appendChild(techLabel);
    }

    if (node.description) {
      const desc = document.createElement("div");
      desc.className = "node-desc";
      desc.textContent = node.description;
      wrapper.appendChild(desc);
    }

    fo.appendChild(wrapper);
    container.appendChild(fo);
  },

  // ---- Shape-only drawers ----
  // These draw the pure geometry (no text) into `layer`, so both the full-size
  // node strategies below and the legend icons can share one source of truth.
  // The database/message-bus cap-radius floors are parameterised (`capMin`) so
  // legend icons can shrink the caps that are tuned for full-size nodes.

  drawRectShape(layer, absX, absY, W, H, cls) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", absX);
    rect.setAttribute("y", absY);
    rect.setAttribute("width", W);
    rect.setAttribute("height", H);
    rect.setAttribute("class", cls);
    layer.appendChild(rect);
  },

  drawPersonShape(layer, absX, absY, W, H) {
    // Head: circle at top center
    const cxHead = absX + W / 2;
    const cyHead = absY + H * 0.11;
    const rHead = H * 0.16;

    const headCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    headCircle.setAttribute("cx", cxHead);
    headCircle.setAttribute("cy", cyHead);
    headCircle.setAttribute("r", rHead);
    headCircle.setAttribute("class", "person-head");
    layer.appendChild(headCircle);

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
    layer.appendChild(bodyPath);
  },

  drawDatabaseShape(layer, absX, absY, W, H, capMin = 12) {
    const eRy = Math.max(capMin, Math.round(W * 0.08));
    const eRx = W / 2;
    const cxDb = absX + eRx;

    // Body: left side, bottom arc (sweep=1 curves DOWN), right side.
    const bodyPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    bodyPath.setAttribute("d", [
      `M ${absX} ${absY + eRy}`,
      `L ${absX} ${absY + H - eRy}`,
      `A ${eRx} ${eRy} 0 0 0 ${absX + W} ${absY + H - eRy}`,
      `L ${absX + W} ${absY + eRy}`
    ].join(' '));
    bodyPath.setAttribute("class", `node node-database`);
    layer.appendChild(bodyPath);

    // Top ellipse cap
    const topEllipse = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    topEllipse.setAttribute("cx", cxDb);
    topEllipse.setAttribute("cy", absY + eRy);
    topEllipse.setAttribute("rx", eRx);
    topEllipse.setAttribute("ry", eRy);
    topEllipse.setAttribute("class", "db-cap");
    layer.appendChild(topEllipse);
    return eRy;
  },

  drawMessageBusShape(layer, absX, absY, W, H, capMin = 12) {
    const eRy = H / 2;
    const eRx = Math.max(capMin, Math.round(H * 0.18));
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
    layer.appendChild(bodyPath);

    // Left ellipse cap
    const leftEllipse = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    leftEllipse.setAttribute("cx", cxBus);
    leftEllipse.setAttribute("cy", absY + eRy);
    leftEllipse.setAttribute("rx", eRx);
    leftEllipse.setAttribute("ry", eRy);
    leftEllipse.setAttribute("class", "message-bus-cap");
    layer.appendChild(leftEllipse);
    return eRx;
  },

  createShapeStrategies({ BOUNDARY_H_PAD }) {
    const { getNodeTypeLabel, appendNodeText } = window.NudgeRenderer.architectureElementShapes;

    return {
      boundary(node, absX, absY, layers) {
        // Synthetic boundaries exist only to drive the container layout
        // (e.g. C4Context diagrams) and are not drawn.
        if (node._synthetic) return;
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
        window.NudgeRenderer.architectureElementShapes.drawPersonShape(layers.nodes, absX, absY, W, H);

        // Text content centered inside the shoulder/bust area
        const textY = absY + H * 0.36;
        const textH = H - (H * 0.36) - 8;
        appendNodeText(node, absX + 20, textY, W - 40, textH, `[${getNodeTypeLabel(node)}]`, layers.nodes);
      },

      database(node, absX, absY, layers) {
        const W = node.width, H = node.height;
        const eRy = window.NudgeRenderer.architectureElementShapes.drawDatabaseShape(layers.nodes, absX, absY, W, H);
        const textStartTop = 2 * eRy + 8;
        appendNodeText(node, absX, absY + textStartTop, W, H - textStartTop - eRy, `[${getNodeTypeLabel(node)}]`, layers.nodes);
      },

      message_bus(node, absX, absY, layers) {
        const H = node.height, W = node.width;
        const eRx = window.NudgeRenderer.architectureElementShapes.drawMessageBusShape(layers.nodes, absX, absY, W, H);

        // Text content centered inside the cylinder straight-sides area
        const textX = absX + 2 * eRx + 4;
        const textW = W - 3 * eRx - 8;
        appendNodeText(node, textX, absY, textW, H, `[${getNodeTypeLabel(node)}]`, layers.nodes);
      },

      note(node, absX, absY, layers) {
        const W = node.width, H = node.height;
        const FOLD = 12;

        // Body with a folded top-right corner (dog-ear).
        const body = document.createElementNS("http://www.w3.org/2000/svg", "path");
        body.setAttribute("d", [
          `M ${absX} ${absY}`,
          `L ${absX + W - FOLD} ${absY}`,
          `L ${absX + W} ${absY + FOLD}`,
          `L ${absX + W} ${absY + H}`,
          `L ${absX} ${absY + H}`,
          `Z`
        ].join(' '));
        body.setAttribute("class", "note");
        layers.notes.appendChild(body);

        // The folded corner triangle.
        const fold = document.createElementNS("http://www.w3.org/2000/svg", "path");
        fold.setAttribute("d", [
          `M ${absX + W - FOLD} ${absY}`,
          `L ${absX + W - FOLD} ${absY + FOLD}`,
          `L ${absX + W} ${absY + FOLD}`,
          `Z`
        ].join(' '));
        fold.setAttribute("class", "note-fold");
        layers.notes.appendChild(fold);

        // Text content — notes suppress the type label entirely. Pre-wrapped
        // lines come from the positioning pass; fall back to the raw text.
        const PAD = 8;
        const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
        fo.setAttribute("x", absX + PAD);
        fo.setAttribute("y", absY + PAD);
        fo.setAttribute("width", Math.max(0, W - 2 * PAD - FOLD));
        fo.setAttribute("height", Math.max(0, H - 2 * PAD));

        const wrapper = document.createElement("div");
        wrapper.className = "note-content";
        const lines = Array.isArray(node.lines) && node.lines.length
          ? node.lines
          : String(node.text || '').split(/<br\s*\/?>/i);
        for (const line of lines) {
          const div = document.createElement("div");
          div.textContent = line;
          if (line === '') div.innerHTML = '&nbsp;';
          wrapper.appendChild(div);
        }
        fo.appendChild(wrapper);
        layers.notes.appendChild(fo);
      },

      default(node, absX, absY, layers) {
        // Internal supporting systems (a container that is not the in-scope
        // system, once a focal system has been detected) render in a muted
        // shade so the focal system stands out. When no focal system was
        // detected, `supporting` is unset and every container keeps node-container.
        let nodeClass = `node node-${node.type}`;
        if (node.type === 'container' && node.supporting && !node.inScope) {
          nodeClass = "node node-supporting";
        }
        window.NudgeRenderer.architectureElementShapes.drawRectShape(layers.nodes, absX, absY, node.width, node.height, nodeClass);

        appendNodeText(node, absX, absY, node.width, node.height, `[${getNodeTypeLabel(node)}]`, layers.nodes);
      }
    };
  }
};

