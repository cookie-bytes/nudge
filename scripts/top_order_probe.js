#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { fetchWithTimeout } from '../src/utils.js';
import { getActiveModel, getHeaders } from '../src/core/llm_client.js';

const DEFAULT_INPUT = 'test/content-delivery-just-in-time.mermaid';
const DEFAULT_PORT_RESPONSE = 'test_outputs/port_hint_probe/lm_response.json';
const DEFAULT_OUTPUT_DIR = 'test_outputs/top_order_probe';
const DEFAULT_API_URL = process.env.NUDGE_LLM_API || 'http://127.0.0.1:1234';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    portResponse: DEFAULT_PORT_RESPONSE,
    outputDir: DEFAULT_OUTPUT_DIR,
    apiUrl: DEFAULT_API_URL,
    model: process.env.NUDGE_LLM_MODEL || '',
    dryRun: false,
    timeout: 60000
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--port-response') args.portResponse = argv[++i];
    else if (arg === '--output-dir' || arg === '-o') args.outputDir = argv[++i];
    else if (arg === '--api-url') args.apiUrl = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--timeout') args.timeout = Number(argv[++i] || args.timeout);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/top_order_probe.js [options]

Render the content-delivery diagram with accepted port hints, extract the top
internal row, and ask a local LM for a better left-to-right order.

Options:
  -i, --input <file>             Mermaid source file
                                 default: ${DEFAULT_INPUT}
      --port-response <file>     Port-hint response JSON to apply first
                                 default: ${DEFAULT_PORT_RESPONSE}
  -o, --output-dir <dir>         Output directory
                                 default: ${DEFAULT_OUTPUT_DIR}
      --api-url <url>            OpenAI-compatible API URL
                                 default: ${DEFAULT_API_URL}
      --model <name>             Model id to request
      --timeout <ms>             LM request timeout
                                 default: 60000
      --dry-run                  Render and write prompt/payload without LM call
`);
}

function loadSuggestions(responsePath) {
  if (!fs.existsSync(responsePath)) return [];
  const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
  if (Array.isArray(response.suggestions)) return response.suggestions;
  if (Array.isArray(response.parsed?.suggestions)) return response.parsed.suggestions;
  if (response.raw) {
    const jsonMatch = response.raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.suggestions)) return parsed.suggestions;
    }
  }
  return [];
}

function suggestionsToPortHints(suggestions) {
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

async function renderDiagram(diagramModel, screenshotPath) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 2400 } });
    const templateUrl = new URL('../src/render.html', import.meta.url).href;
    await page.goto(templateUrl);
    const graph = await page.evaluate((data) => window.renderDiagram(data), diagramModel);
    if (!graph.success) throw new Error(graph.error || 'render failed');
    await page.setViewportSize({
      width: Math.ceil(graph.width) + 100,
      height: Math.ceil(graph.height) + 100
    });
    const svgElement = await page.$('#svg-root');
    await svgElement.screenshot({ path: screenshotPath });
    return graph;
  } finally {
    await browser.close();
  }
}

function buildTopOrderPayload(diagramModel, graph) {
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const modelEdges = new Map(diagramModel.edges.map((edge, idx) => [`edge_${idx}`, edge]));
  const internalContainers = graph.nodes.filter(node => node.type === 'container');
  const minY = Math.min(...internalContainers.map(node => node.y));
  const topNodes = internalContainers
    .filter(node => Math.abs(node.y - minY) < 5)
    .sort((a, b) => a.x - b.x);
  const topIds = new Set(topNodes.map(node => node.id));

  const relevantEdges = graph.edges
    .map(edge => {
      const modelEdge = modelEdges.get(edge.id);
      const source = nodesById.get(modelEdge.from);
      const target = nodesById.get(modelEdge.to);
      const points = pointsForEdge(edge);
      return {
        id: edge.id,
        source: modelEdge.from,
        sourceLabel: source?.label || modelEdge.from,
        target: modelEdge.to,
        targetLabel: target?.label || modelEdge.to,
        label: modelEdge.label || '',
        points,
        bendCount: Math.max(0, points.length - 2)
      };
    })
    .filter(edge => topIds.has(edge.source) || topIds.has(edge.target));

  return {
    title: diagramModel.title,
    row: {
      layerIndex: 0,
      currentOrder: topNodes.map(node => node.id),
      nodes: topNodes.map(node => ({
        id: node.id,
        label: node.label,
        type: node.type,
        x: round(node.x),
        y: round(node.y),
        center: { x: round(node.x + node.width / 2), y: round(node.y + node.height / 2) }
      }))
    },
    connectedEdges: relevantEdges,
    instruction: 'Suggest the best left-to-right order for this top internal row. Keep the same node ids.'
  };
}

function buildMessages(payload) {
  const systemPrompt = `You are a JSON-only C4 diagram top-row ordering reviewer.

