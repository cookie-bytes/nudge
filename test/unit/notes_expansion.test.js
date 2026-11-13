import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../../src/plantuml_parser.js';

test('parseMermaidC4 parses below and bottom note variants', () => {
  const mermaid = `
    C4Context
      title Note Direction Parsing
      System(svv, "SVV")
      Note below of svv: Directly underneath
      Note bottom of svv: Also underneath
      Note below svv: Shorthand form
  `;
  const model = parseMermaidC4(mermaid);
  assert.equal(model.notes.length, 3);
  assert.equal(model.notes[0].position, 'below');
  assert.equal(model.notes[0].text, 'Directly underneath');
  assert.equal(model.notes[1].position, 'below');
  assert.equal(model.notes[1].text, 'Also underneath');
  assert.equal(model.notes[2].position, 'below');
  assert.equal(model.notes[2].text, 'Shorthand form');
});

test('parsePlantUMLC4 parses bottom and below note variants', () => {
  const puml = `
    @startuml
    title PlantUML Note Direction Parsing
    System(svv, "SVV")
    note bottom of svv : Directly underneath
    note below of svv : Also underneath
    @enduml
  `;
  const model = parsePlantUMLC4(puml);
  assert.equal(model.notes.length, 2);
  assert.equal(model.notes[0].position, 'below');
  assert.equal(model.notes[0].text, 'Directly underneath');
  assert.equal(model.notes[1].position, 'below');
  assert.equal(model.notes[1].text, 'Also underneath');
});
