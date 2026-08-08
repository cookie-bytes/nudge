// Readability floors for every theme.
//
// The geometric critic scores *where* things are and is blind to colour, so a
// palette nobody can read produces a flawless defect vector — there is no
// existing check a bad colour would trip. These tests are that check, and they
// read the tokens back out of src/render.html so the stylesheet stays the one
// source of truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  readThemes, report, tierReport, contrast, deltaE, parseColor, luminance,
  ALL_PAIRS, TIER_PAIRS, KNOWN_BELOW, AA_TEXT, AA_GRAPHICS,
} from '../theme_contrast.js';
import { LIGHT_THEME_SELECTOR, resolveThemes, THEME_REQUESTS } from '../../src/core/optimizer.js';

const themes = readThemes();

test('both themes declare the same token set', () => {
  // A light theme that silently omits a token inherits the dark value, which is
  // how a near-black label ends up on a near-white ground.
  const dark = Object.keys(themes.dark).sort();
  const light = Object.keys(themes.light).sort();
  assert.deepEqual(light, dark, 'light theme must define every token dark defines');
  assert.ok(dark.length >= 20, `expected a full token set, found ${dark.length}`);
});

test('the two themes are actually different palettes', () => {
  const changed = Object.keys(themes.dark).filter(k => themes.dark[k] !== themes.light[k]);
  assert.ok(changed.length > 10, `expected a distinct light palette, only ${changed.length} tokens differ`);
  // The ground is the whole point: one theme must be dark and one light.
  assert.ok(luminance(parseColor(themes.dark['--canvas'])) < 0.1, 'dark canvas must be dark');
  assert.ok(luminance(parseColor(themes.light['--canvas'])) > 0.7, 'light canvas must be light');
});

for (const name of ['dark', 'light']) {
  const tokens = themes[name];
  const known = KNOWN_BELOW[name];

  test(`${name} theme meets its contrast floors`, () => {
    const failures = [];
    for (const row of report(tokens)) {
      if (known[row.name] !== undefined) continue;
      if (row.ratio < row.floor) {
        failures.push(`${row.name}: ${row.ratio.toFixed(2)} < ${row.floor}`);
      }
    }
    assert.deepEqual(failures, [], `contrast below floor:\n  ${failures.join('\n  ')}`);
  });

  test(`${name} theme keeps its element tiers tellable apart`, () => {
    const failures = tierReport(tokens)
      .filter(row => row.distance < row.floor)
      .map(row => `${row.name}: dE ${row.distance.toFixed(1)} < ${row.floor}`);
    assert.deepEqual(failures, [], `tiers too close:\n  ${failures.join('\n  ')}`);
  });

  test(`${name} theme's known-below pairs do not get worse`, () => {
    const byName = new Map(report(tokens).map(r => [r.name, r]));
    for (const [pairName, ceiling] of Object.entries(known)) {
      const row = byName.get(pairName);
      assert.ok(row, `known-below pair "${pairName}" is no longer a checked pair — drop it from KNOWN_BELOW`);
      // Ratchet, not gate: the recorded value is a floor to hold, so a palette
      // edit cannot quietly make an already-weak pairing weaker.
      assert.ok(
        row.ratio >= ceiling - 0.01,
        `${pairName} regressed: ${row.ratio.toFixed(2)} < recorded ${ceiling}`
      );
      if (row.ratio >= row.floor) {
        assert.fail(`${pairName} now meets its floor (${row.ratio.toFixed(2)}) — remove it from KNOWN_BELOW`);
      }
    }
  });
}

test('the light theme carries no contrast exemptions', () => {
  // Dark's exemptions are inherited from a palette that predates this check.
  // The light palette was designed against it, so it has no excuse.
  assert.deepEqual(KNOWN_BELOW.light, {});
});

test('the adaptive export can still find the light palette', () => {
  // captureSvg builds the prefers-color-scheme rule by looking this selector up
  // in the CSSOM. Renaming the block in render.html would leave every adaptive
  // export silently dark-only; the exporter throws when it finds nothing, but
  // that is a slow browser test away — this catches the rename in milliseconds.
  const css = fs.readFileSync(path.resolve('src/render.html'), 'utf8');
  assert.ok(
    css.includes(LIGHT_THEME_SELECTOR),
    `render.html must declare the light palette under exactly "${LIGHT_THEME_SELECTOR}"`
  );
});

test('resolveThemes maps each accepted request to what gets rendered', () => {
  assert.deepEqual(resolveThemes(), { themes: ['dark'], adaptive: true });
  assert.deepEqual(resolveThemes('auto'), { themes: ['dark'], adaptive: true });
  assert.deepEqual(resolveThemes('dark'), { themes: ['dark'], adaptive: false });
  assert.deepEqual(resolveThemes('light'), { themes: ['light'], adaptive: false });
  assert.deepEqual(resolveThemes('both'), { themes: ['dark', 'light'], adaptive: false });
  assert.throws(() => resolveThemes('solarized'), /unknown theme/);
  // Naming a palette must pin it — an "adaptive" pinned theme would make
  // --theme dark a suggestion the viewer could override.
  for (const request of THEME_REQUESTS.filter(t => t !== 'auto')) {
    assert.equal(resolveThemes(request).adaptive, false, `${request} must not adapt`);
  }
});

// --- the measuring tools themselves ---

test('contrast matches known WCAG reference values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrast('#ffffff', '#ffffff').toFixed(2), '1.00');
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48');
});

test('contrast accounts for the opacity the text is actually drawn at', () => {
  const solid = contrast('#ffffff', '#1e3a8a', 1);
  const dimmed = contrast('#ffffff', '#1e3a8a', 0.7);
  assert.ok(dimmed < solid, 'dimmed text must score lower than solid text');
});

test('parseColor handles the notations the stylesheet uses', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#0f172a'), { r: 15, g: 23, b: 42, a: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0.3)'), { r: 0, g: 0, b: 0, a: 0.3 });
  assert.throws(() => parseColor('hotpink'), /cannot parse/);
});

test('deltaE separates colours that contrast ratio cannot', () => {
  // The exact case that made contrast ratio the wrong tool for tier checks:
  // the dark theme's focal navy and external slate score ~1.0 against each
  // other and are still obviously different colours.
  assert.ok(contrast('#1e3a8a', '#334155') < 1.1, 'premise: near-identical luminance');
  assert.ok(deltaE('#1e3a8a', '#334155') > 20, 'but perceptually far apart');
  assert.equal(deltaE('#1e3a8a', '#1e3a8a'), 0);
});

test('every checked pair names tokens that exist', () => {
  const tokenNames = [...ALL_PAIRS.flatMap(p => [p.fg, p.bg, p.opacityToken]),
                      ...TIER_PAIRS.flatMap(p => [p.a, p.b])].filter(Boolean);
  for (const name of tokenNames) {
    assert.ok(name in themes.dark, `pair references unknown token ${name}`);
  }
  // Guards against a pair list that quietly stops covering anything.
  assert.ok(ALL_PAIRS.length > 15);
  assert.ok(AA_TEXT > AA_GRAPHICS);
});
