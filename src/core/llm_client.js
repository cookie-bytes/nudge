import { fetchWithTimeout } from '../utils.js';

const PREFERRED_MODEL = process.env.NUDGE_LLM_MODEL || "google/gemma-4-12b";

const modelCache = new Map();

// Helper to assemble headers with optional authorization key
export function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = process.env.NUDGE_LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

// Retrieve active model from LM Studio, preferring PREFERRED_MODEL if available.
// Result is cached per apiUrl for the lifetime of the process — avoids one /v1/models
// roundtrip before every LLM call when the optimizer runs multiple iterations.
export async function getActiveModel(apiUrl, { signal } = {}) {
  if (modelCache.has(apiUrl)) return modelCache.get(apiUrl);
  try {
    const res = await fetchWithTimeout(`${apiUrl}/v1/models`, {
      headers: getHeaders(),
      timeout: 3000,
      signal
    });
    const data = await res.json();
    if (data && data.data && data.data.length > 0) {
      const modelSearch = PREFERRED_MODEL.includes('/') ? PREFERRED_MODEL.split('/')[1] : PREFERRED_MODEL;
      const preferred = data.data.find(m => m.id.toLowerCase().includes(modelSearch.toLowerCase()));
      const resolved = preferred
        ? preferred.id
        : (data.data.find(m => !m.id.includes('embed')) ?? data.data[0]).id;
      modelCache.set(apiUrl, resolved);
      return resolved;
    }
  } catch (err) {
    console.warn("Could not retrieve model list from LM Studio, falling back to", PREFERRED_MODEL, err.message);
  }
  return PREFERRED_MODEL;
}

// Query LM to verify zone assignments after Phase 2 classification
export async function getLLMZoneVerification(apiUrl, plan, { signal, timeout = 30000 } = {}) {
  const activeModel = await getActiveModel(apiUrl, { signal });
  console.log(`[Checkpoint 1] Querying LLM (${activeModel}) for zone verification...`);

  const systemPrompt = `You are Nudge, an expert C4 architecture diagram layout optimizer.

You will receive a layout plan for a container diagram with:
- zones: which external nodes are placed ABOVE, BELOW, LEFT, or RIGHT of the boundary
- boundary.layers: internal components in top-to-bottom data flow order
- crossZoneEdges: directed edges showing which zone sends to which
- zoneDensity: how many nodes occupy each zone

Zone correctness rules:
- ABOVE: pure callers whose cross-boundary edges target exclusively the first internal layer (Layer 0)
- BELOW: pure callees whose cross-boundary edges originate exclusively from the deepest internal layer
- LEFT: pure callers that connect to middle or lower internal layers (utility/admin nodes, e.g. CLI tools, sync lambdas)
- RIGHT: bidirectional nodes, or pure callees that receive from middle/lower layers (async/stream nodes, e.g. event brokers, webhooks)
- Unconnected nodes default to ABOVE unless they share an inter-external edge with a node in another zone

If any node is in the wrong zone, output RE_ASSIGN instructions as zoneOverrides.
If nodes within a zone would benefit from reordering, output SWAP_NODE_ORDER commands.

Behavioral constraints:
- Do not issue reciprocal SWAP_NODE_ORDER operations that undo ordering changes made in previous layout passes.
- Prioritize placing external nodes that have direct relationships with each other (e.g. a real-time event client and a front-end UI) into adjacent coordinate slots within the same zone to minimize long, boundary-wrapping lines.

Output ONLY valid JSON:
{
  "zoneOverrides": { "nodeId": "above|below|left|right" },
  "swapCommands": [{ "type": "SWAP_NODE_ORDER", "nodeA": "id1", "nodeB": "id2" }],
  "rationale": "brief explanation"
}
If the layout is already correct: { "zoneOverrides": {}, "swapCommands": [], "rationale": "Assignments correct." }`;

  const userPrompt = `### Layout Plan:\n${JSON.stringify(plan, null, 2)}\n\nVerify zone assignments and output your JSON response.`;

  try {
    const response = await fetchWithTimeout(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1024
      }),
      timeout,
      signal,
    });
    const result = await response.json();
    if (!result.choices || result.choices.length === 0) return null;
    const choice = result.choices[0];
    const text = (choice.message.content || choice.message.reasoning_content || '').trim();
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.warn('[Checkpoint 1] No JSON in response.'); return null; }
    const patch = JSON.parse(jsonMatch[0]);
    console.log(`[Checkpoint 1] Rationale: ${patch.rationale || '(none)'}`);
    return patch;
  } catch (err) {
    console.error('[Checkpoint 1] Failed:', err.message);
    return null;
  }
}

