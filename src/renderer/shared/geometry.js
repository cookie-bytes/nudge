window.NudgeRenderer.sharedGeometry = (() => {
  function pointToBoxDist(px, py, box) {
    const dx = Math.max(box.x - px, 0, px - (box.x + box.width));
    const dy = Math.max(box.y - py, 0, py - (box.y + box.height));
    return Math.sqrt(dx * dx + dy * dy);
  }

  function lineSegmentIntersectsRect(p1, p2, rect) {
    // Pad the rectangle slightly so we don't graze the corners
    const pad = 8;
    const rx = rect.x - pad;
    const ry = rect.y - pad;
    const rw = rect.width + 2 * pad;
    const rh = rect.height + 2 * pad;

    function lineSegmentsIntersect(a1, a2, b1, b2) {
      const det = (a2.x - a1.x) * (b2.y - b1.y) - (b2.x - b1.x) * (a2.y - a1.y);
      if (det === 0) return false; // Parallel
      const lambda = ((b2.y - b1.y) * (b2.x - a1.x) + (b1.x - b2.x) * (b2.y - a1.y)) / det;
      const gamma = ((a1.y - a2.y) * (b2.x - a1.x) + (a2.x - a1.x) * (b2.y - a1.y)) / det;
      return (0 <= lambda && lambda <= 1) && (0 <= gamma && gamma <= 1);
    }

    // Check if either endpoint is inside the padded rect
    if (p1.x >= rx && p1.x <= rx + rw && p1.y >= ry && p1.y <= ry + rh) return true;
    if (p2.x >= rx && p2.x <= rx + rw && p2.y >= ry && p2.y <= ry + rh) return true;

    // Rect borders
    const rTopLeft = { x: rx, y: ry };
    const rTopRight = { x: rx + rw, y: ry };
    const rBotLeft = { x: rx, y: ry + rh };
    const rBotRight = { x: rx + rw, y: ry + rh };

    if (lineSegmentsIntersect(p1, p2, rTopLeft, rTopRight)) return true;
    if (lineSegmentsIntersect(p1, p2, rTopRight, rBotRight)) return true;
    if (lineSegmentsIntersect(p1, p2, rBotRight, rBotLeft)) return true;
    if (lineSegmentsIntersect(p1, p2, rBotLeft, rTopLeft)) return true;

    return false;
  }

  // Flatten nested children coordinates to absolute positions
  function flattenNodes(graphNode, parentX = 0, parentY = 0) {
    let flat = [];
    const absoluteX = parentX + (graphNode.x || 0);
    const absoluteY = parentY + (graphNode.y || 0);

    if (graphNode.id !== "root") {
      flat.push({
        id: graphNode.id,
        x: absoluteX,
        y: absoluteY,
        width: graphNode.width,
        height: graphNode.height,
        type: graphNode.type,
        label: graphNode.label
      });
    }

    if (graphNode.children) {
      for (const child of graphNode.children) {
        flat = flat.concat(flattenNodes(child, absoluteX, absoluteY));
      }
    }

    return flat;
  }

  // Flatten nested edges and convert coordinates to absolute space
  function flattenEdges(graphNode, parentX = 0, parentY = 0) {
    let flat = [];
    const absX = parentX + (graphNode.x || 0);
    const absY = parentY + (graphNode.y || 0);

    if (graphNode.edges) {
      for (const edge of graphNode.edges) {
        if (!edge.sections || edge.sections.length === 0) continue;

        const section = edge.sections[0];
        const flatEdge = {
          id: edge.id,
          sources: edge.sources,
          targets: edge.targets,
          sections: [{
            startPoint: { x: section.startPoint.x + absX, y: section.startPoint.y + absY },
            endPoint: { x: section.endPoint.x + absX, y: section.endPoint.y + absY }
          }],
          labels: edge.labels ? edge.labels.map(l => ({
            text: l.text,
            width: l.width,
            height: l.height,
            x: Number.isFinite(l.x) ? l.x + absX : undefined,
            y: Number.isFinite(l.y) ? l.y + absY : undefined
          })) : []
        };

        if (section.bendPoints) {
          flatEdge.sections[0].bendPoints = section.bendPoints.map(b => ({
            x: b.x + absX,
            y: b.y + absY
          }));
        }

        flat.push(flatEdge);
      }
    }

    if (graphNode.children) {
      for (const child of graphNode.children) {
        flat = flat.concat(flattenEdges(child, absX, absY));
      }
    }

    return flat;
  }

  return {
    pointToBoxDist,
    lineSegmentIntersectsRect,
    flattenNodes,
    flattenEdges
  };
})();
