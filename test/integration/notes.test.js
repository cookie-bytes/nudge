import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { analyzeLayout } from '../../src/core/geometry.js';
import { optimizeDiagram } from '../../src/core/optimizer.js';

const FIXTURE = path.resolve('examples/system_context_with_notes.mermaid');

function tmpOut() {
  return path.join(os.tmpdir(), `nudge-notes-${randomUUID()}`);
}

// End-to-end: parse → normalise → layout → position notes → critic → auto-place.
// The fixture deliberately crowds two anchors (a note whose `over` hint lands on
// a connection line, and a two-anchor `over` that clamps onto its anchors), so
// the auto-placement loop must relocate them. A clean result with no warnings
// proves positioning, the note-obstacle critic, and auto-placement all work.
test('optimizeDiagram positions notes and auto-places them without overlap', async () => {
  const model = parseMermaidC4(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(model.notes.length, 4);

  const outputDir = tmpOut();
  try {
    const result = await optimizeDiagram({
      diagramModel: model,
      outputDir,
      onLog: () => {},
      enhance: false,
    });

    assert.equal(result.success, true, 'expected a clean layout (no node overlaps/crossings)');
    assert.deepEqual(result.warnings, [], 'every note should have found a clear placement');

    // The exported SVG carries the note boxes and their text, and the .note
    // style lives inline (captureSvg embeds <head><style>).
    const svg = fs.readFileSync(path.join(outputDir, 'optimized.svg'), 'utf8');
    assert.match(svg, /class="note"/, 'expected a rendered note box');
    assert.ok(svg.includes('Owned by Team Phoenix'), 'expected note text in the SVG');
    assert.match(svg, /\.note\s*\{[^}]*fill:\s*#fef9c3/, 'expected the .note fill inline');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

// A note whose anchor id does not exist must be skipped (fail-safe) with a
// single warning, and must never crash the render or drop silently.
test('optimizeDiagram warns and skips a note with an unresolved anchor', async () => {
  const model = parseMermaidC4(`
    C4Context
      title Unresolved Note Anchor
      Person(user, "User")
      System(shop, "Shop Platform", "In scope")
      Rel(user, shop, "Uses", "HTTPS")
      %% Scope: shop
      Note right of shop: Valid note
      Note right of ghost: Points at a missing element
  `);

  const outputDir = tmpOut();
  try {
    const result = await optimizeDiagram({
      diagramModel: model,
      outputDir,
      onLog: () => {},
      enhance: false,
    });

    assert.equal(result.warnings.length, 1, 'exactly one unresolved-anchor warning');
    assert.match(result.warnings[0], /note_1/);
    assert.match(result.warnings[0], /resolve/i);

    // The valid note still rendered; the diagram did not crash.
    const svg = fs.readFileSync(path.join(outputDir, 'optimized.svg'), 'utf8');
    assert.ok(svg.includes('Valid note'));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
