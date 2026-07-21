import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';

test('parseMermaidC4 parses diagram types', () => {
  const modelContext = parseMermaidC4('C4Context');
  assert.equal(modelContext.diagramType, 'C4Context');

  const modelContainer = parseMermaidC4('C4Container');
  assert.equal(modelContainer.diagramType, 'C4Container');
});

test('parseMermaidC4 parses diagram title', () => {
  const model = parseMermaidC4(`
    C4Context
      title My Custom System Title
  `);
  assert.equal(model.title, 'My Custom System Title');
});

test('parseMermaidC4 parses system architecture elements', () => {
  const model = parseMermaidC4(`
    C4Context
      Person(user, "User Label", "User Description")
      System(sys, "System Label", "System Description")
  `);
  
  assert.equal(model.nodes.length, 2);
  const user = model.nodes.find(n => n.id === 'user');
  assert.ok(user);
  assert.equal(user.label, 'User Label');
  assert.equal(user.type, 'person');
  assert.equal(user.description, 'User Description');

  const sys = model.nodes.find(n => n.id === 'sys');
  assert.ok(sys);
  assert.equal(sys.label, 'System Label');
  assert.equal(sys.type, 'container');
});

test('parseMermaidC4 parses boundaries and nested children', () => {
  const model = parseMermaidC4(`
    C4Container
      System_Boundary(b1, "Service Boundary") {
        Container(api, "API Service")
        ContainerDb(db, "Database Container")
      }
  `);

  assert.equal(model.nodes.length, 1);
  
  const boundary = model.nodes[0];
  assert.equal(boundary.id, 'b1');
  assert.equal(boundary.type, 'boundary');
  assert.equal(boundary.label, 'Service Boundary');
  assert.equal(boundary.children.length, 2);

  const api = boundary.children.find(n => n.id === 'api');
  assert.ok(api);
  assert.equal(api.type, 'container');

  const db = boundary.children.find(n => n.id === 'db');
  assert.ok(db);
  assert.equal(db.type, 'database');
});

test('parseMermaidC4 parses relationships', () => {
  const model = parseMermaidC4(`
    C4Context
      Person(user, "User")
      System(sys, "System")
      Rel(user, sys, "Uses", "HTTPS")
  `);

  assert.equal(model.edges.length, 1);
  const rel = model.edges[0];
  assert.equal(rel.from, 'user');
  assert.equal(rel.to, 'sys');
  assert.equal(rel.label, 'Uses [HTTPS]');
});

test('parseMermaidC4 parses custom layout ordering rules', () => {
  const model = parseMermaidC4(`
    C4Context
      %% Rule: userA above userB
  `);

  assert.equal(model.rules.length, 1);
  assert.equal(model.rules[0].source, 'userA');
  assert.equal(model.rules[0].relation, 'above');
  assert.equal(model.rules[0].target, 'userB');
});

test('parseMermaidC4 parses the %% Scope override', () => {
  const model = parseMermaidC4(`
    C4Context
      %% Scope: svv
      System(mcm, "MCM")
      System(svv, "SVV")
  `);

  assert.equal(model.scopeId, 'svv');
});

test('parseMermaidC4 leaves scopeId undefined without a Scope comment', () => {
  const model = parseMermaidC4(`
    C4Context
      System(mcm, "MCM")
  `);

  assert.equal(model.scopeId, undefined);
});

test('parseMermaidC4 parses annotation notes without adding them as nodes', () => {
  const model = parseMermaidC4(`
    C4Context
      System(a, "A")
      System(b, "B")
      Note right of a: This handles auth
      Note left of b: Legacy, being retired
      Note over a: Owned by Team Phoenix
      Note over a,b: Shared concern<br/>second line
  `);

  // Notes live in their own collection, never in nodes.
  assert.equal(model.nodes.length, 2);
  assert.equal(model.notes.length, 4);

  assert.deepEqual(model.notes[0], { id: 'note_0', text: 'This handles auth', position: 'right', refs: ['a'] });
  assert.deepEqual(model.notes[1], { id: 'note_1', text: 'Legacy, being retired', position: 'left', refs: ['b'] });
  assert.deepEqual(model.notes[2], { id: 'note_2', text: 'Owned by Team Phoenix', position: 'over', refs: ['a'] });

  // Two-anchor spanning `over X,Y`; <br/> is preserved for the wrapper.
  assert.deepEqual(model.notes[3], {
    id: 'note_3',
    text: 'Shared concern<br/>second line',
    position: 'over',
    refs: ['a', 'b']
  });
});

test('parseMermaidC4 parses floating (unanchored) corner notes with empty refs', () => {
  const model = parseMermaidC4(`
    C4Context
      System(a, "A")
      Note bottom-right: General caveat<br/>about integration
      Note top left: Data classification
  `);

  // Floating notes live in the notes collection, never in nodes.
  assert.equal(model.nodes.length, 1);
  assert.equal(model.notes.length, 2);

  // Hyphen form; empty refs signals a floating (margin-pinned) note.
  assert.deepEqual(model.notes[0], {
    id: 'note_0',
    text: 'General caveat<br/>about integration',
    position: 'bottom-right',
    refs: []
  });
  // Space form is normalised to the hyphen form.
  assert.deepEqual(model.notes[1], {
    id: 'note_1',
    text: 'Data classification',
    position: 'top-left',
    refs: []
  });
});

test('parseMermaidC4 initialises notes to an empty array when there are none', () => {
  const model = parseMermaidC4(`
    C4Context
      System(a, "A")
  `);
  assert.deepEqual(model.notes, []);
});