// Query LM to verify node ordering within zones (post edge-routing)
export async function getLLMRoutingVerification(apiUrl, plan, { signal, timeout = 30000 } = {}) {
  const activeModel = await getActiveModel(apiUrl, { signal });
  console.log(`[Checkpoint 2] Querying LLM (${activeModel}) for routing verification...`);

  const systemPrompt = `You are Nudge, an expert C4 architecture diagram layout optimizer.

You will receive a layout plan showing the final zone assignments and cross-zone edges.
Your task: check if the left-to-right ordering of nodes within each zone minimises edge crossings.

For example, if node A connects to a boundary entry point on the left side and node B connects to one on the right,
then A should appear to the left of B in the ABOVE zone to keep edges uncrossed.

You may output SWAP_NODE_ORDER commands to reorder within a zone, or SHIFT_ZONE to relocate a node entirely.

Behavioral constraints:
- Do not issue reciprocal SWAP_NODE_ORDER operations that undo ordering changes made in previous layout passes.
- Prioritize placing external nodes that have direct relationships with each other (e.g. a real-time event client and a front-end UI) into adjacent coordinate slots within the same zone to minimize long, boundary-wrapping lines.

Output ONLY valid JSON:
{
  "swapCommands": [
    { "type": "SWAP_NODE_ORDER", "nodeA": "id1", "nodeB": "id2" },
    { "type": "SHIFT_ZONE", "nodeId": "id", "from": "above", "to": "left" }
  ],
  "rationale": "brief explanation"
}
If no changes are needed: { "swapCommands": [], "rationale": "Ordering is optimal." }`;

  const userPrompt = `### Layout Plan:\n${JSON.stringify(plan, null, 2)}\n\nCheck node ordering and output your JSON response.`;

  try {
    const response = await fetchWithTimeout(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1024
      }),
      timeout,
      signal,
    });
    const result = await response.json();
    if (!result.choices || result.choices.length === 0) return null;
    const choice = result.choices[0];
    const text = (choice.message.content || choice.message.reasoning_content || '').trim();
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.warn('[Checkpoint 2] No JSON in response.'); return null; }
    const patch = JSON.parse(jsonMatch[0]);
    console.log(`[Checkpoint 2] Rationale: ${patch.rationale || '(none)'}`);
    return patch;
  } catch (err) {
    console.error('[Checkpoint 2] Failed:', err.message);
    return null;
  }
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function pointsForSection(section) {
  if (!section) return [];
  return [
    section.startPoint,
    ...(section.bendPoints || []),
    section.endPoint
  ].map(p => ({ x: round(p.x), y: round(p.y) }));
}

function nodeCenter(node) {
  return {
    x: round(node.x + node.width / 2),
    y: round(node.y + node.height / 2)
  };
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

function edgeSegments(points) {
  return points.slice(0, -1).map((a, index) => ({ a, b: points[index + 1] }));
}

function modelEdgesByGraphId(diagramModel) {
  return new Map((diagramModel.edges || []).map((edge, index) => [`edge_${index}`, edge]));
}

function edgeConnection(edge) {
  return `${edge.source}->${edge.target}`;
}

function buildEdgeSummaries(diagramModel, graph) {
  const nodesById = new Map((graph.nodes || []).map(node => [node.id, node]));
  const modelEdges = modelEdgesByGraphId(diagramModel);
  return (graph.edges || []).map(edge => {
    const modelEdge = modelEdges.get(edge.id);
    if (!modelEdge) return null;
    const section = edge.sections?.[0];
    const points = pointsForSection(section);
    const source = nodesById.get(modelEdge.from);
    const target = nodesById.get(modelEdge.to);
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
      points
    };
  }).filter(Boolean);
}

function extractJson(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
}

async function callJsonModel(apiUrl, messages, schema, { signal, timeout = 30000, maxTokens = 1000, logPrefix = '[Checkpoint]' } = {}) {
  const activeModel = await getActiveModel(apiUrl, { signal });
  console.log(`${logPrefix} Querying LLM (${activeModel})...`);
  const response = await fetchWithTimeout(`${apiUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model: activeModel,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: schema
      }
    }),
    timeout,
    signal
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LM request failed ${response.status}: ${text}`);
  }
  const result = await response.json();
  const choice = result.choices?.[0];
  const text = (choice?.message?.content || choice?.message?.reasoning_content || '').trim();
  return text ? extractJson(text) : null;
}

