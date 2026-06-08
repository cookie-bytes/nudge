// Determine segment-segment intersection
// Segment A: (x1, y1) -> (x2, y2)
// Segment B: (x3, y3) -> (x4, y4)
function lineSegmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const det = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (det === 0) return false; // Parallel

  const lambda = ((y4 - y3) * (x4 - x1) + (x3 - x4) * (y4 - y1)) / det;
  const gamma = ((y1 - y2) * (x4 - x1) + (x2 - x1) * (y4 - y1)) / det;

  return (0 <= lambda && lambda <= 1) && (0 <= gamma && gamma <= 1);
}

// Check if a line segment intersects a bounding box
function lineIntersectsBox(x1, y1, x2, y2, box) {
  const { x, y, width, height } = box;
  const xMin = x;
  const xMax = x + width;
  const yMin = y;
  const yMax = y + height;

  // Check intersection with 4 sides of the box
  return (
    lineSegmentsIntersect(x1, y1, x2, y2, xMin, yMin, xMax, yMin) || // Top
    lineSegmentsIntersect(x1, y1, x2, y2, xMax, yMin, xMax, yMax) || // Right
    lineSegmentsIntersect(x1, y1, x2, y2, xMax, yMax, xMin, yMax) || // Bottom
    lineSegmentsIntersect(x1, y1, x2, y2, xMin, yMax, xMin, yMin)    // Left
  );
}

// Minimum distance from a point to the nearest edge of a bounding box (0 if inside)
function pointToBoxDist(px, py, box) {
  const dx = Math.max(box.x - px, 0, px - (box.x + box.width));
  const dy = Math.max(box.y - py, 0, py - (box.y + box.height));
  return Math.sqrt(dx * dx + dy * dy);
}

// Check if two boxes overlap
function boxesOverlap(boxA, boxB) {
  return (
    boxA.x < boxB.x + boxB.width &&
    boxA.x + boxA.width > boxB.x &&
    boxA.y < boxB.y + boxB.height &&
    boxA.y + boxA.height > boxB.y
  );
}

// Minimum edge-to-edge distance between two non-overlapping axis-aligned boxes
function boxEdgeDistance(nA, nB) {
  const cxA = nA.x + nA.width / 2;
  const cyA = nA.y + nA.height / 2;
  const cxB = nB.x + nB.width / 2;
  const cyB = nB.y + nB.height / 2;
  const edgeDistX = Math.abs(cxA - cxB) - (nA.width + nB.width) / 2;
  const edgeDistY = Math.abs(cyA - cyB) - (nA.height + nB.height) / 2;
  // One axis overlaps → gap is purely along the other axis
  if (edgeDistX <= 0) return edgeDistY;
  if (edgeDistY <= 0) return edgeDistX;
  // Diagonal separation → corner-to-corner Euclidean distance
  return Math.sqrt(edgeDistX * edgeDistX + edgeDistY * edgeDistY);
}

