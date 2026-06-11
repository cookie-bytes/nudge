import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

async function run() {
  const file = process.argv[2] || 'test/fixtures/diagrams/core/search_service_container.mermaid';
  const out = process.argv[3] || 'scratch_render.png';
  const content = fs.readFileSync(file, 'utf8');
  const model = parseMermaidC4(content);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
  page.on('pageerror', err => console.log(`[PageError] ${err.message}`));

  const templatePath = new URL('./src/render.html', import.meta.url).href;
  await page.goto(templatePath);

  const result = await page.evaluate(async (data) => {
    return await window.renderDiagram(data);
  }, model);

  await page.setViewportSize({ width: 1500, height: 1500 });
  await page.screenshot({ path: out, fullPage: true });
  console.log(`Saved ${out}`);
  await browser.close();
}

run().catch(console.error);
