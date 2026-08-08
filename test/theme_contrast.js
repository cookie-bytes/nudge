// Contrast tooling for the theme token blocks in src/render.html.
//
// render.html stays the single source of truth for colour: this reads the
// `:root` blocks back out rather than keeping a duplicate palette in JS that
// could drift from what actually renders.
//
// Why this exists: the geometric critic scores *where* things are, and cannot
// see colour at all. A palette that renders every element in a shade nobody can
// read against its own background produces a flawless defect vector. A second
// palette makes that failure mode reachable by editing one hex digit, so the
// readability floor needs to be a checked invariant and not a review habit.

import fs from 'fs';
import path from 'path';

const RENDER_HTML = path.resolve('src/render.html');

/** WCAG 2.1 AA floors. */
export const AA_TEXT = 4.5;        // body text
export const AA_LARGE_TEXT = 3.0;  // >=18px, or >=14px bold
export const AA_GRAPHICS = 3.0;    // meaningful non-text (lines, borders)

/**
 * Parse the theme token blocks out of render.html.
 *
 * Returns { dark: {token: value}, light: {token: value} } with the light theme
 * resolved over the dark one, mirroring the CSS cascade: `:root` declares the
 * dark palette and `:root[data-theme="light"]` overrides part of it, so a token
 * the light block omits genuinely renders with the dark value.
 */
export function readThemes(file = RENDER_HTML) {
  const css = fs.readFileSync(file, 'utf8');

  const block = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
    if (!match) throw new Error(`readThemes: no ${selector} block found in ${file}`);
    const tokens = {};
    for (const [, name, value] of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
    return tokens;
  };

  const dark = block(':root');
  const light = { ...dark, ...block(':root[data-theme="light"]') };
  return { dark, light };
}

/** #rgb / #rrggbb / rgba(r,g,b,a) -> {r, g, b, a} in 0-255 / 0-1. */
export function parseColor(value) {
  const v = String(value).trim();

  const rgba = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (rgba) {
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: rgba[4] === undefined ? 1 : +rgba[4] };
  }

  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }

  throw new Error(`parseColor: cannot parse ${JSON.stringify(value)}`);
}

