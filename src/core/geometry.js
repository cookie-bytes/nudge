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

function pointInsideBox(point, box) {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function segmentIntersectsBox(p1, p2, box) {
  return (
    pointInsideBox(p1, box) ||
    pointInsideBox(p2, box) ||
    lineIntersectsBox(p1.x, p1.y, p2.x, p2.y, box)
  );
}

function segmentOrientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointsNear(a, b, tolerance = 2) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

function pointOnSegment(a, b, p) {
  return (
    p.x >= Math.min(a.x, b.x) - 1 &&
    p.x <= Math.max(a.x, b.x) + 1 &&
    p.y >= Math.min(a.y, b.y) - 1 &&
    p.y <= Math.max(a.y, b.y) + 1 &&
    Math.abs(segmentOrientation(a, b, p)) < 1
  );
}

function segmentsCross(segA, segB) {
  const a = segA.a, b = segA.b, c = segB.a, d = segB.b;
  if (pointsNear(a, c) || pointsNear(a, d) || pointsNear(b, c) || pointsNear(b, d)) {
    return false;
  }

  const o1 = segmentOrientation(a, b, c);
  const o2 = segmentOrientation(a, b, d);
  const o3 = segmentOrientation(c, d, a);
  const o4 = segmentOrientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }

  return pointOnSegment(a, b, c) || pointOnSegment(a, b, d) ||
         pointOnSegment(c, d, a) || pointOnSegment(c, d, b);
}

function segmentOverlapLength(segA, segB) {
  const a = segA.a, b = segA.b, c = segB.a, d = segB.b;
  const aHorizontal = Math.abs(a.y - b.y) < 2;
  const bHorizontal = Math.abs(c.y - d.y) < 2;
  const aVertical = Math.abs(a.x - b.x) < 2;
  const bVertical = Math.abs(c.x - d.x) < 2;

  if (aHorizontal && bHorizontal && Math.abs(a.y - c.y) < 6) {
    const lo = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
    const hi = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
    return Math.max(0, hi - lo);
  }
  if (aVertical && bVertical && Math.abs(a.x - c.x) < 6) {
    const lo = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
    const hi = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
    return Math.max(0, hi - lo);
  }
  return 0;
}

function getEdgePoints(edge) {
  if (!edge.sections || edge.sections.length === 0) return [];
  const section = edge.sections[0];
  return [
    { x: section.startPoint.x, y: section.startPoint.y },
    ...(section.bendPoints || []).map(p => ({ x: p.x, y: p.y })),
    { x: section.endPoint.x, y: section.endPoint.y }
  ];
}

function getEdgeSegments(edge) {
  const points = getEdgePoints(edge);
  return points.slice(0, -1).map((point, index) => ({
    edgeId: edge.id,
    edge,
    a: point,
    b: points[index + 1]
  })).filter(seg => Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) > 0.5);
}

function normalizeBundleLabel(edge) {
  return (edge.labels?.[0]?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function canBundleEdges(edgeA, edgeB) {
  if (!edgeA || !edgeB || edgeA.id === edgeB.id) return false;
  const label = normalizeBundleLabel(edgeA);
  if (!label || label !== normalizeBundleLabel(edgeB)) return false;
  return edgeA.sources?.[0] === edgeB.sources?.[0] &&
         edgeA.targets?.[0] !== edgeB.targets?.[0];
}

function segmentLength(seg) {
  return Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
}

function getPointAtDistance(points, distance) {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];

  let remaining = distance;
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (remaining <= len || i === points.length - 2) {
      const t = len > 0 ? Math.max(0, Math.min(1, remaining / len)) : 0;
      return {
        x: p1.x + t * (p2.x - p1.x),
        y: p1.y + t * (p2.y - p1.y)
      };
    }
    remaining -= len;
  }

  return points[points.length - 1];
}

