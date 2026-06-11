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

  const result = await page.evaluate(async (data) => {
    return await window.renderDiagram(data);
  }, model);

  console.log('Result:', { success: result.success, error: result.error, w: result.width, h: result.height });
  for (const n of result.nodes || []) {
    console.log(`${String(n.id).padEnd(22)} type=${String(n.type).padEnd(12)} x=${Math.round(n.x)} y=${Math.round(n.y)} w=${Math.round(n.width)} h=${Math.round(n.height)}`);
  }
  const svgBox = await page.evaluate(() => {
    const svg = document.querySelector('#svg-root');
    return { w: svg.getAttribute('width'), h: svg.getAttribute('height'), vb: svg.getAttribute('viewBox') };
  });
  console.log('SVG attrs:', svgBox);

  await browser.close();
}

run().catch(async (e) => { console.error(e); process.exit(1); });
