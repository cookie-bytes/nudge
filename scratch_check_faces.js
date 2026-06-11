import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

async function run() {
  const content = fs.readFileSync('test/fixtures/diagrams/core/search_service_container.mermaid', 'utf8');
  const model = parseMermaidC4(content);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const templatePath = new URL('./src/render.html', import.meta.url).href;
  await page.goto(templatePath);

  model._skipFaceRule = true;
  const result = await page.evaluate(async (data) => window.renderDiagram(data), model);

  const destId = 'search_lambda';
  const dest = result.nodes.find(n => n.id === destId);
  const rect = { x: dest.x, y: dest.y, w: dest.width, h: dest.height };
  console.log(`${destId} rect:`, rect);

  const classifyFace = (pt) => {
    const dTop = Math.abs(pt.y - rect.y);
    const dBottom = Math.abs(pt.y - (rect.y + rect.h));
    const dLeft = Math.abs(pt.x - rect.x);
    const dRight = Math.abs(pt.x - (rect.x + rect.w));
    const min = Math.min(dTop, dBottom, dLeft, dRight);
    if (min === dTop) return 'top';
    if (min === dBottom) return 'bottom';
    if (min === dLeft) return 'left';
    return 'right';
  };

  for (const edge of result.edges) {
    const src = edge.sources[0], tgt = edge.targets[0];
    if (src !== destId && tgt !== destId) continue;
    const section = edge.sections[0];
    const pt = src === destId ? section.startPoint : section.endPoint;
    console.log(`${src} -> ${tgt}: connection point at (${Math.round(pt.x)}, ${Math.round(pt.y)}) face=${classifyFace(pt)}`);
  }

  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
