import { fetchWithTimeout } from '../utils.js';

const PREFERRED_MODEL = process.env.NUDGE_LLM_MODEL || "google/gemma-4-12b";

// Helper to assemble headers with optional authorization key
function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const apiKey = process.env.NUDGE_LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

// Retrieve active model from LM Studio, preferring PREFERRED_MODEL if available
export async function getActiveModel(apiUrl, { signal } = {}) {
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
      if (preferred) return preferred.id;
      const nonEmbed = data.data.find(m => !m.id.includes('embed'));
      return nonEmbed ? nonEmbed.id : data.data[0].id;
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
