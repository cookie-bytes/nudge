#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { fetchWithTimeout } from '../src/utils.js';
import { getActiveModel, getHeaders } from '../src/core/llm_client.js';

const DEFAULT_INPUT = 'test/content-delivery-just-in-time.mermaid';
const DEFAULT_PORT_RESPONSE = 'test_outputs/port_hint_probe/lm_response.json';
const DEFAULT_ORDER_RESPONSE = 'test_outputs/top_order_probe/lm_response.json';
const DEFAULT_OUTPUT_DIR = 'test_outputs/diagonal_route_probe';
const DEFAULT_API_URL = process.env.NUDGE_LLM_API || 'http://127.0.0.1:1234';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    portResponse: DEFAULT_PORT_RESPONSE,
    orderResponse: DEFAULT_ORDER_RESPONSE,
    outputDir: DEFAULT_OUTPUT_DIR,
    apiUrl: DEFAULT_API_URL,
    model: process.env.NUDGE_LLM_MODEL || '',
    dryRun: false,
    timeout: 60000,
    top: 5
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--port-response') args.portResponse = argv[++i];
    else if (arg === '--order-response') args.orderResponse = argv[++i];
    else if (arg === '--output-dir' || arg === '-o') args.outputDir = argv[++i];
    else if (arg === '--api-url') args.apiUrl = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--timeout') args.timeout = Number(argv[++i] || args.timeout);
    else if (arg === '--top') args.top = Number(argv[++i] || args.top);
  }
  return args;
}

function loadJsonResponse(responsePath) {
  if (!fs.existsSync(responsePath)) return {};
  const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
  if (response.parsed) return response.parsed;
  if (response.raw) {
    const jsonMatch = response.raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  }
  return response;
}

function loadPortHints(responsePath) {
  const response = loadJsonResponse(responsePath);
  const suggestions = response.suggestions || [];
  const hints = {};
  for (const suggestion of suggestions) {
    if (!suggestion.edgeId) continue;
    const hint = {};
    if (suggestion.sourceSide) hint.sourceSide = suggestion.sourceSide;
    if (suggestion.targetSide) hint.targetSide = suggestion.targetSide;
    if (Object.keys(hint).length > 0) hints[suggestion.edgeId] = hint;
  }
  return hints;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function pointsForEdge(edge) {
  const section = edge.sections?.[0];
  if (!section) return [];
  return [
    section.startPoint,
    ...(section.bendPoints || []),
    section.endPoint
  ].map(p => ({ x: round(p.x), y: round(p.y) }));
}

function routeLength(points) {
  return round(points.slice(0, -1).reduce((sum, point, index) => {
    const next = points[index + 1];
    return sum + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0));
}

function diagonalSegments(points) {
  return points.slice(0, -1)
    .map((a, index) => ({ a, b: points[index + 1] }))
    .filter(seg => Math.abs(seg.b.x - seg.a.x) > 25 && Math.abs(seg.b.y - seg.a.y) > 25)
    .map(seg => ({
      ...seg,
      length: round(Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y))
    }));
}

async function renderDiagram(diagramModel, screenshotPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 2400 } });
    const templateUrl = new URL('../src/render.html', import.meta.url).href;
    await page.goto(templateUrl);
    const graph = await page.evaluate((data) => window.renderDiagram(data), diagramModel);
    if (!graph.success) throw new Error(graph.error || 'render failed');
    await page.setViewportSize({ width: Math.ceil(graph.width) + 100, height: Math.ceil(graph.height) + 100 });
    const svgElement = await page.$('#svg-root');
    await svgElement.screenshot({ path: screenshotPath });
    return graph;
  } finally {
    await browser.close();
  }
}

