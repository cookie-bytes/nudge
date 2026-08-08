// The public API is the semver surface (docs/IMPROVEMENT_PLAN.md INC-17), so it
// gets tested through the package entry point — `src/index.js` — and not
// through internals. If one of these tests needs changing, that is a breaking
// change and belongs in CHANGELOG.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
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

test('the exported SVG opens as a standalone document and paints its own ground', { timeout: 180000 }, async () => {
  // The export is consumed as image/svg+xml, not as a fragment inside our own
  // page, so it has to satisfy two things the in-page render never tests.
  //
  // First, well-formed XML: a stray angle bracket anywhere in the inlined
  // stylesheet makes the file refuse to open at all, and nothing in the render
  // pipeline would notice — the PNGs would keep coming out perfect.
  //
  // Second, an opaque ground of its own. `body { background-color }` is inlined
  // along with everything else but matches nothing in a standalone SVG, so
  // until the canvas rect existed every exported diagram was light-on-
  // transparent: fine on our dark page, unreadable on any light background.
  const { svg } = await renderDiagram({ source: MERMAID });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-svg-test-')), 'export.svg');
  fs.writeFileSync(file, svg);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${file}`);
    const probe = await page.evaluate(() => {
      const err = document.querySelector('parsererror');
      if (err) return { parseError: err.textContent.replace(/\s+/g, ' ').slice(0, 300) };
      const root = document.documentElement;
      const ground = document.getElementById('canvas-rect');
      const fill = ground && getComputedStyle(ground).fill;
      const wrappers = [...document.querySelectorAll('foreignObject')]
        .map(fo => fo.firstElementChild)
        .filter(Boolean);
      return {
        parseError: null,
        rootTag: root.tagName,
        hasGround: !!ground,
        groundFill: fill,
        // A token that failed to resolve computes to the initial value, so
        // this also proves the custom properties survived the export.
        lineStroke: getComputedStyle(document.querySelector('.edge-line')).stroke,
        wrapperCount: wrappers.length,
        allWrappersXhtml: wrappers.every(w => w.namespaceURI === 'http://www.w3.org/1999/xhtml'),
        allWrappersPainted: wrappers.every(w => w.getBoundingClientRect().width > 0),
      };
    });

    assert.equal(probe.parseError, null, `exported SVG is not well-formed XML: ${probe.parseError}`);
    assert.equal(probe.rootTag, 'svg');
    assert.ok(probe.hasGround, 'exported SVG must carry its own background rect');
    assert.match(probe.groundFill, /^rgb\(/, 'the ground must resolve to an opaque colour');
    assert.notEqual(probe.groundFill, 'none');
    assert.match(probe.lineStroke, /^rgb\(/, 'theme tokens must resolve in the exported document');

    // Element text is HTML in a foreignObject. Without an explicit xmlns in the
    // markup it re-parses into the SVG namespace and lays out at zero width, so
    // every element in the export is an empty box — invisible to the render
    // pipeline, which only ever measures the live page.
    assert.ok(probe.wrapperCount > 0, 'expected element text wrappers in the export');
    assert.ok(probe.allWrappersXhtml, 'foreignObject content must be in the XHTML namespace');
    assert.ok(probe.allWrappersPainted, 'foreignObject content must lay out with non-zero width');
  } finally {
    await browser.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('renderDiagram renders the requested theme', { timeout: 180000 }, async () => {
  const dark = await renderDiagram({ source: MERMAID, theme: 'dark' });
  const light = await renderDiagram({ source: MERMAID, theme: 'light' });

  assert.match(dark.svg, /<svg[^>]*data-theme="dark"/);
  assert.match(light.svg, /<svg[^>]*data-theme="light"/);

  // Themes are a stylesheet swap, not a different layout: the drawn geometry
  // has to be identical or the two exports are different diagrams.
  const geometry = (svg) => svg.replace(/<style>[\s\S]*?<\/style>/, '').replace(/ data-theme="\w+"/, '');
  assert.equal(geometry(dark.svg), geometry(light.svg), 'themes must not change geometry');

  assert.deepEqual(dark.report, light.report, 'themes must not change the defect vector');
});

test('renderDiagram rejects an unknown theme rather than silently picking one', { timeout: 180000 }, async () => {
  await assert.rejects(() => renderDiagram({ source: MERMAID, theme: 'solarized' }), /unknown theme/);
});

test('the default export follows the viewer, and a pinned one refuses to', { timeout: 180000 }, async () => {
  // The point of the whole exercise: one file that is readable wherever it is
  // opened, instead of a dark diagram that happens to land on a white page.
  const auto = await renderDiagram({ source: MERMAID });
  const pinned = await renderDiagram({ source: MERMAID, theme: 'dark' });

  // An adaptive export carries no data-theme — the attribute is precisely what
  // would stop the media query applying.
  assert.doesNotMatch(auto.svg, /<svg[^>]*data-theme=/);
  assert.match(auto.svg, /@media \(prefers-color-scheme: light\)/);
  assert.doesNotMatch(pinned.svg, /@media \(prefers-color-scheme/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-adaptive-'));
  const browser = await chromium.launch();
  try {
    const ground = async (svg, colorScheme) => {
      const file = path.join(dir, `${colorScheme}-${svg.length}.svg`);
      fs.writeFileSync(file, svg);
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      await page.goto(`file://${file}`);
      const fill = await page.evaluate(() => {
        if (document.querySelector('parsererror')) return 'parse-error';
        return getComputedStyle(document.getElementById('canvas-rect')).fill;
      });
      await context.close();
      return fill;
    };

    const autoDark = await ground(auto.svg, 'dark');
    const autoLight = await ground(auto.svg, 'light');
    assert.notEqual(autoDark, 'parse-error');
    assert.notEqual(
      autoDark, autoLight,
      'the same adaptive file must render differently under the two preferences'
    );

    // Pinning has to beat the viewer in both directions, or "--theme dark" is
    // a suggestion rather than a guarantee.
    assert.equal(await ground(pinned.svg, 'dark'), await ground(pinned.svg, 'light'));
    assert.equal(await ground(pinned.svg, 'light'), autoDark, 'pinned dark must be the dark palette');
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("theme: 'both' writes a suffixed second pair without moving the first", { timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-both-'));
  try {
    const result = await renderDiagram({ source: MERMAID, theme: 'both', outputDir: dir });

    // The primary keeps the unsuffixed names, so adding --theme both to an
    // existing command never moves the files that command already consumed.
    for (const name of ['optimized.png', 'optimized.svg', 'optimized.light.png', 'optimized.light.svg']) {
      assert.ok(fs.existsSync(path.join(dir, name)), `expected ${name}`);
    }
    assert.deepEqual(Object.keys(result.themes).sort(), ['dark', 'light']);
    assert.equal(result.svg, result.themes.dark.svg, 'the primary theme is what `svg` returns');
    assert.match(result.themes.light.svg, /data-theme="light"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
