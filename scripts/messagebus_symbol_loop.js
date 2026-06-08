// Single-message-bus visual-match harness.
// Renders one message_bus node, then asks a local vision LLM whether the
// resulting shape matches the canonical MessageBus_Symbol.png reference.
//
// Usage:  node test/messagebus_symbol_loop.js
// Exits 0 on MATCH verdict, 1 on NO_MATCH. Prints structured feedback either way.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithTimeout } from '../src/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'test_outputs');
const RENDERED_PATH = path.join(OUTPUT_DIR, 'messagebus_only.png');
const REFERENCE_PATH = path.join(ROOT, 'test/fixtures/MessageBus_Symbol.png');
const TEMPLATE_PATH = path.join(ROOT, 'src/render.html');
const LM_STUDIO_API = process.env.NUDGE_LLM_API || 'http://127.0.0.1:1234';

// Minimal diagram: one message bus node, nothing else.
const diagramModel = {
  title: 'Message Bus Shape Test',
  diagramType: 'C4Container',
  layoutOptions: {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.padding': '[top=20,left=20,bottom=20,right=20]'
  },
  nodes: [
    {
      id: 'bus1',
      label: 'Message Bus',
      type: 'message_bus',
      description: 'Handles incoming events.',
      width: 200,
      height: 120
    }
  ],
  edges: [],
  rules: []
};

async function renderSingleBus() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${TEMPLATE_PATH}`);
    const result = await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);
    if (!result.success) throw new Error(`Render failed: ${result.error}`);

    await page.setViewportSize({
      width: Math.ceil(result.width) + 40,
      height: Math.ceil(result.height) + 40
    });
    const svgElement = await page.$('#svg-root');
    await svgElement.screenshot({ path: RENDERED_PATH, omitBackground: false });
    const svgMarkup = await page.locator('#svg-root').innerHTML();
    fs.writeFileSync(path.join(OUTPUT_DIR, 'messagebus_only.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.width} ${result.height}">${svgMarkup}</svg>`);
    return { width: result.width, height: result.height };
  } finally {
    await browser.close();
  }
}

function toDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function pickVisionModel() {
  const res = await fetchWithTimeout(`${LM_STUDIO_API}/v1/models`, { timeout: 4000 });
  const data = await res.json();
  const ids = (data.data || []).map(m => m.id);
  const preferred = process.env.NUDGE_LLM_MODEL;
  if (preferred) {
    const found = ids.find(id => id.toLowerCase().includes(preferred.toLowerCase()));
    if (found) return found;
  }
  // Prefer the larger 12b for better vision judgement, fall back to other multimodal.
  const order = [
    id => /gemma-4-12b/i.test(id),
    id => /gemma-4|gemma-3/i.test(id) && !/e4b/i.test(id),
    id => /gemma|vision|vl/i.test(id),
    id => !id.includes('embed')
  ];
  for (const pick of order) {
    const found = ids.find(pick);
    if (found) return found;
  }
  return ids[0];
}

async function compareWithLLM() {
  const model = await pickVisionModel();
  console.log(`[compare] Using model: ${model}`);

  const systemPrompt = `You are a strict visual shape critic for technical diagram symbols.
You will be shown two images:
  IMAGE A: a CANONICAL message bus symbol (the target shape).
  IMAGE B: a CANDIDATE rendering.

You are verifying that the CANDIDATE has the same core HORIZONTAL CYLINDER / TUBE / QUEUE shape as the canonical symbol so it can be used in architecture diagrams.

IGNORE ALL OF THE FOLLOWING — they do NOT affect the verdict:
- Colour, fill colour, stroke colour, gradient, opacity
- Text labels, font, or any overlay text
- Background colour or transparency
- Exact size, scale, or line thickness
- Decorative rim/disc lines inside the body
- Stroke styling (solid, dashed, etc.)

Judge ONLY the structural horizontal cylinder silhouette: LEFT, MIDDLE, RIGHT.

CRITICAL OUTPUT RULES:
- Do NOT think out loud, plan, or explain.
- Do NOT write any text before the JSON.
- Do NOT use markdown code fences.
- Your ENTIRE response must be exactly one JSON object and nothing else.

JSON schema:
{
  "verdict": "MATCH" | "NO_MATCH",
  "left":          { "ok": true|false, "note": "..." },
  "middle":        { "ok": true|false, "note": "..." },
  "right":         { "ok": true|false, "note": "..." },
  "summary": "one sentence describing the biggest shape difference, or 'matches canonical shape' if MATCH"
}

Rules for MATCH (only these three things matter):
- LEFT: there is a visible cap on the left — an ellipse/oval shape (filled or outlined, any colour).
- MIDDLE: the body has straight horizontal top and bottom sides.
- RIGHT: the right edge curves RIGHTWARD/OUTWARD (a convex curve, like the right half of an ellipse seen from the side).
If ANY of the above three structural checks is wrong, verdict = NO_MATCH. Otherwise MATCH.
Colour differences alone MUST NEVER cause a NO_MATCH.`;

  const userContent = [
    { type: 'text', text: 'IMAGE A (canonical target):' },
    { type: 'image_url', image_url: { url: toDataUrl(REFERENCE_PATH) } },
    { type: 'text', text: 'IMAGE B (candidate):' },
    { type: 'image_url', image_url: { url: toDataUrl(RENDERED_PATH) } },
    { type: 'text', text: 'Now output the JSON verdict.' }
  ];

  const res = await fetchWithTimeout(`${LM_STUDIO_API}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: 0.1,
      max_tokens: 2000
    }),
    timeout: 120000
  });

  const json = await res.json();
  const choice = json.choices && json.choices[0];
  if (!choice) {
    console.error('[compare] No choices in LLM response:', JSON.stringify(json).slice(0, 400));
    return null;
  }
  let text = (choice.message.content || '').trim();
  if (!text && choice.message.reasoning_content) text = choice.message.reasoning_content.trim();
  console.log('[compare] Raw LLM output:\n' + text.slice(0, 800));

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[compare] No JSON block in LLM response.');
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('[compare] JSON parse failure:', e.message);
    return null;
  }
}

async function main() {
  console.log('[render] Rendering single message bus to', RENDERED_PATH);
  const dims = await renderSingleBus();
  console.log(`[render] Done (${dims.width}×${dims.height}px viewport).`);

  console.log('[compare] Asking LLM to compare against', REFERENCE_PATH);
  const verdict = await compareWithLLM();
  if (!verdict) {
    console.error('[result] LLM comparison failed (no verdict).');
    process.exit(2);
  }

  console.log('\n=== VERDICT ===');
  console.log(JSON.stringify(verdict, null, 2));
  if (verdict.verdict === 'MATCH') {
    console.log('\n✅ MATCH — canonical message bus shape achieved.');
    process.exit(0);
  } else {
    console.log('\n❌ NO_MATCH — shape needs adjustment.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
