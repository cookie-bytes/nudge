#!/usr/bin/env node
// Bakes Outfit's glyph metrics into a plain-JS table at install time.
//
// Why this exists (docs/IMPROVEMENT_PLAN.md INC-9): text measurement was the
// last thing in the layout pipeline that needed a browser. `measureTextWidth`
// used canvas `measureText`, which meant every layout, routing and label
// decision was computed inside Chromium, against a webfont fetched over the
// network at render time. That made the layout core untestable without
// Playwright and non-deterministic whenever the font had not arrived yet.
//
// Glyph advances are exact integers in font units, so summing them and scaling
// by `fontSize / unitsPerEm` reproduces what the browser does — no rasterizer
// involved. Kerning is not optional: it accounts for ~1.2% of a typical label's
// width, several pixels on a long one.
//
// Output: src/vendor/outfit_metrics.js, alongside the vendored elkjs bundle.
// Run automatically by `postinstall`.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'src', 'vendor', 'outfit_metrics.js');

// `--output <path>` writes elsewhere, which is how the drift test regenerates
// into a temp dir and compares without touching the committed table.
function parseOutput(argv) {
  const i = argv.indexOf('--output');
  if (i === -1) return DEFAULT_OUT;
  const value = argv[i + 1];
  if (!value) {
    console.error('--output requires a path.');
    process.exit(1);
  }
  return path.resolve(value);
}
const OUT = parseOutput(process.argv.slice(2));

// `fontkit` and `@fontsource/outfit` are devDependencies, so they are absent
// under `npm ci --omit=dev`. The generated table is committed and its output is
// byte-deterministic, so an install without the dev tooling is fine: stand down
// and use the committed table rather than failing the install.
//
// Imported dynamically for exactly this reason — a static import would throw at
// module load, before any of this could run.
let fontkit;
try {
  fontkit = await import('fontkit');
} catch {
  if (fs.existsSync(DEFAULT_OUT)) {
    console.log('Outfit metrics: fontkit not installed (--omit=dev?); using the committed table.');
    process.exit(0);
  }
  console.error(
    `Cannot generate ${path.relative(ROOT, DEFAULT_OUT)}: fontkit is not installed and no committed ` +
    `table was found. Run a full \`npm install\` (without --omit=dev).`
  );
  process.exit(1);
}

// `measureTextWidth` asks canvas for `normal` or `bold`, which resolve to
// weights 400 and 700. Those are the only two faces any measurement uses.
const WEIGHTS = [400, 700];

function fontPath(weight) {
  return path.join(ROOT, 'node_modules', '@fontsource', 'outfit', 'files', `outfit-latin-${weight}-normal.woff`);
}

function buildWeight(weight) {
  const font = fontkit.openSync(fontPath(weight));

  // Latin plus punctuation. Above U+2100 is symbol territory the corpus never
  // uses, and every excluded codepoint falls back to the average advance.
  const codePoints = font.characterSet.filter(cp => cp >= 32 && cp < 0x2100).sort((a, b) => a - b);

  const advances = {};
  for (const cp of codePoints) {
    advances[cp] = font.glyphForCodePoint(cp).advanceWidth;
  }

  // Kern pairs, discovered by laying out each ordered pair and diffing against
  // the sum of its two advances. Slower than reading GPOS directly, but it
  // captures whatever shaping fontkit actually applies rather than our guess
  // at it — which is the number the browser would produce too.
  const kern = {};
  let pairs = 0;
  for (const a of codePoints) {
    const advA = advances[a];
    const chA = String.fromCodePoint(a);
    for (const b of codePoints) {
      const laid = font.layout(chA + String.fromCodePoint(b)).advanceWidth;
      const delta = laid - (advA + advances[b]);
      if (delta !== 0) {
        kern[`${a},${b}`] = delta;
        pairs++;
      }
    }
  }

  // Fallback for any codepoint outside the table (non-Latin labels, emoji).
  const values = Object.values(advances);
  const fallback = Math.round(values.reduce((s, v) => s + v, 0) / values.length);

  console.log(`  weight ${weight}: ${codePoints.length} glyphs, ${pairs} kern pairs, fallback advance ${fallback}`);
  return { unitsPerEm: font.unitsPerEm, advances, kern, fallback };
}

// Same reasoning as the fontkit check above: the font package is a
// devDependency, so its absence is not an error when the table already exists.
if (!WEIGHTS.every(w => fs.existsSync(fontPath(w)))) {
  if (fs.existsSync(DEFAULT_OUT)) {
    console.log('Outfit metrics: @fontsource/outfit not installed; using the committed table.');
    process.exit(0);
  }
  console.error(
    `Cannot generate ${path.relative(ROOT, DEFAULT_OUT)}: @fontsource/outfit is not installed and no ` +
    `committed table was found. Run a full \`npm install\` (without --omit=dev).`
  );
  process.exit(1);
}

console.log('Generating Outfit metrics table...');
const weights = {};
for (const weight of WEIGHTS) {
  weights[weight] = buildWeight(weight);
}

const unitsPerEm = weights[WEIGHTS[0]].unitsPerEm;
if (WEIGHTS.some(w => weights[w].unitsPerEm !== unitsPerEm)) {
  throw new Error('Outfit weights disagree on unitsPerEm; the table assumes a single value.');
}

// A plain script, not a module: render.html loads it with a <script> tag and
// Node imports it for its side effect, exactly like the elkjs bundle.
const banner = `// GENERATED by scripts/generate_font_metrics.js — do not edit.
// Outfit glyph metrics (SIL Open Font License 1.1), baked so text measurement
// needs neither a canvas nor a network fetch. See docs/IMPROVEMENT_PLAN.md INC-9.
`;
const body = `globalThis.NudgeOutfitMetrics = ${JSON.stringify({ unitsPerEm, weights })};\n`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, banner + body);
console.log(`Wrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} kB)`);
