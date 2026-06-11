window.NudgeRenderer.architectureElementShapes = {
  // Helper to generate capitalized node type label
  getNodeTypeLabel(node) {
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

  createShapeStrategies({ BOUNDARY_H_PAD }) {
    const { getNodeTypeLabel, appendNodeText } = window.NudgeRenderer.architectureElementShapes;

    return {
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
  }
};

