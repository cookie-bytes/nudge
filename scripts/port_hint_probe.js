#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { fetchWithTimeout } from '../src/utils.js';
import { getActiveModel, getHeaders } from '../src/core/llm_client.js';

const DEFAULT_INPUT = 'test/content-delivery-just-in-time.mermaid';
const DEFAULT_OUTPUT_DIR = 'test_outputs/port_hint_probe';
const DEFAULT_API_URL = process.env.NUDGE_LLM_API || 'http://127.0.0.1:1234';

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    apiUrl: DEFAULT_API_URL,
    model: process.env.NUDGE_LLM_MODEL || '',
    dryRun: false,
    top: 3,
    timeout: 60000
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--input' || arg === '-i') args.input = argv[++i];
    else if (arg === '--output-dir' || arg === '-o') args.outputDir = argv[++i];
    else if (arg === '--api-url') args.apiUrl = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--top') args.top = Number(argv[++i] || args.top);
    else if (arg === '--timeout') args.timeout = Number(argv[++i] || args.timeout);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/port_hint_probe.js [options]

Render a Mermaid C4 diagram, extract route geometry, and ask a local LM for
the top port entry/exit hint suggestions.

Options:
  -i, --input <file>       Mermaid source file
                           default: ${DEFAULT_INPUT}
  -o, --output-dir <dir>   Directory for payload, prompt, screenshot, result
                           default: ${DEFAULT_OUTPUT_DIR}
      --api-url <url>      OpenAI-compatible API URL
                           default: ${DEFAULT_API_URL}
      --model <name>       Model id to request. If omitted, resolves via /v1/models.
      --top <n>            Number of requested suggestions
                           default: 3
      --timeout <ms>       LM request timeout
                           default: 60000
      --dry-run            Render and write prompt/payload without calling LM
`);
}

function pointsForSection(section) {
  return [
    section.startPoint,
    ...(section.bendPoints || []),
    section.endPoint
  ].map(p => ({ x: round(p.x), y: round(p.y) }));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function pointSide(point, node) {
  if (!point || !node) return 'UNKNOWN';
  const distances = [
    ['LEFT', Math.abs(point.x - node.x)],
    ['RIGHT', Math.abs(point.x - (node.x + node.width))],
    ['TOP', Math.abs(point.y - node.y)],
    ['BOTTOM', Math.abs(point.y - (node.y + node.height))]
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

function nodeCenter(node) {
  return {
    x: round(node.x + node.width / 2),
    y: round(node.y + node.height / 2)
  };
}

function segments(points) {
  return points.slice(0, -1).map((a, i) => ({ a, b: points[i + 1] }));
}

function near(a, b, tolerance = 2) {
  return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a, b, p) {
  return (
    p.x >= Math.min(a.x, b.x) - 1 &&
    p.x <= Math.max(a.x, b.x) + 1 &&
    p.y >= Math.min(a.y, b.y) - 1 &&
    p.y <= Math.max(a.y, b.y) + 1 &&
    Math.abs(orientation(a, b, p)) < 1
  );
}

function segmentsCross(segA, segB) {
  const a = segA.a, b = segA.b, c = segB.a, d = segB.b;
  if (near(a, c) || near(a, d) || near(b, c) || near(b, d)) return false;

  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }

  return onSegment(a, b, c) || onSegment(a, b, d) ||
         onSegment(c, d, a) || onSegment(c, d, b);
}

function routeLength(points) {
  return round(points.slice(0, -1).reduce((sum, point, i) => {
    const next = points[i + 1];
    return sum + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0));
}

function edgeKey(edge) {
  return `${edge.source}->${edge.target}`;
}

function buildGeometryPayload(diagramModel, graph) {
  const modelEdgesById = new Map(diagramModel.edges.map((edge, idx) => [`edge_${idx}`, edge]));
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const nodeSummaries = graph.nodes.map(node => ({
    id: node.id,
    label: node.label,
    type: node.type,
    x: round(node.x),
    y: round(node.y),
    width: round(node.width),
    height: round(node.height),
    center: nodeCenter(node)
  }));

  const edgeSummaries = graph.edges.map(edge => {
    const modelEdge = modelEdgesById.get(edge.id);
    const section = edge.sections?.[0];
    const points = pointsForSection(section);
    const source = nodesById.get(modelEdge.from);
    const target = nodesById.get(modelEdge.to);
    const labelBox = edge.labels?.[0]
      ? {
          text: edge.labels[0].text,
          x: round(edge.labels[0].x ?? 0),
          y: round(edge.labels[0].y ?? 0),
          width: round(edge.labels[0].width ?? 0),
          height: round(edge.labels[0].height ?? 0)
        }
      : null;

    return {
      id: edge.id,
      source: modelEdge.from,
      sourceLabel: source?.label || modelEdge.from,
      sourceType: source?.type || 'unknown',
      target: modelEdge.to,
      targetLabel: target?.label || modelEdge.to,
      targetType: target?.type || 'unknown',
      label: modelEdge.label || '',
      currentSourceSide: pointSide(points[0], source),
      currentTargetSide: pointSide(points[points.length - 1], target),
      routeLength: routeLength(points),
      bendCount: Math.max(0, points.length - 2),
      points,
      labelBox
    };
  });

  const edgeCrossings = [];
  for (let i = 0; i < edgeSummaries.length; i++) {
    for (let j = i + 1; j < edgeSummaries.length; j++) {
      const edgeA = edgeSummaries[i];
      const edgeB = edgeSummaries[j];
      for (const segA of segments(edgeA.points)) {
        for (const segB of segments(edgeB.points)) {
          if (segmentsCross(segA, segB)) {
            edgeCrossings.push({
              edgeA: edgeA.id,
              edgeAConnection: edgeKey(edgeA),
              edgeB: edgeB.id,
              edgeBConnection: edgeKey(edgeB),
              at: {
                segmentA: segA,
                segmentB: segB
              }
            });
          }
        }
      }
    }
  }

  const focusEdges = edgeSummaries.filter(edge =>
    edge.source === 'workflow_events' ||
    edge.target === 'workflow_events' ||
    /workflow|event|kafka/i.test(edge.label)
  );

  return {
    title: diagramModel.title,
    diagramType: diagramModel.diagramType,
    viewport: {
      width: round(graph.width),
      height: round(graph.height)
    },
    nodes: nodeSummaries,
    edges: edgeSummaries,
    focus: {
      messageBusId: 'workflow_events',
      messageBusEdges: focusEdges.map(edge => edge.id),
      notableQuestion: 'Should Workflow Orchestrator connect to Workflow Events on the right side of Workflow Events?'
    },
    edgeCrossings,
    topCrossingEdges: edgeCrossings.slice(0, 12)
  };
}

function buildMessages(payload, topN) {
  const reviewPayload = buildReviewPayload(payload);
  const systemPrompt = `You are a JSON-only port-hint reviewer for C4 architecture diagrams.

