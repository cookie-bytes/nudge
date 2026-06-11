import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

async function run() {
  const content = fs.readFileSync('test/fixtures/diagrams/core/search_service_container.mermaid', 'utf8');
  const model = parseMermaidC4(content);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => { const t = msg.text(); if (t.includes('RouteDebug') || t.includes('Shifted')) console.log(t); });
  await page.goto(new URL('./src/render.html', import.meta.url).href);
  await page.evaluate(async (data) => {
    window.__nudgeDebugRoute = 'aws_eventbridge->partner_sync_lambda';
    return window.renderDiagram(data);
  }, model);
  await browser.close();
}
run().catch((e) => { console.error(e); process.exit(1); });