You receive rendered geometry. Suggest a better left-to-right order for the given row only.

Rules:
- Use exactly the same node ids from currentOrder.
- Do not add or remove nodes.
- Prefer orders that reduce line crossings and keep related workflow steps near their targets.
- Output only valid JSON.
- The first character of your response must be "{".`;

  const userPrompt = `Rendered top-row payload:
${JSON.stringify(payload, null, 2)}

Return only this JSON shape:
{
  "layerIndex": 0,
  "currentOrder": ["id_a", "id_b"],
  "suggestedOrder": ["id_b", "id_a"],
  "confidence": "medium",
  "reason": "Short reason."
}

If no change is useful, return the same order.`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
}

async function callModel(args, messages, currentOrder) {
  const model = args.model || await getActiveModel(args.apiUrl);
  const response = await fetchWithTimeout(`${args.apiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.1,
      max_tokens: 800,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'top_order_review',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              layerIndex: { type: 'integer' },
              currentOrder: {
                type: 'array',
                items: { type: 'string' }
              },
              suggestedOrder: {
                type: 'array',
                items: { type: 'string' }
              },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              reason: { type: 'string' }
            },
            required: ['layerIndex', 'currentOrder', 'suggestedOrder', 'confidence', 'reason']
          }
        }
      }
    }),
    timeout: args.timeout
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM request failed ${response.status}: ${text}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0];
  const text = (choice?.message?.content || choice?.message?.reasoning_content || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch
    ? JSON.parse(jsonMatch[0])
    : { layerIndex: 0, currentOrder, suggestedOrder: currentOrder, confidence: 'low', reason: 'No parseable JSON response.' };
  return { raw: text, parsed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const diagramModel = parseMermaidC4(fs.readFileSync(inputPath, 'utf8'));
  const portHints = suggestionsToPortHints(loadSuggestions(path.resolve(args.portResponse)));
  const modelWithHints = {
    ...diagramModel,
    _layoutOverrides: {
      ...(diagramModel._layoutOverrides || {}),
      portHints
    }
  };

  const graph = await renderDiagram(modelWithHints, path.join(outputDir, 'render.png'));
  const payload = buildTopOrderPayload(diagramModel, graph);
  const messages = buildMessages(payload);
  fs.writeFileSync(path.join(outputDir, 'top_order_payload.json'), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outputDir, 'prompt_messages.json'), JSON.stringify(messages, null, 2));

  console.log(`Rendered ${inputPath}`);
  console.log(`Current top order: ${payload.row.currentOrder.join(', ')}`);
  console.log(`Wrote ${path.join(outputDir, 'render.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'top_order_payload.json')}`);
  console.log(`Wrote ${path.join(outputDir, 'prompt_messages.json')}`);

  if (args.dryRun) {
    console.log('Dry run only. Re-run without --dry-run to call the local LM.');
    return;
  }

  const lmResult = await callModel(args, messages, payload.row.currentOrder);
  fs.writeFileSync(path.join(outputDir, 'lm_response.json'), JSON.stringify(lmResult, null, 2));
  console.log(`Wrote ${path.join(outputDir, 'lm_response.json')}`);
  console.log(JSON.stringify(lmResult.parsed, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