You receive rendered diagram geometry, not an image. Suggest only small source/target port changes that could make connection lines easier to read.

Allowed suggestion fields:
- edgeId: one of the edge ids in the payload
- sourceSide: optional LEFT|RIGHT|TOP|BOTTOM
- targetSide: optional LEFT|RIGHT|TOP|BOTTOM
- confidence: high|medium|low
- reason: one short sentence

Rules:
- Return at most ${topN} suggestions.
- Prefer message bus side-entry suggestions when they reduce awkward top/bottom cap approaches.
- Prefer source/target sides that match the relative position of connected nodes.
- Do not suggest moving nodes or changing labels.
- Do not invent edge ids.
- Output only valid JSON.
- Do not include markdown, bullet points, prose, or analysis outside the JSON object.
- The first character of your response must be "{".`;

  const userPrompt = `Rendered geometry review payload:
${JSON.stringify(reviewPayload, null, 2)}

Return only this JSON shape:
{
  "suggestions": [
    {
      "edgeId": "edge_0",
      "sourceSide": "RIGHT",
      "targetSide": "LEFT",
      "confidence": "medium",
      "reason": "Short reason."
    }
  ],
  "rationale": "Brief overall rationale."
}

If unsure, return {"suggestions":[],"rationale":"No confident port hints."}.`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
}

function buildReviewPayload(payload) {
  const focusEdgeIds = new Set(payload.focus.messageBusEdges);
  const crossingEdgeIds = new Set();
  for (const crossing of payload.topCrossingEdges.slice(0, 8)) {
    crossingEdgeIds.add(crossing.edgeA);
    crossingEdgeIds.add(crossing.edgeB);
  }

  const selectedEdges = payload.edges
    .filter(edge => focusEdgeIds.has(edge.id) || crossingEdgeIds.has(edge.id))
    .slice(0, 10)
    .map(edge => ({
      id: edge.id,
      connection: `${edge.sourceLabel} (${edge.source}) -> ${edge.targetLabel} (${edge.target})`,
      sourceType: edge.sourceType,
      targetType: edge.targetType,
      label: edge.label,
      currentSourceSide: edge.currentSourceSide,
      currentTargetSide: edge.currentTargetSide,
      routeLength: edge.routeLength,
      bendCount: edge.bendCount,
      start: edge.points[0],
      end: edge.points[edge.points.length - 1],
      bends: edge.points.slice(1, -1)
    }));

  const selectedNodeIds = new Set();
  for (const edge of selectedEdges) {
    const ids = edge.connection.match(/\(([^)]+)\)/g) || [];
    ids.forEach(id => selectedNodeIds.add(id.slice(1, -1)));
  }
  selectedNodeIds.add(payload.focus.messageBusId);

  const selectedNodes = payload.nodes
    .filter(node => selectedNodeIds.has(node.id))
    .map(node => ({
      id: node.id,
      label: node.label,
      type: node.type,
      box: { x: node.x, y: node.y, width: node.width, height: node.height },
      center: node.center
    }));

  return {
    title: payload.title,
    viewport: payload.viewport,
    focus: payload.focus,
    nodes: selectedNodes,
    edges: selectedEdges,
    topCrossingEdges: payload.topCrossingEdges.slice(0, 5).map(crossing => ({
      edgeA: crossing.edgeA,
      edgeAConnection: crossing.edgeAConnection,
      edgeB: crossing.edgeB,
      edgeBConnection: crossing.edgeBConnection
    }))
  };
}

async function renderDiagram(inputPath, outputDir) {
  const source = fs.readFileSync(inputPath, 'utf8');
  const diagramModel = parseMermaidC4(source);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 2400 } });
    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`);
    });

    const templateUrl = new URL('../src/render.html', import.meta.url).href;
    await page.goto(templateUrl);

    const graph = await page.evaluate((data) => window.renderDiagram(data), diagramModel);
    if (!graph.success) throw new Error(graph.error || 'render failed');

    await page.setViewportSize({
      width: Math.ceil(graph.width) + 100,
      height: Math.ceil(graph.height) + 100
    });
    const svgElement = await page.$('#svg-root');
    await svgElement.screenshot({ path: path.join(outputDir, 'render.png') });

    return { diagramModel, graph };
  } finally {
    await browser.close();
  }
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
      max_tokens: 800,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'port_hint_review',
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
                    sourceSide: { type: 'string', enum: ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'] },
                    targetSide: { type: 'string', enum: ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'] },
                    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                    reason: { type: 'string' }
                  },
                  required: ['edgeId', 'confidence', 'reason']
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

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM request failed ${response.status}: ${text}`);
  }

  const result = await response.json();
  const choice = result.choices?.[0];
  const text = (choice?.message?.content || choice?.message?.reasoning_content || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { raw: text, parsed: null };
  }

  return { raw: text, parsed: JSON.parse(jsonMatch[0]) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const { diagramModel, graph } = await renderDiagram(inputPath, outputDir);
  const payload = buildGeometryPayload(diagramModel, graph);
  const reviewPayload = buildReviewPayload(payload);
  const messages = buildMessages(payload, args.top);

  fs.writeFileSync(path.join(outputDir, 'geometry_payload.json'), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outputDir, 'review_payload.json'), JSON.stringify(reviewPayload, null, 2));
  fs.writeFileSync(path.join(outputDir, 'prompt_messages.json'), JSON.stringify(messages, null, 2));

  console.log(`Rendered ${inputPath}`);
  console.log(`Wrote ${path.join(outputDir, 'render.png')}`);
  console.log(`Wrote ${path.join(outputDir, 'geometry_payload.json')}`);
  console.log(`Wrote ${path.join(outputDir, 'review_payload.json')}`);
  console.log(`Wrote ${path.join(outputDir, 'prompt_messages.json')}`);
  console.log(`Detected ${payload.edgeCrossings.length} edge-edge crossings.`);

  if (args.dryRun) {
    console.log('Dry run only. Re-run without --dry-run to call the local LM.');
    return;
  }

  const lmResult = await callModel(args, messages);
  fs.writeFileSync(path.join(outputDir, 'lm_response.json'), JSON.stringify(lmResult, null, 2));

  console.log(`Wrote ${path.join(outputDir, 'lm_response.json')}`);
  console.log(JSON.stringify(lmResult.parsed || { raw: lmResult.raw }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
