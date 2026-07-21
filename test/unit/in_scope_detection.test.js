import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchInScopeByTitle,
  detectInScopeSystem,
  normalizeDiagramModel
} from '../../src/core/optimizer.js';

// --- Title-match heuristic --------------------------------------------------
// Candidate lists mirror the internal `container` systems of the real example
// diagrams (externals excluded, since detection only scores containers).

test('matchInScopeByTitle picks the focal system across the example titles', () => {
  const cases = [
    {
      name: 'internet_banking',
      title: 'Internet Banking System',
      candidates: [{ id: 'bankingSystem', label: 'Internet Banking System' }],
      expected: 'bankingSystem'
    },
    {
      name: 'auction_context',
      title: 'C4 Context Diagram : System Context Diagram - Auction Service',
      candidates: [{ id: 'auction', label: 'Auction Service' }],
      expected: 'auction'
    },
    {
      name: 'auction_simple',
      title: 'Auction Service Context - Simplified',
      candidates: [{ id: 'auction', label: 'Auction Service' }],
      expected: 'auction'
    },
    {
      name: 'mcm_context',
      title: 'C4 Context Diagram – MCM (Multi Channel Management)',
      candidates: [
        { id: 'mcm', label: 'MCM – Multi Channel Management' },
        { id: 'svv', label: 'SVV – Single Vehicle View' },
        { id: 'website', label: 'Manheim Website' },
        { id: 'aims', label: 'AIMS' },
        { id: 'salesforce', label: 'Salesforce' }
      ],
      expected: 'mcm'
    },
    {
      name: 'svv_context',
      title: 'C4 Context Diagram – SVV (Single Vehicle View)',
      candidates: [
        { id: 'svv', label: 'SVV – Single Vehicle View' },
        { id: 'aims', label: 'AIMS' },
        { id: 'website', label: 'Manheim Website' },
        { id: 'mcm', label: 'MCM' },
        { id: 'imagery', label: 'Vehicle Imagery / 360°' }
      ],
      expected: 'svv'
    }
  ];

  for (const c of cases) {
    const winner = matchInScopeByTitle(c.title, c.candidates);
    assert.ok(winner, `${c.name}: expected a match`);
    assert.equal(winner.id, c.expected, `${c.name}: wrong winner`);
  }
});

test('matchInScopeByTitle fails safe when the title names no system', () => {
  // The YAML example title ("Nudge E-Commerce System Context") shares no
  // distinctive token with any of its container labels.
  const candidates = [
    { id: 'gateway', label: 'API Gateway' },
    { id: 'auth_service', label: 'Auth Service' },
    { id: 'order_service', label: 'Order Service' },
    { id: 'payment_service', label: 'Payment Service' },
    { id: 'database', label: 'Main Database' }
  ];
  assert.equal(matchInScopeByTitle('Nudge E-Commerce System Context', candidates), null);
});

test('matchInScopeByTitle fails safe on a tie', () => {
  // Two candidates match the same single distinctive token → ambiguous.
  const candidates = [
    { id: 'a', label: 'Payments Service' },
    { id: 'b', label: 'Payments Gateway' }
  ];
  assert.equal(matchInScopeByTitle('Payments Context', candidates), null);
});

test('matchInScopeByTitle returns null when there are no candidates', () => {
  assert.equal(matchInScopeByTitle('Anything', []), null);
});

// --- detectInScopeSystem ----------------------------------------------------

test('detectInScopeSystem flags the winner and marks the rest as supporting', () => {
  const model = {
    diagramType: 'C4Context',
    title: 'C4 Context Diagram – MCM (Multi Channel Management)',
    nodes: [
      { id: 'salesOps', label: 'Sales Operations Team', type: 'person' },
      { id: 'mcm', label: 'MCM – Multi Channel Management', type: 'container' },
      { id: 'svv', label: 'SVV – Single Vehicle View', type: 'container' },
      { id: 'website', label: 'Manheim Website', type: 'container' }
    ]
  };

  const winner = detectInScopeSystem(model);
  assert.equal(winner.id, 'mcm');

  const mcm = model.nodes.find(n => n.id === 'mcm');
  const svv = model.nodes.find(n => n.id === 'svv');
  const website = model.nodes.find(n => n.id === 'website');
  const person = model.nodes.find(n => n.id === 'salesOps');

  assert.equal(mcm.inScope, true);
  assert.ok(!mcm.supporting);
  assert.equal(svv.supporting, true);
  assert.ok(!svv.inScope);
  assert.equal(website.supporting, true);
  // Persons are never candidates.
  assert.ok(!person.inScope && !person.supporting);
});

test('detectInScopeSystem recurses into boundaries', () => {
  const model = {
    diagramType: 'C4Context',
    title: 'Internet Banking System',
    nodes: [
      {
        id: 'b', label: 'Group', type: 'boundary', children: [
          { id: 'bankingSystem', label: 'Internet Banking System', type: 'container' },
          { id: 'other', label: 'Other Portal', type: 'container' }
        ]
      }
    ]
  };
  const winner = detectInScopeSystem(model);
  assert.equal(winner.id, 'bankingSystem');
  assert.equal(model.nodes[0].children[0].inScope, true);
  assert.equal(model.nodes[0].children[1].supporting, true);
});

