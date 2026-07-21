// `src/vendor/outfit_metrics.js` is generated but committed, because
// `npm ci --omit=dev` has neither fontkit nor the font package and would
// otherwise produce an installation that cannot measure text.
//
// A committed generated file that can drift from its generator is a trap: the
// table would silently disagree with the font, and every layout measurement
// downstream would be wrong in a way no other test could attribute. Generation
// is byte-deterministic and takes ~0.5s, so just regenerate and compare.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMITTED = path.join(ROOT, 'src', 'vendor', 'outfit_metrics.js');
const GENERATOR = path.join(ROOT, 'scripts', 'generate_font_metrics.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('the committed Outfit metrics table matches its generator', () => {
  assert.ok(fs.existsSync(COMMITTED), `${COMMITTED} is missing — it must be committed`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-metrics-'));
  const regenerated = path.join(tmp, 'outfit_metrics.js');

  try {
    execFileSync(process.execPath, [GENERATOR, '--output', regenerated], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(
      `Could not regenerate the metrics table: ${err.stderr?.toString() || err.message}\n` +
      'This test needs devDependencies (fontkit, @fontsource/outfit) installed.'
    );
  }

  assert.equal(
    sha256(fs.readFileSync(COMMITTED)),
    sha256(fs.readFileSync(regenerated)),
    'The committed table has drifted from the generator. Run: node scripts/generate_font_metrics.js'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});