function buildPayload(diagramModel, graph, topN) {
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const modelEdges = new Map(diagramModel.edges.map((edge, idx) => [`edge_${idx}`, edge]));
  const candidates = graph.edges.map(edge => {
    const modelEdge = modelEdges.get(edge.id);
    const source = nodesById.get(modelEdge.from);
    const target = nodesById.get(modelEdge.to);
    const points = pointsForEdge(edge);
    const diagonals = diagonalSegments(points);
    return {
      id: edge.id,
      source: modelEdge.from,
      sourceLabel: source?.label || modelEdge.from,
      target: modelEdge.to,
      targetLabel: target?.label || modelEdge.to,
      sourceType: source?.type || 'unknown',
      targetType: target?.type || 'unknown',
      label: modelEdge.label || '',
      routeLength: routeLength(points),
      bendCount: Math.max(0, points.length - 2),
      diagonalLength: round(diagonals.reduce((sum, seg) => sum + seg.length, 0)),
      points,
      diagonalSegments: diagonals
    };
  }).filter(edge => edge.diagonalLength >= 180)
    .sort((a, b) => b.diagonalLength - a.diagonalLength)
    .slice(0, topN);

  const nodeIds = new Set(candidates.flatMap(edge => [edge.source, edge.target]));
  const nodes = graph.nodes
    .filter(node => nodeIds.has(node.id))
    .map(node => ({
      id: node.id,
      label: node.label,
      type: node.type,
      box: { x: round(node.x), y: round(node.y), width: round(node.width), height: round(node.height) },
      center: { x: round(node.x + node.width / 2), y: round(node.y + node.height / 2) }
    }));

  return {
    title: diagramModel.title,
    startingPoint: 'ordered diagram with accepted port hint and top-row order applied',
    allowedRouteIntents: ['KEEP_DIAGONAL', 'LEFT_LANE', 'RIGHT_LANE', 'ORTHOGONAL_NEAR_TARGET'],
    nodes,
    diagonalEdges: candidates,
    instruction: 'Review only these long diagonal edges. Suggest route intents only where an orthogonal lane would likely read better.'
  };
}

function buildMessages(payload, topN) {
  const systemPrompt = `You are a JSON-only diagonal route reviewer for C4 architecture diagrams.

You receive rendered geometry from an already improved diagram. Suggest at most ${topN} route intents for long diagonal edges that could be easier to read as clear lanes.

Rules:
- Use only edge ids from diagonalEdges.
- Allowed routeIntent values: KEEP_DIAGONAL, LEFT_LANE, RIGHT_LANE, ORTHOGONAL_NEAR_TARGET.
- Prefer KEEP_DIAGONAL when a diagonal is short or semantically clear.
- Do not move nodes or labels.
- Output only valid JSON. The first character must be "{".`;

  const userPrompt = `Rendered diagonal-route payload:
${JSON.stringify(payload, null, 2)}

Return only this JSON shape:
{
  "suggestions": [
    {
      "edgeId": "edge_0",
      "routeIntent": "LEFT_LANE",
      "confidence": "medium",
      "reason": "Short reason."
    }
  ],
  "rationale": "Brief rationale."
}`;
  return [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }];
}

async function callModel(args, messages) {
  const model = args.model || await getActiveModel(args.apiUrl);
  const response = await fetchWithTimeout(`${args.apiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: 1000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'diagonal_route_review',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              suggestions: {
                type: 'array',
                maxItems: args.top,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    edgeId: { type: 'string' },
                    routeIntent: { type: 'string', enum: ['KEEP_DIAGONAL', 'LEFT_LANE', 'RIGHT_LANE', 'ORTHOGONAL_NEAR_TARGET'] },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    reason: { type: 'string' }
                  },
                  required: ['edgeId', 'routeIntent', 'confidence', 'reason']
                }
              },
              rationale: { type: 'string' }
            },
            required: ['suggestions', 'rationale']
          }
        }
      }
    }),
    timeout: args.timeout
  });
  if (!response.ok) throw new Error(`LM request failed ${response.status}: ${await response.text()}`);
  const result = await response.json();
  const text = (result.choices?.[0]?.message?.content || result.choices?.[0]?.message?.reasoning_content || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return { raw: text, parsed: jsonMatch ? JSON.parse(jsonMatch[0]) : null };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const diagramModel = parseMermaidC4(fs.readFileSync(inputPath, 'utf8'));
  const portHints = loadPortHints(path.resolve(args.portResponse));
  const order = loadJsonResponse(path.resolve(args.orderResponse));
  const graph = await renderDiagram({
    ...diagramModel,
    _layoutOverrides: {
      portHints,
      internalOrder: { [order.layerIndex || 0]: order.suggestedOrder || order.currentOrder || [] }
    }
  }, path.join(outputDir, 'render.png'));
  const payload = buildPayload(diagramModel, graph, args.top);
  const messages = buildMessages(payload, args.top);
  fs.writeFileSync(path.join(outputDir, 'diagonal_route_payload.json'), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outputDir, 'prompt_messages.json'), JSON.stringify(messages, null, 2));
  console.log(`Rendered ${inputPath}`);
  console.log(`Diagonal candidates: ${payload.diagonalEdges.map(edge => edge.id).join(', ')}`);
  console.log(`Wrote ${path.join(outputDir, 'render.png')}`);
  if (args.dryRun) {
    console.log('Dry run only. Re-run without --dry-run to call the local LM.');
    return;
  }
  const lmResult = await callModel(args, messages);
  fs.writeFileSync(path.join(outputDir, 'lm_response.json'), JSON.stringify(lmResult, null, 2));
  console.log(JSON.stringify(lmResult.parsed || { raw: lmResult.raw }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
