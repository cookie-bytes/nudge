// Text measurement under plain Node — no Playwright, no canvas, no network.
//
// This file is the proof that INC-9 landed. `measureTextWidth` was the single
// function forcing the whole layout pipeline into a browser (docs/IMPROVEMENT_
// PLAN.md Appendix C: every routing, planning and label-placement module was
// already DOM-free). It now reads baked Outfit glyph metrics, so it runs here
// in milliseconds.
//
// The reference widths below were captured from Chromium's canvas
// `measureText` with Outfit fully loaded, which is the number the old
// implementation produced. Asserting against them is what makes "the pure-JS
// path agrees with the browser" a test rather than a claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/vendor/outfit_metrics.js';
import '../../src/renderer/shared/text.js';

const { measureTextWidth, wrapText, createConnectionLabel, MAX_LABEL_WIDTH } =
  globalThis.NudgeRenderer.sharedText;

// [text, fontSize, isBold, canvas width in px]
const CANVAS_REFERENCE = [
  ['Interacts with [HTTPS]', 11, false, 109.6259],
  ['Search Service', 11, false, 71.7502],
  ['Reads from', 11, false, 56.3584],
  ['API Gateway [REST]', 11, false, 99.3958],
  ['x', 11, false, 5.5412],
  ['Delivers cached content to edge PoPs', 11, false, 181.6455],
  ['Interacts with [HTTPS]', 16, false, 159.4558],
  ['Search Service', 16, false, 104.3639],
  ['Delivers cached content to edge PoPs', 16, false, 264.2116],
];

test('pure-JS metrics agree with Chromium canvas measureText to under a pixel', () => {
  for (const [text, size, bold, canvasWidth] of CANVAS_REFERENCE) {
    const measured = measureTextWidth(text, size, bold);
    // measureTextWidth returns Math.ceil, so compare against the ceiled
    // reference; the underlying agreement is far tighter than 1px.
    const expected = Math.ceil(canvasWidth);
    assert.ok(
      Math.abs(measured - expected) <= 1,
      `${JSON.stringify(text)} @${size}px: got ${measured}, canvas said ${canvasWidth} (ceil ${expected})`
    );
  }
});

test('kerning is applied, not just summed advances', () => {
  // 'AV' is a strongly kerned pair; 'nn' is not. If kerning were dropped the
  // first assertion would fail while the second still passed, so this pins the
  // thing most likely to be silently lost in a metrics rewrite.
  const kerned = measureTextWidth('AV', 100);
  const unkerned = measureTextWidth('A', 100) + measureTextWidth('V', 100);
  assert.ok(kerned < unkerned, `expected AV (${kerned}) to kern tighter than A+V (${unkerned})`);
});

test('bold is wider than regular at the same size', () => {
  assert.ok(measureTextWidth('Search Service', 11, true) > measureTextWidth('Search Service', 11, false));
});

test('width scales linearly with font size', () => {
  const at10 = measureTextWidth('Payment Gateway', 10);
  const at20 = measureTextWidth('Payment Gateway', 20);
  assert.ok(Math.abs(at20 - at10 * 2) <= 2, `${at10} @10px vs ${at20} @20px`);
});

test('an empty string measures zero', () => {
  assert.equal(measureTextWidth('', 11), 0);
});

test('unknown codepoints fall back instead of producing NaN', () => {
  // Non-Latin text is outside the baked table. It must degrade to an average
  // advance, never to NaN — a NaN width silently poisons every downstream box.
  const width = measureTextWidth('日本語のラベル', 11);
  assert.ok(Number.isFinite(width) && width > 0, `got ${width}`);
});

test('wrapText breaks lines at the max width and never mid-word', () => {
  const lines = wrapText('Delivers cached content to edge points of presence', MAX_LABEL_WIDTH, 11);
  assert.ok(lines.length > 1, 'expected the string to wrap');
  for (const line of lines) {
    assert.ok(!line.startsWith(' ') && !line.endsWith(' '), `ragged line: ${JSON.stringify(line)}`);
  }
  assert.equal(lines.join(' '), 'Delivers cached content to edge points of presence');
});

test('createConnectionLabel splits the [technology] suffix onto its own line', () => {
  const label = createConnectionLabel('Reads from [JDBC]');
  assert.equal(label.text, 'Reads from [JDBC]');
  assert.ok(label.width > 0 && label.height > 0);
  // One content line plus the bracketed technology line.
  assert.ok(label.height >= 2 * 13, `expected two lines, height was ${label.height}`);
});

test('measurement is deterministic across repeated calls', () => {
  const first = measureTextWidth('Delivers cached content to edge PoPs', 11);
  for (let i = 0; i < 100; i++) {
    assert.equal(measureTextWidth('Delivers cached content to edge PoPs', 11), first);
  }
});