// Perform complete geometric layout critique
export function analyzeLayout(layoutData) {
  const { nodes, edges, width, height } = layoutData;
  const report = {
    collisions: [],
    overlapCount: 0,
    intersectionCount: 0,
    aspectRatio: (width / height).toFixed(2),
    width,
    height
  };

  // Filter out boundary containers when calculating component overlaps (since children reside inside them)
  const components = nodes.filter(n => n.type !== 'boundary');

  // 1. Check for component-to-component overlaps
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const nodeA = components[i];
      const nodeB = components[j];

      if (boxesOverlap(nodeA, nodeB)) {
        report.overlapCount++;
        report.collisions.push({
          type: 'node_overlap',
          elements: [nodeA.id, nodeB.id],
          details: `Nodes '${nodeA.label}' (${nodeA.id}) and '${nodeB.label}' (${nodeB.id}) overlap.`
        });
      }
    }
  }

  // 2. Check for edge lines crossing components they shouldn't
  for (const edge of edges) {
    if (!edge.sections || edge.sections.length === 0) continue;

    const sourceId = edge.sources[0];
    const targetId = edge.targets[0];
    const section = edge.sections[0];

    // Gather all segment coordinates for this edge
    const points = [{ x: section.startPoint.x, y: section.startPoint.y }];
    if (section.bendPoints) {
      points.push(...section.bendPoints);
    }
    points.push({ x: section.endPoint.x, y: section.endPoint.y });

    // For every component (excluding source, target, and parent boundary nodes)
    for (const comp of components) {
      if (comp.id === sourceId || comp.id === targetId) continue;

      // Check if any segment of the edge line intersects the component box
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];

        if (lineIntersectsBox(p1.x, p1.y, p2.x, p2.y, comp)) {
          report.intersectionCount++;
          report.collisions.push({
            type: 'edge_node_crossing',
            edge: `${sourceId} -> ${targetId}`,
            node: comp.id,
            details: `Relationship arrow '${sourceId} -> ${targetId}' cuts directly through node '${comp.label}' (${comp.id}).`
          });
          break; // Stop checking segments for this component once crossing is found
        }
      }
    }
  }

  // 2b. Check for edge labels overlapping components they shouldn't
  for (const edge of edges) {
    if (!edge.sections || edge.sections.length === 0) continue;
    if (!edge.labels || edge.labels.length === 0) continue;

    const sourceId = edge.sources[0];
    const targetId = edge.targets[0];
    const section = edge.sections[0];
    const label = edge.labels[0];

    const points = [{ x: section.startPoint.x, y: section.startPoint.y }];
    if (section.bendPoints) {
      points.push(...section.bendPoints);
    }
    points.push({ x: section.endPoint.x, y: section.endPoint.y });

    const nearbyComps = components.filter(n => n.id !== sourceId && n.id !== targetId);

    // Calculate total length and segment lengths
    let totalLen = 0;
    const segLens = [];
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i+1].x - points[i].x;
      const dy = points[i+1].y - points[i].y;
      const len = Math.sqrt(dx * dx + dy * dy);
      totalLen += len;
      segLens.push(len);
    }

    function getPointAtFraction(fraction) {
      if (totalLen === 0) return { x: points[0].x, y: points[0].y, segment: { p1: points[0], p2: points[0] } };
      const targetDist = totalLen * fraction;
      let accumulated = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const len = segLens[i];
        if (accumulated + len >= targetDist - 1e-5) {
          const remaining = targetDist - accumulated;
          const p1 = points[i];
          const p2 = points[i+1];
          const t = len > 0 ? remaining / len : 0;
          return {
            x: p1.x + t * (p2.x - p1.x),
            y: p1.y + t * (p2.y - p1.y),
            segment: { p1, p2 }
          };
        }
        accumulated += len;
      }
      const lastIdx = points.length - 1;
      return {
        x: points[lastIdx].x,
        y: points[lastIdx].y,
        segment: { p1: points[lastIdx - 1], p2: points[lastIdx] }
      };
    }

    function checkLabelCollision(cx, cy, w, h, nodesList) {
      const labelBox = {
        x: cx - w / 2 - 4,
        y: cy - h / 2 - 2,
        width: w + 8,
        height: h + 4
      };
      for (const comp of nodesList) {
        const compBox = {
          x: comp.x,
          y: comp.y,
          width: comp.width,
          height: comp.height
        };
        if (boxesOverlap(labelBox, compBox)) {
          return true;
        }
      }
      return false;
    }

    const anchorDist = 45;
    let midX, midY;
    let placed = false;

    // Rule 1: Try Target Anchor (anchorDist from target)
    if (totalLen >= 2 * anchorDist) {
      const targetFraction = (totalLen - anchorDist) / totalLen;
      const candA = getPointAtFraction(targetFraction);
      if (!checkLabelCollision(candA.x, candA.y, label.width, label.height, components)) {
        midX = candA.x;
        midY = candA.y;
        placed = true;
      }
    }

    // Rule 2: Try Source Anchor (anchorDist from source)
    if (!placed && totalLen >= 2 * anchorDist) {
      const sourceFraction = anchorDist / totalLen;
      const candB = getPointAtFraction(sourceFraction);
      if (!checkLabelCollision(candB.x, candB.y, label.width, label.height, components)) {
        midX = candB.x;
        midY = candB.y;
        placed = true;
      }
    }

    // Rule 3: Fallback to Middle Gutter Clearance
    if (!placed) {
      let bestSeg = null;
      let bestScore = -Infinity;
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const clearance = nearbyComps.length > 0
          ? Math.min(...nearbyComps.map(n => pointToBoxDist(mx, my, n)))
          : Infinity;
        const score = clearance * 10 + len;
        if (score > bestScore) { bestScore = score; bestSeg = { p1, p2 }; }
      }

      if (bestSeg) {
        midX = (bestSeg.p1.x + bestSeg.p2.x) / 2;
        const isHorizontal = Math.abs(bestSeg.p1.y - bestSeg.p2.y) < 2;
        if (isHorizontal) {
          midY = bestSeg.p1.y;
        } else {
          const LABEL_TARGET_BIAS = 0.85;
          const edgeStart = points[0];
          const edgeEnd   = points[points.length - 1];
          const biasedY = edgeStart.y + LABEL_TARGET_BIAS * (edgeEnd.y - edgeStart.y);
          const segMinY = Math.min(bestSeg.p1.y, bestSeg.p2.y);
          const segMaxY = Math.max(bestSeg.p1.y, bestSeg.p2.y);
          const halfH = (label.height + 4) / 2;
          const clampLo = segMinY + 10 + halfH;
          const clampHi = segMaxY - 10 - halfH;
          midY = clampLo <= clampHi
            ? Math.max(clampLo, Math.min(clampHi, biasedY))
            : (segMinY + segMaxY) / 2;
        }
      } else {
        midX = (points[0].x + points[points.length - 1].x) / 2;
        midY = (points[0].y + points[points.length - 1].y) / 2;
      }
    }


    const labelBox = {
      x: midX - label.width / 2 - 4,
      y: midY - label.height / 2 - 2,
      width: label.width + 8,
      height: label.height + 4
    };

    for (const comp of components) {
      if (comp.id === sourceId || comp.id === targetId) continue;

      if (boxesOverlap(labelBox, comp)) {
        report.collisions.push({
          type: 'edge_label_node_crossing',
          edge: `${sourceId} -> ${targetId}`,
          label: label.text,
          node: comp.id,
          details: `Relationship label '${label.text}' on edge '${sourceId} -> ${targetId}' overlaps with node '${comp.label}' (${comp.id}).`
        });
      }
    }
  }

  // 3. Proximity check — flag non-overlapping nodes closer than 45px
  const minSafeDistance = 45;
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const nA = components[i];
      const nB = components[j];

      const edgeDistance = boxEdgeDistance(nA, nB);
      if (edgeDistance > 0 && edgeDistance < minSafeDistance) {
        report.collisions.push({
          type: 'tight_spacing',
          elements: [nA.id, nB.id],
          distance: Math.round(edgeDistance),
          details: `Nodes '${nA.label}' and '${nB.label}' are extremely close (${Math.round(edgeDistance)}px separation), which may overlap text or look cramped.`
        });
      }
    }
  }

  // 4. Aspect Ratio check — flag layout if ratio is outside [1.0, 2.0]
  const ratio = parseFloat(report.aspectRatio);
  if (ratio < 1.0 || ratio > 2.0) {
    report.collisions.push({
      type: 'poor_aspect_ratio',
      details: `The layout aspect ratio is ${report.aspectRatio}, which is outside the ideal range [1.0, 2.0]. Adjust vertical/horizontal spacing or layout direction to make it more balanced.`
    });
  }

  return report;
}
