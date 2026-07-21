#!/usr/bin/env node
// Renders the given fixtures at two git states and writes a side-by-side HTML
// report, so a layout change can be judged by eye rather than only by counters.
//
//   node scripts/compare_renders.js --ref HEAD [fixture ...]
//
// The "before" lane re-renders using the renderer sources from --ref; the
// "after" lane uses the working tree. Defaults to the fixtures INC-16 changed.

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../src/plantuml_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';
import { normalizeDiagramModel } from '../src/core/optimizer.js';
import { qualityVector, RATCHET_METRICS } from '../test/quality_baseline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test_outputs', 'comparison');

const DEFAULTS = [
  'core/library_context.mermaid',
  'refactor/multi_boundary_cross_parent_routes.mermaid',
  'refactor/nested_boundary_characterization.mermaid',
];

const argv = process.argv.slice(2);
let ref = 'HEAD';
const fixtures = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ref') ref = argv[++i];
  else fixtures.push(argv[i]);
}
const targets = fixtures.length ? fixtures : DEFAULTS;

// Materialise the renderer from `ref` into a temp tree. Only the browser-side
// sources matter — the Node side is imported from the working tree either way.
function materializeBefore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-before-'));
  const tar = path.join(dir, 'src.tar');
  execFileSync('git', ['-C', ROOT, 'archive', '--format=tar', '-o', tar, ref, 'src'], { stdio: 'inherit' });
  execFileSync('tar', ['-xf', tar, '-C', dir]);
  // The elk bundle and metrics table are gitignored, so copy them across.
  fs.mkdirSync(path.join(dir, 'src', 'vendor'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'vendor'))) {
    fs.copyFileSync(path.join(ROOT, 'src', 'vendor', f), path.join(dir, 'src', 'vendor', f));
  }
  return path.join(dir, 'src', 'render.html');
}

async function renderAll(renderHtml, page) {
  await page.goto(new URL(`file://${renderHtml}`).href);
  const out = {};
  for (const key of targets) {
    const full = path.join(ROOT, 'test', 'fixtures', 'diagrams', key);
    const source = fs.readFileSync(full, 'utf8');
    const model = normalizeDiagramModel(
      key.endsWith('.puml') ? parsePlantUMLC4(source) : parseMermaidC4(source)
    );
    const result = await page.evaluate(d => window.renderDiagram(d), model);
    if (!result?.success) { out[key] = { error: result?.error }; continue; }
    const [markup, styles] = await Promise.all([
      page.locator('#svg-root').innerHTML(),
      page.evaluate(() => document.querySelector('head style')?.textContent ?? ''),
    ]);
    out[key] = {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.width} ${result.height}"><style>${styles}</style>${markup}</svg>`,
      vector: qualityVector(model, result, analyzeLayout(result)),
      warnings: result.warnings ?? [],
    };
  }
  return out;
}

const beforeHtml = materializeBefore();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
let before, after;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  before = await renderAll(beforeHtml, await context.newPage());
  after = await renderAll(path.join(ROOT, 'src', 'render.html'), await context.newPage());
} finally {
  await browser.close();
}

fs.mkdirSync(OUT, { recursive: true });
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

let html = `<!doctype html><meta charset="utf-8"><title>Nudge render comparison</title>
<style>
 :root{color-scheme:light dark}
 body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:Canvas;color:CanvasText}
 h1{font-size:20px} h2{font-size:16px;margin:32px 0 4px;border-top:1px solid #8884;padding-top:20px}
 .row{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
 .pane{border:1px solid #8884;border-radius:8px;padding:10px;overflow:auto;background:#0b1220}
 .pane h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8}
 .pane svg{width:100%;height:auto;display:block}
 table{border-collapse:collapse;margin:10px 0;font-size:13px}
 td,th{border:1px solid #8884;padding:3px 8px;text-align:right} th:first-child,td:first-child{text-align:left}
 .worse{color:#dc2626;font-weight:600} .better{color:#16a34a;font-weight:600}
 .warn{background:#78350f22;border-left:3px solid #f59e0b;padding:6px 10px;margin:6px 0;font-size:13px}
</style>
<h1>Nudge render comparison</h1>
<p>Left: <code>${esc(ref)}</code>. Right: working tree.</p>`;

for (const key of targets) {
  const b = before[key] || {};
  const a = after[key] || {};
  html += `<h2>${esc(key)}</h2>`;
  if (b.vector && a.vector) {
    const changed = RATCHET_METRICS.filter(m => (b.vector[m] || 0) !== (a.vector[m] || 0));
    if (changed.length) {
      html += `<table><tr><th>Metric</th><th>Before</th><th>After</th></tr>` +
        changed.map(m => {
          const bv = b.vector[m] || 0, av = a.vector[m] || 0;
          return `<tr><td>${m}</td><td>${bv}</td><td class="${av > bv ? 'worse' : 'better'}">${av}</td></tr>`;
        }).join('') + `</table>`;
    } else {
      html += `<p>No change in any ratcheted metric.</p>`;
    }
  }
  for (const w of a.warnings || []) html += `<div class="warn">⚠ ${esc(w)}</div>`;
  html += `<div class="row">
   <div class="pane"><h3>Before — ${esc(ref)}</h3>${b.svg || `<p>${esc(b.error || 'no render')}</p>`}</div>
   <div class="pane"><h3>After — working tree</h3>${a.svg || `<p>${esc(a.error || 'no render')}</p>`}</div>
  </div>`;
}

const dest = path.join(OUT, 'index.html');
fs.writeFileSync(dest, html);
console.log(`Wrote ${path.relative(ROOT, dest)}`);
console.log(`Open with: open ${dest}`);
