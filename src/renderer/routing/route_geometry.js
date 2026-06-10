window.NudgeRenderer.routeGeometry = {
  sectionToPoints(section) {
    return [
      { x: section.startPoint.x, y: section.startPoint.y },
      ...(section.bendPoints || []).map(p => ({ x: p.x, y: p.y })),
      { x: section.endPoint.x, y: section.endPoint.y }
    ];
  },

  pointsToSection(points) {
    return {
      startPoint: points[0],
      bendPoints: points.slice(1, -1),
      endPoint: points[points.length - 1]
    };
  },

  pointsToSegments(points, edgeIndex = -1) {
    return points.slice(0, -1).map((p, i) => ({
      a: p,
      b: points[i + 1],
      edgeIndex
    })).filter(seg => Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) > 0.5);
  },

  clonePoints(points) {
    return points.map(p => ({ x: p.x, y: p.y }));
  },

  createConflictHelpers(MIN_ROUTE_LINE_GAP) {
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

    function segmentParallelProximity(segA, segB) {
      const a = segA.a, b = segA.b, c = segB.a, d = segB.b;
      const aHorizontal = Math.abs(a.y - b.y) < 2;
      const bHorizontal = Math.abs(c.y - d.y) < 2;
      const aVertical = Math.abs(a.x - b.x) < 2;
      const bVertical = Math.abs(c.x - d.x) < 2;
      if (aHorizontal && bHorizontal) {
        const distance = Math.abs(a.y - c.y);
        if (distance < 6 || distance >= MIN_ROUTE_LINE_GAP) return 0;
        const lo = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
        const hi = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
        return Math.max(0, hi - lo);
      }
      if (aVertical && bVertical) {
        const distance = Math.abs(a.x - c.x);
        if (distance < 6 || distance >= MIN_ROUTE_LINE_GAP) return 0;
        const lo = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
        const hi = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
        return Math.max(0, hi - lo);
      }
      return 0;
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

    return {
      segmentOverlapLength,
      segmentParallelProximity,
      segmentOrientation,
      pointsNear,
      pointOnSegment,
      segmentsCross
    };
  }
};
