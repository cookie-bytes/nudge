import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

async function run() {
  const content = fs.readFileSync('test/fixtures/diagrams/core/search_service_container.mermaid', 'utf8');
  const model = parseMermaidC4(content);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
  
  const templatePath = new URL('./src/render.html', import.meta.url).href;
  await page.goto(templatePath);

  const result = await page.evaluate(async (data) => {
    return await window.renderDiagram(data);
  }, model);

  await browser.close();
}

run().catch(console.error);
