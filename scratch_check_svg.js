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

  await page.evaluate(async (data) => window.renderDiagram(data), model);

  const info = await page.evaluate(() => {
    const svg = document.querySelector('#svg-root');
    const shapes = [...svg.querySelectorAll('.node, .boundary')];
    const boxes = shapes.map(el => {
      const b = el.getBoundingClientRect();
      const title = el.closest('g')?.querySelector('.node-title')?.textContent
        || el.parentElement?.querySelector('foreignObject div.node-title')?.textContent;
      return {
        tag: el.tagName, cls: el.getAttribute('class'),
        x: Math.round(el.getAttribute('x') ?? b.x), y: Math.round(el.getAttribute('y') ?? b.y),
        domX: Math.round(b.x), domY: Math.round(b.y), domW: Math.round(b.width), domH: Math.round(b.height),
        title: title?.slice(0, 28)
      };
    });
    const titles = [...svg.querySelectorAll('.node-title')].map(t => t.textContent);
    return { shapeCount: shapes.length, boxes, titles };
  });
  console.log(JSON.stringify(info, null, 2));

  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