export async function getLLMLabelPlacementHints(apiUrl, diagramModel, graph, { signal, timeout = 30000 } = {}) {
  const edgeSummaries = buildEdgeSummaries(diagramModel, graph);
  if (edgeSummaries.length === 0) return null;

  const messages = [
    {
      role: 'system',
      content: `You are Nudge, an expert JSON-only C4 architecture diagram text placement optimizer.

Evaluate the visual layout of the diagram and suggest optimal placement for connection line text labels.
Your goal is to make the relationship labels as readable and clear as possible, especially for long or bent lines.

Allowed placement options:
- "source": Places the label closer to the starting element of the relationship. Excellent for long lines to show who is initiating the connection.
- "target": Places the label closer to the ending element of the relationship. Great when the relationship clearly belongs near the recipient.
- "middle": Places the label in the geometric center of the line. This is the default.

Focus particularly on:
1. Long relationship lines (routeLength > 350px) or highly bent lines (bendCount > 0) where the default "middle" placement is far from the endpoints or routes over unrelated nodes. Suggest "source" or "target" for these.
2. Relationships where a center label overlaps with other nodes or lines.
3. Suggest overrides for ANY connection where "middle" placement would be confusing, ambiguous, or visually separated from its context. Do not be overly conservative.

Output ONLY valid JSON matching the schema.`
    },
    {
      role: 'user',
      content: `Rendered layout review payload:
${JSON.stringify({
  title: diagramModel.title,
  nodes: (graph.nodes || []).map(n => ({
    id: n.id,
    label: n.label,
    type: n.type,
    box: { x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height) }
  })),
  edges: edgeSummaries.map(edge => ({
    id: edge.id,
    connection: `${edge.sourceLabel} (${edge.source}) -> ${edge.targetLabel} (${edge.target})`,
    label: edge.label,
    routeLength: edge.routeLength,
    bendCount: edge.bendCount
  }))
}, null, 2)}

Return your suggestions as JSON.`
    }
  ];

  const schema = {
    name: 'label_placement_review',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suggestions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              edgeId: { type: 'string' },
              placement: { type: 'string', enum: ['source', 'target', 'middle'] },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              reason: { type: 'string' }
            },
            required: ['edgeId', 'placement', 'confidence', 'reason']
          }
        },
        rationale: { type: 'string' }
      },
      required: ['suggestions', 'rationale']
    }
  };

  try {
    const result = await callJsonModel(apiUrl, messages, schema, { signal, timeout, maxTokens: 1000, logPrefix: '[Label Polish]' });
    console.log(`[Label Polish] Rationale: ${result?.rationale || '(none)'}`);
    return result;
  } catch (err) {
    console.error('[Label Polish] Failed:', err.message);
    return null;
  }
}

