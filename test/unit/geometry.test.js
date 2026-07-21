import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLayout } from '../../src/core/geometry.js';

test('analyzeLayout detects visual node overlaps', () => {
  const layoutData = {
    width: 800,
    height: 600,
    nodes: [
      { id: 'nodeA', label: 'Node A', x: 100, y: 100, width: 100, height: 100 },
      { id: 'nodeB', label: 'Node B', x: 150, y: 150, width: 100, height: 100 }, // Overlaps nodeA
      { id: 'nodeC', label: 'Node C', x: 400, y: 400, width: 100, height: 100 }  // Safe
    ],
    edges: []
  };

  const report = analyzeLayout(layoutData);

  assert.equal(report.overlapCount, 1);
  const overlap = report.collisions.find(c => c.type === 'node_overlap');
  assert.ok(overlap);
  assert.match(overlap.details, /Node A.*Node B.*overlap/i);
});

test('analyzeLayout detects connection-line element (edge-node) crossings', () => {
  const layoutData = {
    width: 800,
    height: 600,
    nodes: [
      { id: 'nodeA', label: 'Node A', x: 50, y: 100, width: 50, height: 50 },
      { id: 'nodeB', label: 'Node B', x: 250, y: 100, width: 50, height: 50 },
      { id: 'nodeC', label: 'Node C', x: 150, y: 100, width: 50, height: 50 }  // Sits directly in between A and B
    ],
    edges: [
      {
        id: 'edge1',
        labels: [],
        sources: ['nodeA'],
        targets: ['nodeB'],
        sections: [
          {
            startPoint: { x: 75, y: 125 },
            endPoint: { x: 275, y: 125 },
            bendPoints: [] // Direct straight horizontal line from A to B
          }
        ]
      }
    ]
  };

  const report = analyzeLayout(layoutData);
  
  const crossings = report.collisions.filter(c => c.type === 'edge_node_crossing');
  assert.ok(crossings.length >= 1);
  assert.match(crossings[0].details, /cuts directly through node 'Node C'/);
});

test('analyzeLayout detects connection-line crossings (edge-edge crossings)', () => {
  const layoutData = {
    width: 800,
    height: 600,
    nodes: [
      { id: 'n1', label: 'Node 1', x: 100, y: 100, width: 50, height: 50 },
      { id: 'n2', label: 'Node 2', x: 300, y: 300, width: 50, height: 50 },
      { id: 'n3', label: 'Node 3', x: 300, y: 100, width: 50, height: 50 },
      { id: 'n4', label: 'Node 4', x: 100, y: 300, width: 50, height: 50 }
    ],
    edges: [
      {
        id: 'edge12',
        labels: [],
        sources: ['n1'],
        targets: ['n2'],
        sections: [
          { startPoint: { x: 125, y: 125 }, endPoint: { x: 325, y: 325 }, bendPoints: [] } // Diagonal down-right
        ]
      },
      {
        id: 'edge34',
        labels: [],
        sources: ['n3'],
        targets: ['n4'],
        sections: [
          { startPoint: { x: 325, y: 125 }, endPoint: { x: 125, y: 325 }, bendPoints: [] } // Diagonal down-left, intersects edge12
        ]
      }
    ]
  };

  const report = analyzeLayout(layoutData);
  
  assert.ok(report.edgeQuality.edgeCrossingCount >= 1);
});

test('analyzeLayout calculates aspect ratio and tight spacing', () => {
  const layoutData = {
    width: 400,
    height: 200,
    nodes: [
      { id: 'nodeA', label: 'Node A', x: 100, y: 100, width: 100, height: 100 },
      { id: 'nodeB', label: 'Node B', x: 220, y: 100, width: 100, height: 100 } // separation = 20px (less than 45px)
    ],
    edges: []
  };

  const report = analyzeLayout(layoutData);

  assert.equal(report.aspectRatio, '2.00'); // 400 / 200
  
  // Checks tight spacing (less than 45px)
  const tightCollisions = report.collisions.filter(c => c.type === 'tight_spacing');
  assert.equal(tightCollisions.length, 1);
  assert.match(tightCollisions[0].details, /cramped/);
});

// --- Notes as obstacles -----------------------------------------------------

test('analyzeLayout counts a note overlapping a node as note_overlap, not node_overlap', () => {
  const layoutData = {
    width: 800,
    height: 600,
    nodes: [
      { id: 'sys', label: 'System', type: 'container', x: 100, y: 100, width: 120, height: 80 }
    ],
    edges: [],
    notes: [
      { id: 'note_0', type: 'note', x: 150, y: 120, width: 100, height: 50 } // straddles sys
    ]
  };

  const report = analyzeLayout(layoutData);

  assert.equal(report.noteOverlapCount, 1);
  assert.equal(report.overlapCount, 0, 'a note overlap must not inflate the node overlap count');
  const noteOverlap = report.collisions.find(c => c.type === 'note_overlap');
  assert.ok(noteOverlap);
  assert.deepEqual(noteOverlap.elements, ['note_0', 'sys']);
});

test('analyzeLayout detects a note-note overlap', () => {
  const report = analyzeLayout({
    width: 800, height: 600, nodes: [], edges: [],
    notes: [
      { id: 'note_0', type: 'note', x: 100, y: 100, width: 100, height: 50 },
      { id: 'note_1', type: 'note', x: 140, y: 120, width: 100, height: 50 }
    ]
  });
  assert.equal(report.noteOverlapCount, 1);
  assert.ok(report.collisions.some(c => c.type === 'note_overlap'));
});

test('analyzeLayout flags a connection line crossing a note as note_edge_crossing', () => {
  const layoutData = {
    width: 800,
    height: 600,
    nodes: [
      { id: 'a', label: 'A', type: 'container', x: 50, y: 100, width: 50, height: 50 },
      { id: 'b', label: 'B', type: 'container', x: 400, y: 100, width: 50, height: 50 }
    ],
    edges: [
      {
        id: 'edge_0', labels: [], sources: ['a'], targets: ['b'],
        sections: [{ startPoint: { x: 100, y: 125 }, endPoint: { x: 400, y: 125 }, bendPoints: [] }]
      }
    ],
    notes: [
      { id: 'note_0', type: 'note', x: 200, y: 100, width: 60, height: 50 } // sits on the a→b line
    ]
  };

  const report = analyzeLayout(layoutData);

  assert.equal(report.noteEdgeCrossingCount, 1);
  const crossing = report.collisions.find(c => c.type === 'note_edge_crossing');
  assert.ok(crossing);
  assert.equal(crossing.note, 'note_0');
  // A note is never an edge endpoint, so it is never excluded like source/target
  // and never mistaken for one — the crossing is reported.
});

test('analyzeLayout leaves note counts at zero when there are no notes', () => {
  const report = analyzeLayout({
    width: 400, height: 200,
    nodes: [{ id: 'a', label: 'A', type: 'container', x: 0, y: 0, width: 50, height: 50 }],
    edges: []
  });
  assert.equal(report.noteOverlapCount, 0);
  assert.equal(report.noteEdgeCrossingCount, 0);
});
