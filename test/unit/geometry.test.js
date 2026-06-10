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
