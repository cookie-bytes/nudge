#!/usr/bin/env node
// Renders one diagram twice on a freshly-navigated page and reports whether the
// two renders agree. Call #1 is the one that used to differ: Outfit's faces load
// lazily, so before the explicit `document.fonts.load()` pass in render_engine.js
// the first render measured in the fallback font and every later one in Outfit.
//
//   node scripts/determinism_check.js [path/to/diagram]
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../src/plantuml_parser.js';
import { normalizeDiagramModel } from '../src/core/optimizer.js';
import yaml from 'js-yaml';

const file = process.argv[2] || 'examples/search_service_container.mermaid';
const source = fs.readFileSync(file, 'utf8');
const ext = path.extname(file);
const parsed =
  ext === '.yaml' || ext === '.yml' ? yaml.load(source)
  : /@startuml/.test(source) ? parsePlantUMLC4(source)
  : parseMermaidC4(source);
const model = normalizeDiagramModel(parsed);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(new URL('../src/render.html', import.meta.url).href);

  const renders = [];
  for (let i = 0; i < 2; i++) {
    const result = await page.evaluate(d => window.renderDiagram(d), model);
    const svg = await page.locator('#svg-root').innerHTML();
    renders.push({ width: result.width, height: result.height, svg });
  }

  const [a, b] = renders;
  const same = a.width === b.width && a.height === b.height && a.svg === b.svg;
  console.log(`${path.basename(file)}`);
  console.log(`  render 1: ${a.width}x${a.height}  (${a.svg.length} chars)`);
  console.log(`  render 2: ${b.width}x${b.height}  (${b.svg.length} chars)`);
  console.log(same ? '  ✅ deterministic' : '  ❌ renders differ');
  if (!same) process.exitCode = 1;
} finally {
  await browser.close();
}
