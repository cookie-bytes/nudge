// The single-Boundary contract: diagrams outside it must be refused, loudly.
//
// These fixtures used to live in the quality corpus and render "successfully"
// with half their elements missing — `container_plan.js` plans one Boundary and
// silently dropped the rest, while the relationships pointing at the dropped
// elements were still routed to meaningless coordinates. Both graded PASSED,
// because every quality metric is computed over the elements that did render.
//
// Nudge is a single-Boundary tool by design (see src/core/validation.js), so the
// fix is a refusal rather than a layout. They are kept as fixtures precisely so
// the refusal is tested against the real shapes that motivated it: silently
// dropping user content must never come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../../src/plantuml_parser.js';
import { normalizeDiagramModel } from '../../src/core/optimizer.js';
import { findUnsupportedStructure } from '../../src/core/validation.js';

const REJECTED_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'rejected'
);

/** Every rejected fixture, and the reason it must be rejected for. */
const EXPECTED = {
  'multi_boundary_cross_parent_routes.mermaid': 'multiple_boundaries',
  'multi_boundary_cross_parent_routes.puml': 'multiple_boundaries',
  'nested_boundary_characterization.mermaid': 'nested_boundary',
  'nested_boundary_characterization.puml': 'nested_boundary',
};

function parseFixture(file) {
  const source = fs.readFileSync(path.join(REJECTED_DIR, file), 'utf8');
  return file.endsWith('.puml') ? parsePlantUMLC4(source) : parseMermaidC4(source);
}

test('every rejected fixture is present and accounted for', () => {
  const onDisk = fs.readdirSync(REJECTED_DIR)
    .filter(f => f.endsWith('.mermaid') || f.endsWith('.puml'))
    .sort();
  assert.deepEqual(
    onDisk, Object.keys(EXPECTED).sort(),
    'test/fixtures/rejected/ and EXPECTED have drifted apart. A fixture with no ' +
    'expected reason would never be asserted on.'
  );
});

test('unsupported diagrams are refused by normalizeDiagramModel', () => {
  for (const [file, reason] of Object.entries(EXPECTED)) {
    const model = parseFixture(file);

    assert.throws(
      () => normalizeDiagramModel(model),
      (err) => {
        assert.equal(err.code, 'UNSUPPORTED_DIAGRAM', `${file}: wrong error code`);
        assert.equal(err.reason, reason, `${file}: wrong reason`);
        assert.ok(err.boundaries.length > 0, `${file}: no boundary ids reported`);
        return true;
      },
      `${file} was accepted — it would render with elements silently missing`
    );
  }
});

test('the refusal names the boundaries and says what to do instead', () => {
  const multi = findUnsupportedStructure(parseFixture('multi_boundary_cross_parent_routes.mermaid'));
  assert.equal(multi.reason, 'multiple_boundaries');
  // Both offending boundaries must be named, or the user cannot find them.
  assert.ok(multi.boundaries.includes('frontend'), 'first boundary not reported');
  assert.ok(multi.boundaries.includes('platform'), 'second boundary not reported');
  assert.match(multi.message, /Experience Layer/, 'boundary label missing from message');
  assert.match(multi.message, /System_Ext|split/i, 'message does not say what to do instead');

  const nested = findUnsupportedStructure(parseFixture('nested_boundary_characterization.mermaid'));
  assert.equal(nested.reason, 'nested_boundary');
  assert.ok(nested.boundaries.includes('bank'), 'outer boundary not reported');
  assert.match(nested.message, /nested inside/, 'message does not describe the nesting');
  assert.match(nested.message, /Flatten|split/i, 'message does not say what to do instead');
});

test('a single boundary containing leaf elements is still supported', () => {
  // The contract is about *nesting* and *siblings*, not the keyword. An
  // Enterprise_Boundary wrapping plain systems is one boundary and must pass —
  // bigbankplc_landscape.puml in the third-party corpus is exactly this shape.
  const model = {
    diagramType: 'C4Container',
    nodes: [
      { id: 'p', type: 'person', label: 'User' },
      {
        id: 'only', type: 'boundary', label: 'The System',
        children: [
          { id: 'a', type: 'container', label: 'API' },
          { id: 'b', type: 'database', label: 'Store' },
        ]
      },
      { id: 'x', type: 'external', label: 'Third Party' },
    ],
    edges: [{ from: 'p', to: 'a' }],
  };
  assert.equal(findUnsupportedStructure(model), null);
  assert.doesNotThrow(() => normalizeDiagramModel(model));
});

test('a C4Context diagram still gets its synthetic boundary', () => {
  // The synthetic wrap happens *after* validation, and adds the only boundary to
  // a diagram that had none — it must not trip the contract it runs behind.
  const model = {
    diagramType: 'C4Context',
    title: 'Ordering',
    nodes: [
      { id: 'p', type: 'person', label: 'Customer' },
      { id: 's', type: 'container', label: 'Ordering' },
    ],
    edges: [{ from: 'p', to: 's' }],
  };
  const normalized = normalizeDiagramModel(model);
  const boundaries = normalized.nodes.filter(n => n.type === 'boundary');
  assert.equal(boundaries.length, 1, 'expected exactly one synthetic boundary');
  assert.ok(boundaries[0]._synthetic, 'the added boundary should be marked synthetic');
});
