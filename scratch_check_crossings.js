import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

const near = (p, q) => Math.abs(p.x - q.x) < 4 && Math.abs(p.y - q.y) < 4;
const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
const onSeg = (p, q, r) =>
  Math.abs(orient(p, q, r)) < 1e-6 &&
  r.x >= Math.min(p.x, q.x) - 1e-6 && r.x <= Math.max(p.x, q.x) + 1e-6 &&
  r.y >= Math.min(p.y, q.y) - 1e-6 && r.y <= Math.max(p.y, q.y) + 1e-6;

function segmentsCross(a, b, c, d) {
  if (near(a, c) || near(a, d) || near(b, c) || near(b, d)) return { cross: false };
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)))
    return { cross: true, kind: 'proper' };
  if (onSeg(a, b, c) || onSeg(a, b, d) || onSeg(c, d, a) || onSeg(c, d, b))
    return { cross: true, kind: 'T-touch' };
  return { cross: false };
}

const segs = (edge) => {
  const s = edge.sections?.[0];
  if (!s) return [];
  const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint];
  return pts.slice(0, -1).map((p, i) => ({ a: p, b: pts[i + 1] }));
};

async function run() {
  const content = fs.readFileSync('test/fixtures/diagrams/core/search_service_container.mermaid', 'utf8');
  const model = parseMermaidC4(content);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(new URL('./src/render.html', import.meta.url).href);
  const result = await page.evaluate(async (data) => window.renderDiagram(data), model);
  await browser.close();

  const name = (e) => `${e.sources[0]}->${e.targets[0]}`;
  for (let i = 0; i < result.edges.length; i++) {
    for (let j = i + 1; j < result.edges.length; j++) {
      const A = result.edges[i], B = result.edges[j];
      for (const sa of segs(A)) for (const sb of segs(B)) {
        const r = segmentsCross(sa.a, sa.b, sb.a, sb.b);
        if (r.cross) {
          console.log(`${r.kind}: [${name(A)}] seg (${Math.round(sa.a.x)},${Math.round(sa.a.y)})->(${Math.round(sa.b.x)},${Math.round(sa.b.y)})  X  [${name(B)}] seg (${Math.round(sb.a.x)},${Math.round(sb.a.y)})->(${Math.round(sb.b.x)},${Math.round(sb.b.y)})`);
        }
      }
    }
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
