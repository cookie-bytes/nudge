import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

const file = process.argv[2] || 'test/fixtures/diagrams/core/core-banking-single-boundary.mermaid';

async function run() {
  const content = fs.readFileSync(file, 'utf8');
  const model = parseMermaidC4(content);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(new URL('./src/render.html', import.meta.url).href);
  const layout = await page.evaluate(async (data) => window.renderDiagram(data), model);
  await browser.close();

  for (const edge of layout.edges || []) {
    const s = edge.sections?.[0];
    if (!s) continue;
    const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint]
      .map(p => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' ');
    const lbl = edge.labels?.[0];
    const lblStr = lbl ? ` label "${lbl.text}" @(${lbl.x?.toFixed(0)},${lbl.y?.toFixed(0)}) ${lbl.width}x${lbl.height}` : '';
    console.log(`${edge.id} ${edge.sources?.[0]} -> ${edge.targets?.[0]}: ${pts}${lblStr}`);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