function estimateLabelBox(edge) {
  if (!edge.labels || edge.labels.length === 0) return null;
  const points = getEdgePoints(edge);
  if (points.length < 2) return null;

  const label = edge.labels[0];
  const H_PAD = 10;
  const V_PAD = 3;

  if (Number.isFinite(label.x) && Number.isFinite(label.y)) {
    return {
      x: label.x - label.width / 2 - H_PAD,
      y: label.y - label.height / 2 - V_PAD,
      width: label.width + 2 * H_PAD,
      height: label.height + 2 * V_PAD
    };
  }

  const totalLen = getEdgeSegments(edge).reduce((sum, seg) => sum + segmentLength(seg), 0);
  const anchorDist = Math.min(Math.max(45, (label.width || 0) / 2 + 20), totalLen / 2);
  const center = totalLen > 0
    ? getPointAtDistance(points, Math.max(anchorDist, totalLen / 2))
    : points[0];

  return {
    x: center.x - label.width / 2 - H_PAD,
    y: center.y - label.height / 2 - V_PAD,
    width: label.width + 2 * H_PAD,
    height: label.height + 2 * V_PAD
  };
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

function analyzeEdgeQuality(edges) {
  const edgeSegments = edges.flatMap(getEdgeSegments);
  const quality = {
    edgeCrossingCount: 0,
    edgeOverlapCount: 0,
    edgeOverlapPx: 0,
    labelEdgeIntersectionCount: 0,
    totalBends: 0,
    totalRouteLength: 0
  };

  for (const edge of edges) {
    const segments = getEdgeSegments(edge);
    quality.totalBends += edge.sections?.[0]?.bendPoints?.length || 0;
    quality.totalRouteLength += segments.reduce((sum, seg) => sum + segmentLength(seg), 0);
  }

  for (let i = 0; i < edgeSegments.length; i++) {
    for (let j = i + 1; j < edgeSegments.length; j++) {
      const segA = edgeSegments[i];
      const segB = edgeSegments[j];
      if (segA.edgeId === segB.edgeId) continue;

      const overlapPx = segmentOverlapLength(segA, segB);
      if (overlapPx > 20) {
        if (canBundleEdges(segA.edge, segB.edge)) continue;
        quality.edgeOverlapCount++;
        quality.edgeOverlapPx += overlapPx;
      } else if (segmentsCross(segA, segB)) {
        quality.edgeCrossingCount++;
      }
    }
  }

  for (const edge of edges) {
    const labelBox = estimateLabelBox(edge);
    if (!labelBox) continue;
    for (const seg of edgeSegments) {
      if (seg.edgeId === edge.id) continue;
      if (segmentIntersectsBox(seg.a, seg.b, labelBox)) {
        quality.labelEdgeIntersectionCount++;
        break;
      }
    }
  }

  quality.edgeOverlapPx = Math.round(quality.edgeOverlapPx);
  quality.totalRouteLength = Math.round(quality.totalRouteLength);
  return quality;
}

// Perform complete geometric layout critique
export function analyzeLayout(layoutData) {
  const { nodes, edges, width, height, notes = [] } = layoutData;
  const report = {
    collisions: [],
    overlapCount: 0,
    intersectionCount: 0,
    labelElementCrossingCount: 0,
    labelLabelOverlapCount: 0,
    labelOffCanvasCount: 0,
    noteOverlapCount: 0,
    noteEdgeCrossingCount: 0,
    edgeQuality: analyzeEdgeQuality(edges || []),
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
    const label = edge.labels[0];

    // Score the box the renderer actually drew. Re-deriving a placement here
    // meant the critic judged a position nothing was ever rendered at.
    const labelBox = estimateLabelBox(edge);
    if (!labelBox) continue;

    // Endpoints are not exempt: the renderer treats every element as an
    // obstacle, so a label buried in its own source is a real defect.
    for (const comp of components) {
      if (boxesOverlap(labelBox, comp)) {
        report.labelElementCrossingCount++;
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

  // 2b-ii. Labels that fall outside the canvas. A clipped or invisible label is
  // information-destroying in a way nothing measured, so the UNSATISFIABLE
  // fallback's trade — an off-canvas label becomes a visible overlapping one —
  // was previously only visible as a cost, never as a benefit (INC-16).
  for (const edge of edges) {
    if (!edge.sections || edge.sections.length === 0) continue;
    if (!edge.labels || edge.labels.length === 0) continue;
    const labelBox = estimateLabelBox(edge);
    if (!labelBox) continue;
    if (
      labelBox.x < -0.5 || labelBox.y < -0.5 ||
      labelBox.x + labelBox.width > width + 0.5 ||
      labelBox.y + labelBox.height > height + 0.5
    ) {
      report.labelOffCanvasCount++;
      report.collisions.push({
        type: 'edge_label_off_canvas',
        edge: edge.id,
        label: edge.labels[0].text,
        details: `Relationship label '${edge.labels[0].text}' falls outside the ${width}×${height} canvas.`
      });
    }
  }

  // 2c. Check for edge labels overlapping each other. Two labels sharing pixels
  // are as unreadable as one buried in a box, and nothing measured this before.
  const labelBoxes = [];
  for (const edge of edges) {
    if (!edge.sections || edge.sections.length === 0) continue;
    if (!edge.labels || edge.labels.length === 0) continue;
    const box = estimateLabelBox(edge);
    if (box) labelBoxes.push({ edge, box, text: edge.labels[0].text });
  }
  for (let i = 0; i < labelBoxes.length; i++) {
    for (let j = i + 1; j < labelBoxes.length; j++) {
      const a = labelBoxes[i];
      const b = labelBoxes[j];
      if (!boxesOverlap(a.box, b.box)) continue;
      report.labelLabelOverlapCount++;
      report.collisions.push({
        type: 'edge_label_label_overlap',
        edges: [a.edge.id, b.edge.id],
        labels: [a.text, b.text],
        details: `Relationship labels '${a.text}' and '${b.text}' overlap each other.`
      });
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

  // 4. Notes as obstacles. Notes are annotations, not layout participants, but
  // the critic treats their boxes as real obstacles so occlusion is measured
  // and drives auto-placement (see docs/c4-notes-implementation-plan.md). No
  // edge references a note id, so notes are never selected as an edge endpoint
  // — the exclusion is automatic and needs no guard.

  // 4a. Note ↔ element overlap and note ↔ note overlap.
  for (const note of notes) {
    for (const comp of components) {
      if (boxesOverlap(note, comp)) {
        report.noteOverlapCount++;
        report.collisions.push({
          type: 'note_overlap',
          elements: [note.id, comp.id],
          details: `Note '${note.id}' overlaps node '${comp.label}' (${comp.id}).`
        });
      }
    }
  }
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      if (boxesOverlap(notes[i], notes[j])) {
        report.noteOverlapCount++;
        report.collisions.push({
          type: 'note_overlap',
          elements: [notes[i].id, notes[j].id],
          details: `Notes '${notes[i].id}' and '${notes[j].id}' overlap.`
        });
      }
    }
  }

  // 4b. Connection line crossing a note box.
  for (const edge of edges) {
    if (!edge.sections || edge.sections.length === 0) continue;
    const section = edge.sections[0];
    const points = [{ x: section.startPoint.x, y: section.startPoint.y }];
    if (section.bendPoints) points.push(...section.bendPoints);
    points.push({ x: section.endPoint.x, y: section.endPoint.y });

    for (const note of notes) {
      let crosses = false;
      for (let i = 0; i < points.length - 1 && !crosses; i++) {
        if (lineIntersectsBox(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, note)) {
          crosses = true;
        }
      }
      if (crosses) {
        report.noteEdgeCrossingCount++;
        report.collisions.push({
          type: 'note_edge_crossing',
          edge: `${edge.sources?.[0]} -> ${edge.targets?.[0]}`,
          note: note.id,
          details: `Connection line '${edge.sources?.[0]} -> ${edge.targets?.[0]}' crosses note '${note.id}'.`
        });
      }
    }
  }

  return report;
}