// Query the LLM to get layout options patch
export async function getLLMOptimizationPatch(apiUrl, currentOptions, layoutReport, { signal, timeout = 60000 } = {}) {
  const activeModel = await getActiveModel(apiUrl, { signal });
  console.log(`[Critic] Querying local LLM (${activeModel}) at ${apiUrl}...`);

  const systemPrompt = `You are Nudge, an expert AI visual layout optimizer for Model-Based Architecture Diagrams.
Your goal is to adjust spatial layout variables (Eclipse Layout Kernel properties) to eliminate collisions, overlaps, and text wrapping conflicts, ensuring a professional, publication-ready C4 diagram.

You will receive:
1. The CURRENT layout parameters.
2. A GEOMETRIC ANALYSIS REPORT identifying layout defects:
   - Overlapping nodes (node_overlap)
   - Edge arrows intersecting nodes (edge_node_crossing)
   - Edge labels overlapping nodes (edge_label_node_crossing)
   - Tight spacing (tight_spacing)
   - Aspect ratio (should ideally be between 1.2 and 1.8 for standard landscape displays, like 16:9).

Your task is to analyze these defects and output a JSON patch of UPDATED ELKjs parameters. Do NOT include explanations, comments, or markdown code blocks inside the JSON itself. Output ONLY valid JSON in your response.

ELKjs parameters you can optimize:
- "elk.spacing.nodeNode": distance between nodes in the same layer (default is usually 40-80, increase to fix node_overlap and tight_spacing).
- "elk.layered.spacing.nodeNodeBetweenLayers": distance between layers/ranks (increase to fix edge crossings or edge-label collisions).
- "elk.spacing.edgeNode": spacing between nodes and edges that run past them.
- "elk.spacing.edgeEdge": spacing between parallel edges.
- "elk.direction": flow direction of layout: "UP", "DOWN", "LEFT", "RIGHT".
- "elk.padding": Padding inside container boundaries, format: "[top=N,left=N,bottom=N,right=N]"

Rules for optimization:
- If node_overlap or tight_spacing are present, increase "elk.spacing.nodeNode" and "elk.layered.spacing.nodeNodeBetweenLayers" significantly (e.g., from 30 up to 80, 100, or 120).
- If edge_node_crossing or edge_label_node_crossing is present, increase "elk.layered.spacing.nodeNodeBetweenLayers" and "elk.spacing.edgeNode" so connections and labels have room to route around components.
- If poor_aspect_ratio is present, note that spacing behaves differently depending on the flow direction:
  * For "elk.direction": "DOWN" or "UP", "elk.spacing.nodeNode" controls horizontal spacing and "elk.layered.spacing.nodeNodeBetweenLayers" controls vertical spacing.
  * For "elk.direction": "RIGHT" or "LEFT", "elk.spacing.nodeNode" controls vertical spacing and "elk.layered.spacing.nodeNodeBetweenLayers" controls horizontal spacing.
  * If Too narrow/portrait (< 1.0): You want to increase width and/or decrease height. If DOWN/UP: increase "elk.spacing.nodeNode" or decrease "elk.layered.spacing.nodeNodeBetweenLayers". If RIGHT/LEFT: increase "elk.layered.spacing.nodeNodeBetweenLayers" or decrease "elk.spacing.nodeNode". Or change "elk.direction" to "RIGHT"/"LEFT".
  * If Too wide/landscape (> 2.0): You want to decrease width and/or increase height. If DOWN/UP: decrease "elk.spacing.nodeNode" or increase "elk.layered.spacing.nodeNodeBetweenLayers". If RIGHT/LEFT: decrease "elk.layered.spacing.nodeNodeBetweenLayers" or increase "elk.spacing.nodeNode". Or change "elk.direction" to "DOWN"/"UP".
- Output a JSON object matching the exact key names of layoutOptions, e.g.:
{
  "elk.spacing.nodeNode": "100",
  "elk.layered.spacing.nodeNodeBetweenLayers": "110",
  "elk.spacing.edgeNode": "50"
}
Output only the JSON block.`;

  const userPrompt = `### Current Layout Options:
${JSON.stringify(currentOptions, null, 2)}

### Geometric Layout Analysis Report:
${JSON.stringify(layoutReport, null, 2)}

Identify the spacing defects and output your optimized JSON layout patch below. Remember: output ONLY the JSON object.`;

  try {
    const response = await fetchWithTimeout(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 2048
      }),
      timeout,
      signal,
    });

    const result = await response.json();

    if (!result.choices || result.choices.length === 0) {
      console.error("[Critic] Unexpected response format from LM Studio:", JSON.stringify(result));
      return null;
    }

    const choice = result.choices[0];
    let text = "";

    // Check content and fallback to reasoning_content if content is empty (common in reasoning models)
    if (choice.message.content && choice.message.content.trim()) {
      text = choice.message.content.trim();
    } else if (choice.message.reasoning_content && choice.message.reasoning_content.trim()) {
      console.log("[Critic] Warning: content was empty, using reasoning_content fallback.");
      text = choice.message.reasoning_content.trim();
    } else {
      console.error("[Critic] Response choice content is completely empty. Raw response:", JSON.stringify(result));
      return null;
    }

    console.log("[Critic] Raw LLM Suggestion (truncated to 400 chars):\n", text.substring(0, 400) + (text.length > 400 ? "..." : ""));

    // Regex to extract JSON block { ... } from the text response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[Critic] No JSON block found in LLM response.");
      return null;
    }

    const cleanJsonText = jsonMatch[0];
    const patch = JSON.parse(cleanJsonText);
    return patch;

  } catch (err) {
    console.error("[Critic] Failed to get LLM response or parse JSON patch:", err);
    return null;
  }
}