/** Composite a possibly-translucent foreground over an opaque background. */
export function composite(fg, bg, extraAlpha = 1) {
  const a = fg.a * extraAlpha;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Contrast ratio of `fg` against `bg`. `opacity` models the CSS opacity applied
 * to the element drawing `fg` (the type and description lines are dimmed, and a
 * dimmed line is what the reader actually has to read).
 */
export function contrast(fgValue, bgValue, opacity = 1) {
  const bg = parseColor(bgValue);
  const fg = composite(parseColor(fgValue), bg, opacity);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L*a*b*, for perceptual comparisons contrast ratio cannot make. */
export function toLab(value) {
  const { r, g, b } = parseColor(value);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  // sRGB -> XYZ (D65), normalised to the D65 white point.
  let X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  let Y = (0.2126 * R + 0.7152 * G + 0.0722 * B);
  let Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [X, Y, Z] = [f(X), f(Y), f(Z)];
  return { L: 116 * Y - 16, a: 500 * (X - Y), b: 200 * (Y - Z) };
}

/**
 * Perceptual distance (CIE76) between two colours.
 *
 * The three element tiers must be *tellable apart*, which contrast ratio cannot
 * measure: it is luminance-only, so the dark theme's navy focal fill and slate
 * external fill score 1.00 against each other despite being obviously different
 * colours. Distinguishability is a hue-and-chroma question, so it needs a
 * perceptual metric. Roughly: 2.3 is the just-noticeable difference, and
 * double figures is "different at a glance across a diagram".
 */
export function deltaE(aValue, bValue) {
  const a = toLab(aValue);
  const b = toLab(bValue);
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

/**
 * Every foreground/background pairing the renderer actually produces.
 *
 * Kept as data so both themes are checked against an identical list — a light
 * palette that forgets one surface fails here rather than in someone's eyes.
 * `on` names the token the text sits on; element text sits on the element fill,
 * and connection labels sit on a mask filled with the canvas colour.
 */
export const TEXT_PAIRS = [
  // Element text, on each of the four element fills. The three tiers plus
  // person are the whole element palette; database and message-bus bodies reuse
  // the focal fill.
  ...['--focal-fill', '--supporting-fill', '--external-fill', '--person-fill'].flatMap(bg => [
    { name: `element title on ${bg}`, fg: '--on-element', bg, opacity: 1, floor: AA_LARGE_TEXT },
    { name: `element description on ${bg}`, fg: '--on-element', bg, opacity: 0.85, floor: AA_TEXT },
    { name: `element type label on ${bg}`, fg: '--on-element', bg, opacity: 0.7, floor: AA_TEXT },
  ]),

  { name: 'connection label on its mask', fg: '--label-text', bg: '--canvas', opacity: 1, floor: AA_TEXT },
  { name: 'diagram title on canvas', fg: '--title-text', bg: '--canvas', opacity: 1, floor: AA_LARGE_TEXT },
  { name: 'boundary label on canvas', fg: '--boundary-label', bg: '--canvas', opacity: 1, floor: AA_TEXT },
  { name: 'legend label on panel', fg: '--panel-label', bg: '--panel-fill', opacity: 1, floor: AA_TEXT },
  { name: 'note text on note', fg: '--note-ink', bg: '--note-fill', opacity: 1, floor: AA_TEXT },
];

/**
 * Non-text pairings. These carry meaning — a connection line the reader cannot
 * see is a lost relationship — so they get the WCAG graphics floor.
 */
export const GRAPHIC_PAIRS = [
  { name: 'connection line on canvas', fg: '--line', bg: '--canvas', opacity: 1, floor: AA_GRAPHICS },
  { name: 'boundary border on canvas', fg: '--boundary-stroke', bg: '--canvas', opacityToken: '--boundary-stroke-opacity', floor: AA_GRAPHICS },
  { name: 'note border on canvas', fg: '--note-stroke', bg: '--canvas', opacity: 1, floor: AA_GRAPHICS },

  // Element borders read against the ground, not against their own fill: they
  // are what separates a box from the canvas behind it.
  { name: 'focal border on canvas', fg: '--focal-stroke', bg: '--canvas', opacity: 1, floor: AA_GRAPHICS },
  { name: 'supporting border on canvas', fg: '--supporting-stroke', bg: '--canvas', opacity: 1, floor: AA_GRAPHICS },
  { name: 'external border on canvas', fg: '--external-stroke', bg: '--canvas', opacity: 1, floor: AA_GRAPHICS },
  { name: 'person border on canvas', fg: '--person-accent', bg: '--canvas', opacity: 1, floor: AA_GRAPHICS },
];

/**
 * Purely decorative surfaces, deliberately ungated.
 *
 * The legend panel's fill and hairline edge lift it off the canvas; the legend
 * is fully readable without either, and holding them to the meaningful-graphics
 * floor would force a heavy box around what is meant to be quiet chrome. Listed
 * rather than omitted so the exemption is a decision on the record.
 */
export const DECORATIVE_PAIRS = [
  { name: 'legend panel edge on canvas', fg: '--panel-stroke', bg: '--canvas', opacity: 1 },
  { name: 'legend panel fill on canvas', fg: '--panel-fill', bg: '--canvas', opacity: 1 },
];

/**
 * The three element tiers must be tellable apart from each other, not merely
 * from the ground — that separation carries the diagram's in-scope /
 * supporting / external semantics. Measured perceptually; see `deltaE`.
 */
export const TIER_PAIRS = [
  { name: 'focal vs supporting fill', a: '--focal-fill', b: '--supporting-fill', floor: 12 },
  { name: 'supporting vs external fill', a: '--supporting-fill', b: '--external-fill', floor: 12 },
  { name: 'focal vs external fill', a: '--focal-fill', b: '--external-fill', floor: 12 },
  { name: 'person vs focal fill', a: '--person-fill', b: '--focal-fill', floor: 12 },
];

export const ALL_PAIRS = [...TEXT_PAIRS, ...GRAPHIC_PAIRS];

/**
 * Pairs the dark theme has never met, recorded with the ratio it currently
 * achieves so they are held flat rather than gated — the same bargain the
 * quality ratchet strikes for layout defects, and for the same reason: an
 * absolute gate over a corpus with known faults is permanently red and stops
 * meaning anything.
 *
 * Both entries are white element text dimmed by CSS opacity over the dark
 * theme's Sky 600 person fill, which is markedly lighter than the blue and
 * slate fills the same text sits on elsewhere. Fixing it means darkening the
 * person colour, which changes the established look of every diagram Nudge has
 * ever produced — a product decision, not a drive-by.
 *
 * The light theme is new, so it carries no exemptions and must pass outright.
 */
export const KNOWN_BELOW = {
  dark: {
    'element type label on --person-fill': 2.67,
    'element description on --person-fill': 3.25,
  },
  light: {},
};

/** Score every contrast pair for one theme. */
export function report(tokens, pairs = ALL_PAIRS) {
  return pairs.map(pair => {
    const opacity = pair.opacityToken
      ? Number(tokens[pair.opacityToken])
      : pair.opacity;
    return { ...pair, opacity, ratio: contrast(tokens[pair.fg], tokens[pair.bg], opacity) };
  });
}

/** Score every tier-separation pair for one theme. */
export function tierReport(tokens, pairs = TIER_PAIRS) {
  return pairs.map(pair => ({ ...pair, distance: deltaE(tokens[pair.a], tokens[pair.b]) }));
}
