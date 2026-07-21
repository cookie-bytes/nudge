// Renders the same fixture twice on a freshly-navigated page and asserts the two
// renders are byte-identical.
//
// This catches the whole nondeterminism class, not one instance of it. The bug it
// was written for: Google Fonts serves Outfit with `unicode-range`, so the faces
// load lazily on first use and `document.fonts.ready` resolves before any of them
// arrive. Render #1 measured in the fallback font and render #2 in Outfit, so the
// same diagram produced different geometry depending on when you asked. You cannot
// converge on a target that moves between measurements — every quality number in
// the suite was measured through that race.
//
// Note "on a fresh page": renders 2/3/4 always agreed. Only render #1 differed, so
// a test comparing two consecutive later renders would have passed throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { normalizeDiagramModel } from '../../src/core/optimizer.js';

const FIXTURES = [
  'test/fixtures/diagrams/core/search_service_container.mermaid',
  'test/fixtures/diagrams/core/label_crowding_parallel_rels.mermaid',
];

test('the first render of a fresh page matches the second', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (const fixture of FIXTURES) {
      const model = normalizeDiagramModel(
        parseMermaidC4(fs.readFileSync(path.resolve(fixture), 'utf8'))
      );

      // A new context and page per fixture: reusing a page would warm the font
      // cache and hide exactly the defect this test exists to catch.
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.goto(new URL('../../src/render.html', import.meta.url).href);

      const renders = [];
      for (let i = 0; i < 2; i++) {
        const result = await page.evaluate(d => window.renderDiagram(d), model);
        assert.ok(result?.success, `${fixture} failed to render: ${result?.error}`);
        renders.push({
          width: result.width,
          height: result.height,
          svg: await page.locator('#svg-root').innerHTML(),
        });
      }
      await context.close();

      const [first, second] = renders;
      const name = path.basename(fixture);
      assert.equal(first.width, second.width, `${name}: width differs between render 1 and 2`);
      assert.equal(first.height, second.height, `${name}: height differs between render 1 and 2`);
      assert.equal(first.svg, second.svg, `${name}: SVG differs between render 1 and 2`);
    }
  } finally {
    await browser.close();
  }
});
