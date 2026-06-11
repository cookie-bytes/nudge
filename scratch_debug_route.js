import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

async function run() {
  const content = fs.readFileSync('examples/auction_context.mermaid', 'utf8');
  const model = parseMermaidC4(content);

  // Replicate the CLI's synthetic-boundary wrap for context diagrams
  const actorTypes = new Set(['person', 'person_ext']);
  const actors = model.nodes.filter(n => actorTypes.has(n.type));
  const mainNodes = model.nodes.filter(n => !actorTypes.has(n.type));
  model.nodes = [...actors, {
    id: '__context_boundary',
    label: 'System Context',
    type: 'boundary',
    children: mainNodes,
    _synthetic: true
  }];

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log(`[${msg.type()}] ${msg.text()}`));
  await page.goto(new URL('./src/render.html', import.meta.url).href);
  const result = await page.evaluate(async (data) => {
    const badPoints = (route) => {
      if (!route) return 'route is null';
      const pts = [route.startPoint, ...(route.bendPoints || []), route.endPoint];
      const badIdx = pts.findIndex(p => !p || typeof p.x !== 'number' || typeof p.y !== 'number');
      return badIdx === -1 ? null : `point ${badIdx} of ${pts.length} is ${JSON.stringify(pts[badIdx])}`;
    };
    const geo = window.NudgeRenderer.routeGeometry;
    const origOrtho = geo.orthogonalizeSection;
    geo.orthogonalizeSection = (section, preferVerticalEntry) => {
      const out = origOrtho(section, preferVerticalEntry);
      const bad = badPoints(out);
      if (bad) {
        console.log(`RouteDebug ORTHO produced bad section: ${bad}; input was ${JSON.stringify(section)}`);
      }
      return out;
    };
    return window.renderDiagram(data);
  }, model);
  console.log('renderDiagram result:', JSON.stringify({ success: result?.success, error: result?.error }));
  await browser.close();
}
run().catch((e) => { console.error(e); process.exit(1); });
