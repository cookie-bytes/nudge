// `src/vendor/outfit_faces.js` is generated but committed, for the same reason
// as the metrics table: `npm ci --omit=dev` has no `@fontsource/outfit` and
// would otherwise produce an installation whose exports name a font they do not
// carry.
//
// Two things are checked here. The committed file must match its generator —
// a committed generated file that can drift is a trap. And the set of embedded
// weights must cover every weight the stylesheet can compute: an uncovered one
// is silent, because the browser simply substitutes the nearest face it has and
// the geometry was measured against Outfit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMITTED = path.join(ROOT, 'src', 'vendor', 'outfit_faces.js');
const GENERATOR = path.join(ROOT, 'scripts', 'generate_font_faces.js');
const RENDER_HTML = path.join(ROOT, 'src', 'render.html');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('the committed Outfit faces match their generator', () => {
  assert.ok(fs.existsSync(COMMITTED), `${COMMITTED} is missing — it must be committed`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-faces-'));
  const regenerated = path.join(tmp, 'outfit_faces.js');

  try {
    execFileSync(process.execPath, [GENERATOR, '--output', regenerated], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(
      `Could not regenerate the faces: ${err.stderr?.toString() || err.message}\n` +
      'This test needs devDependencies (@fontsource/outfit) installed.'
    );
  }

  assert.equal(
    sha256(fs.readFileSync(COMMITTED)),
    sha256(fs.readFileSync(regenerated)),
    'The committed faces have drifted from the generator. Run: node scripts/generate_font_faces.js'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('every weight the stylesheet can compute has an embedded face', async () => {
  await import('../../src/vendor/outfit_faces.js');
  const faces = globalThis.NudgeOutfitFaces;
  assert.ok(faces, 'outfit_faces.js did not define globalThis.NudgeOutfitFaces');

  const embedded = new Set(
    [...faces.matchAll(/font-weight:(\d+)/g)].map(m => Number(m[1]))
  );

  // `bold` and `normal` are the keyword spellings of 700 and 400. An element
  // with no `font-weight` at all inherits the initial value, 400, which is why
  // 400 is required whether or not it is ever written down.
  const KEYWORDS = { bold: 700, normal: 400, bolder: 700, lighter: 100 };
  const html = fs.readFileSync(RENDER_HTML, 'utf8');
  const stylesheet = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const declared = new Set([400]);
  for (const [, value] of stylesheet.matchAll(/font-weight:\s*([a-z0-9]+)/g)) {
    declared.add(KEYWORDS[value] ?? Number(value));
  }

  for (const weight of declared) {
    assert.ok(
      embedded.has(weight),
      `render.html renders text at weight ${weight} but no such face is embedded. ` +
      'Add it to WEIGHTS in scripts/generate_font_faces.js and regenerate.'
    );
  }
});

test('the embedded faces survive inlining into an XML stylesheet', async () => {
  await import('../../src/vendor/outfit_faces.js');
  const faces = globalThis.NudgeOutfitFaces;

  // `captureSvg` drops the generated text straight into a <style> element that
  // is parsed as XML, and strips CSS comments with a regex on the way. Each of
  // these characters has already broken an export once; base64 cannot produce
  // any of them, so this is here to catch a future change of encoding or an
  // added comment rather than today's output.
  for (const char of ['<', '>', '&', '/*', ']]>']) {
    assert.ok(
      !faces.includes(char),
      `The faces contain ${JSON.stringify(char)}, which does not survive XML inlining`
    );
  }
});