test('detectInScopeSystem flags nothing when the title matches none', () => {
  const model = {
    diagramType: 'C4Context',
    title: 'Nudge E-Commerce System Context',
    nodes: [
      { id: 'gateway', label: 'API Gateway', type: 'container' },
      { id: 'order_service', label: 'Order Service', type: 'container' }
    ]
  };
  assert.equal(detectInScopeSystem(model), null);
  for (const n of model.nodes) {
    assert.ok(!n.inScope && !n.supporting);
  }
});

test('detectInScopeSystem honours the %% Scope override over the title match', () => {
  const model = {
    diagramType: 'C4Context',
    title: 'C4 Context Diagram – MCM (Multi Channel Management)',
    scopeId: 'svv',
    nodes: [
      { id: 'mcm', label: 'MCM – Multi Channel Management', type: 'container' },
      { id: 'svv', label: 'SVV – Single Vehicle View', type: 'container' }
    ]
  };
  const winner = detectInScopeSystem(model);
  assert.equal(winner.id, 'svv');
  assert.equal(model.nodes.find(n => n.id === 'svv').inScope, true);
  assert.equal(model.nodes.find(n => n.id === 'mcm').supporting, true);
});

// --- normalizeDiagramModel end-to-end --------------------------------------

test('normalizeDiagramModel sets inScope before wrapping in the synthetic boundary', () => {
  const model = {
    diagramType: 'C4Context',
    title: 'C4 Context Diagram – MCM (Multi Channel Management)',
    nodes: [
      { id: 'salesOps', label: 'Sales Operations Team', type: 'person' },
      { id: 'mcm', label: 'MCM – Multi Channel Management', type: 'container' },
      { id: 'svv', label: 'SVV – Single Vehicle View', type: 'container' }
    ]
  };
  normalizeDiagramModel(model);

  // Central prominence: the focal (in-scope) system and its peer supporting
  // systems all stay inside the synthetic boundary; only people/externals sit
  // outside. The focal is distinguished by the `inScope` flag (colour), not by
  // being ejected. The flag rode along on the matched node, supporting on peers.
  const boundary = model.nodes.find(n => n.id === '__context_boundary');
  assert.ok(boundary, 'expected synthetic boundary');
  const mcm = boundary.children.find(n => n.id === 'mcm');
  assert.equal(mcm.inScope, true);

  const svv = boundary.children.find(n => n.id === 'svv');
  assert.ok(svv, 'peer supporting system should stay inside the boundary');
  assert.equal(svv.supporting, true);
});

test('normalizeDiagramModel keeps all internal systems inside when no in-scope hub matches', () => {
  const model = {
    diagramType: 'C4Context',
    title: 'Unrelated Overview',
    nodes: [
      { id: 'salesOps', label: 'Sales Operations Team', type: 'person' },
      { id: 'mcm', label: 'MCM – Multi Channel Management', type: 'container' },
      { id: 'svv', label: 'SVV – Single Vehicle View', type: 'container' }
    ]
  };
  normalizeDiagramModel(model);

  // No confident title match — both internal systems stay inside the boundary,
  // as they always do now. Prominence is never forced structurally, so there is
  // no "centering skipped" diagnostic to report.
  const boundary = model.nodes.find(n => n.id === '__context_boundary');
  assert.ok(boundary, 'expected synthetic boundary');
  assert.equal(boundary.children.filter(n => n.type === 'container').length, 2);
  assert.ok(!model._notes || model._notes.length === 0,
    'no centering diagnostic should be recorded');
});

test('normalizeDiagramModel passes the top-level notes array through untouched', () => {
  const notes = [
    { id: 'note_0', text: 'This handles auth', position: 'right', refs: ['mcm'] }
  ];
  const model = {
    diagramType: 'C4Context',
    title: 'C4 Context Diagram – MCM (Multi Channel Management)',
    nodes: [
      { id: 'salesOps', label: 'Sales Operations Team', type: 'person' },
      { id: 'mcm', label: 'MCM – Multi Channel Management', type: 'container' },
      { id: 'svv', label: 'SVV – Single Vehicle View', type: 'container' }
    ],
    notes
  };
  normalizeDiagramModel(model);

  // Notes are annotations, never Architecture Elements: they survive the
  // synthetic-boundary wrap by identity and never leak into nodes.
  assert.equal(model.notes, notes, 'notes array should survive by identity');
  const containsNote = (list) => (list || []).some(n => String(n.id).startsWith('note_'));
  assert.ok(!containsNote(model.nodes), 'notes must not appear at the node root');
  const boundary = model.nodes.find(n => n.id === '__context_boundary');
  assert.ok(!containsNote(boundary?.children), 'notes must not appear inside the synthetic boundary');
});

test('normalizeDiagramModel does not run detection for C4Container diagrams', () => {
  const model = {
    diagramType: 'C4Container',
    title: 'Internet Banking System',
    nodes: [
      { id: 'b', label: 'Boundary', type: 'boundary', children: [
        { id: 'bankingSystem', label: 'Internet Banking System', type: 'container' }
      ] }
    ]
  };
  normalizeDiagramModel(model);
  assert.ok(!model.nodes[0].children[0].inScope);
});
