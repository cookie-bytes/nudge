import fs from 'fs';
import { chromium } from 'playwright';
import { parseMermaidC4 } from './src/mermaid_parser.js';

const file = process.argv[2] || 'test/fixtures/diagrams/core/core-banking-single-boundary.mermaid';

function getEdgePoints(edge) {
  if (!edge.sections || edge.sections.length === 0) return [];
  const s = edge.sections[0];
  return [
    { x: s.startPoint.x, y: s.startPoint.y },
    ...(s.bendPoints || []).map(p => ({ x: p.x, y: p.y })),
    { x: s.endPoint.x, y: s.endPoint.y }
  ];
}

function getEdgeSegments(edge) {
  const points = getEdgePoints(edge);
  return points.slice(0, -1).map((p, i) => ({ edgeId: edge.id, a: p, b: points[i + 1] }))
    .filter(seg => Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) > 0.5);
}

function segmentIntersectsBox(p1, p2, box) {
  const { x: rx, y: ry, width: rw, height: rh } = box;
  function cross(a1, a2, b1, b2) {
    const det = (a2.x - a1.x) * (b2.y - b1.y) - (b2.x - b1.x) * (a2.y - a1.y);
    if (det === 0) return false;
    const lambda = ((b2.y - b1.y) * (b2.x - a1.x) + (b1.x - b2.x) * (b2.y - a1.y)) / det;
    const gamma = ((a1.y - a2.y) * (b2.x - a1.x) + (a2.x - a1.x) * (b2.y - a1.y)) / det;
    return (0 <= lambda && lambda <= 1) && (0 <= gamma && gamma <= 1);
  }
  if (p1.x >= rx && p1.x <= rx + rw && p1.y >= ry && p1.y <= ry + rh) return true;
  if (p2.x >= rx && p2.x <= rx + rw && p2.y >= ry && p2.y <= ry + rh) return true;
  const tl = { x: rx, y: ry }, tr = { x: rx + rw, y: ry }, bl = { x: rx, y: ry + rh }, br = { x: rx + rw, y: ry + rh };
  return cross(p1, p2, tl, tr) || cross(p1, p2, tr, br) || cross(p1, p2, br, bl) || cross(p1, p2, bl, tl);
}

async function run() {
  const content = fs.readFileSync(file, 'utf8');
  const model = parseMermaidC4(content);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(new URL('./src/render.html', import.meta.url).href);
  const layout = await page.evaluate(async (data) => window.renderDiagram(data), model);
  await browser.close();

  const edges = layout.edges || [];
  const H_PAD = 10, V_PAD = 3;
  let total = 0;
  for (const edge of edges) {
    const label = edge.labels?.[0];
    if (!label || !Number.isFinite(label.x) || !Number.isFinite(label.y)) continue;
    const box = {
      x: label.x - label.width / 2 - H_PAD,
      y: label.y - label.height / 2 - V_PAD,
      width: label.width + 2 * H_PAD,
      height: label.height + 2 * V_PAD
    };
    for (const other of edges) {
      if (other.id === edge.id) continue;
      const hitSegs = getEdgeSegments(other).filter(seg => segmentIntersectsBox(seg.a, seg.b, box));
      if (hitSegs.length > 0) {
        total++;
        console.log(`LABEL "${label.text}" (edge ${edge.id}) box=(${box.x.toFixed(0)},${box.y.toFixed(0)},${box.width.toFixed(0)}x${box.height.toFixed(0)})`);
        console.log(`   hit by edge ${other.id} "${other.labels?.[0]?.text || ''}" segs: ${hitSegs.map(s => `(${s.a.x.toFixed(0)},${s.a.y.toFixed(0)})->(${s.b.x.toFixed(0)},${s.b.y.toFixed(0)})`).join(' ')}`);
        break; // geometry.js breaks after first hit per label
      }
    }
  }
  console.log(`TOTAL label/edge intersections: ${total}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
