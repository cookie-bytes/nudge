// The public API is the semver surface (docs/IMPROVEMENT_PLAN.md INC-17), so it
// gets tested through the package entry point — `src/index.js` — and not
// through internals. If one of these tests needs changing, that is a breaking
// change and belongs in CHANGELOG.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { renderDiagram, parseDiagram, detectFormat, FORMATS } from '../../src/index.js';

const MERMAID = fs.readFileSync(
  path.resolve('test/fixtures/diagrams/core/messaging_system.mermaid'), 'utf8'
);
const PLANTUML = fs.readFileSync(
  path.resolve('test/fixtures/diagrams/core/messaging_system.puml'), 'utf8'
);

test('detectFormat recognises each supported format', () => {
  assert.equal(detectFormat(MERMAID), 'mermaid');
  assert.equal(detectFormat(PLANTUML), 'plantuml');
  assert.equal(detectFormat('title: x\nnodes: []\nedges: []\n'), 'yaml');
  assert.deepEqual(FORMATS, ['mermaid', 'plantuml', 'yaml']);
});

test('parseDiagram returns a model with nodes and edges', () => {
  const model = parseDiagram(MERMAID);
  assert.ok(Array.isArray(model.nodes) && model.nodes.length > 0);
  assert.ok(Array.isArray(model.edges) && model.edges.length > 0);
});

test('parseDiagram rejects empty and malformed input rather than returning junk', () => {
  assert.throws(() => parseDiagram(''), TypeError);
  assert.throws(() => parseDiagram(undefined), TypeError);
  assert.throws(() => parseDiagram(MERMAID, { format: 'sketch' }), TypeError);
  assert.throws(() => parseDiagram('title: only\n'), /missing a 'nodes' array/);
});

test('renderDiagram returns self-contained SVG and the full defect vector', { timeout: 180000 }, async () => {
  const result = await renderDiagram({ source: MERMAID });

  assert.equal(typeof result.svg, 'string');
  assert.match(result.svg, /^<svg[\s>]/);
  // Self-contained: the CSS classes live in render.html's <head>, so the export
  // has to inline them or the SVG renders unstyled everywhere else.
  assert.match(result.svg, /<style>/);
  assert.equal(result.success, true);

  for (const key of [
    'elementOverlaps', 'lineElementCrossings', 'labelElementCrossings',
    'lineOverlaps', 'lineCrossings', 'labelLineIntersections', 'labelLabelOverlaps',
  ]) {
    assert.equal(typeof result.report[key], 'number', `report.${key} must be a number`);
  }
  assert.equal(result.report.elementOverlaps, 0);
});

test('renderDiagram writes nothing into the working directory by default', { timeout: 180000 }, async () => {
  // A library that scribbles ./.nudge into the caller's cwd — which is the
  // CLI's default — is unusable inside someone else's build.
  const before = fs.existsSync('.nudge');
  await renderDiagram({ source: MERMAID });
  assert.equal(fs.existsSync('.nudge'), before, 'renderDiagram must not create ./.nudge');
});

test('renderDiagram honours an explicit outputDir', { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-api-test-'));
  const result = await renderDiagram({ source: MERMAID, outputDir: dir });
  assert.ok(fs.readdirSync(dir).length > 0, 'expected artefacts in the requested directory');
  assert.ok(result.png && fs.existsSync(result.png));
});

test('renderDiagram makes no network calls by default', { timeout: 180000 }, async () => {
  // `enhance` defaults to false, so the default path is deterministic and
  // offline. This is the contract that lets Nudge run in a sealed CI job.
  const logs = [];
  await renderDiagram({ source: MERMAID, onLog: m => logs.push(m) });

  // Match evidence of a call being *made*, not the line announcing it is off —
  // the deterministic path logs "LLM is disabled (deterministic-only mode)".
  const llmChatter = logs.filter(l =>
    /Querying|Requesting .*hint|http:\/\/|https:\/\//i.test(l)
  );
  assert.deepEqual(llmChatter, [], `unexpected LLM activity: ${llmChatter.join(', ')}`);
  assert.ok(
    logs.some(l => /LLM is disabled/i.test(l)),
    'expected the deterministic-only path to be taken'
  );
});

test('renderDiagram is deterministic across calls', { timeout: 300000 }, async () => {
  const first = await renderDiagram({ source: MERMAID });
  const second = await renderDiagram({ source: MERMAID });
  assert.equal(first.svg, second.svg);
  assert.deepEqual(first.report, second.report);
});
