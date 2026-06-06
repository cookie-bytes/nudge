import { fetchWithTimeout } from './utils.js';

// Determine segment-segment intersection
// Segment A: (x1, y1) -> (x2, y2)
// Segment B: (x3, y3) -> (x4, y4)
function lineSegmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const det = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (det === 0) return false; // Parallel

  const lambda = ((y4 - y3) * (x4 - x1) + (x3 - x4) * (y4 - y1)) / det;
  const gamma = ((y1 - y2) * (x4 - x1) + (x2 - x1) * (y4 - y1)) / det;

  return (0 <= lambda && lambda <= 1) && (0 <= gamma && gamma <= 1);
}

// Check if a line segment intersects a bounding box
function lineIntersectsBox(x1, y1, x2, y2, box) {
  const { x, y, width, height } = box;
  const xMin = x;
  const xMax = x + width;
  const yMin = y;
  const yMax = y + height;

  // Check intersection with 4 sides of the box
  return (
    lineSegmentsIntersect(x1, y1, x2, y2, xMin, yMin, xMax, yMin) || // Top
    lineSegmentsIntersect(x1, y1, x2, y2, xMax, yMin, xMax, yMax) || // Right
    lineSegmentsIntersect(x1, y1, x2, y2, xMax, yMax, xMin, yMax) || // Bottom
    lineSegmentsIntersect(x1, y1, x2, y2, xMin, yMax, xMin, yMin)    // Left
  );
}

// Minimum distance from a point to the nearest edge of a bounding box (0 if inside)
function pointToBoxDist(px, py, box) {
  const dx = Math.max(box.x - px, 0, px - (box.x + box.width));
  const dy = Math.max(box.y - py, 0, py - (box.y + box.height));
  return Math.sqrt(dx * dx + dy * dy);
}

// Check if two boxes overlap
function boxesOverlap(boxA, boxB) {
  return (
    boxA.x < boxB.x + boxB.width &&
    boxA.x + boxA.width > boxB.x &&
    boxA.y < boxB.y + boxB.height &&
    boxA.y + boxA.height > boxB.y
  );
}

// Minimum edge-to-edge distance between two non-overlapping axis-aligned boxes
function boxEdgeDistance(nA, nB) {
  const cxA = nA.x + nA.width / 2;
  const cyA = nA.y + nA.height / 2;
  const cxB = nB.x + nB.width / 2;
  const cyB = nB.y + nB.height / 2;
  const edgeDistX = Math.abs(cxA - cxB) - (nA.width + nB.width) / 2;
  const edgeDistY = Math.abs(cyA - cyB) - (nA.height + nB.height) / 2;
  // One axis overlaps → gap is purely along the other axis
  if (edgeDistX <= 0) return edgeDistY;
  if (edgeDistY <= 0) return edgeDistX;
  // Diagonal separation → corner-to-corner Euclidean distance
  return Math.sqrt(edgeDistX * edgeDistX + edgeDistY * edgeDistY);
}

// Perform complete geometric layout critique
export function analyzeLayout(layoutData) {
  const { nodes, edges, width, height } = layoutData;
  const report = {
    collisions: [],
    overlapCount: 0,
    intersectionCount: 0,
    aspectRatio: (width / height).toFixed(2),
    width,
    height
  };

  // Filter out boundary containers when calculating component overlaps (since children reside inside them)
  const components = nodes.filter(n => n.type !== 'boundary');

  // 1. Check for component-to-component overlaps
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const nodeA = components[i];
      const nodeB = components[j];

      if (boxesOverlap(nodeA, nodeB)) {
        report.overlapCount++;
        report.collisions.push({
          type: 'node_overlap',
          elements: [nodeA.id, nodeB.id],
          details: `Nodes '${nodeA.label}' (${nodeA.id}) and '${nodeB.label}' (${nodeB.id}) overlap.`
        });
      }
    }
  }

  // 2. Check for edge lines crossing components they shouldn't
  for (const edge of edges) {
    if (!edge.sections || edge.sections.length === 0) continue;

    const sourceId = edge.sources[0];
    const targetId = edge.targets[0];
    const section = edge.sections[0];

    // Gather all segment coordinates for this edge
    const points = [{ x: section.startPoint.x, y: section.startPoint.y }];
    if (section.bendPoints) {
      points.push(...section.bendPoints);
    }
    points.push({ x: section.endPoint.x, y: section.endPoint.y });

    // For every component (excluding source, target, and parent boundary nodes)
    for (const comp of components) {
      if (comp.id === sourceId || comp.id === targetId) continue;

      // Check if any segment of the edge line intersects the component box
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];

        if (lineIntersectsBox(p1.x, p1.y, p2.x, p2.y, comp)) {
          report.intersectionCount++;
          report.collisions.push({
            type: 'edge_node_crossing',
            edge: `${sourceId} -> ${targetId}`,
            node: comp.id,
            details: `Relationship arrow '${sourceId} -> ${targetId}' cuts directly through node '${comp.label}' (${comp.id}).`
          });
          break; // Stop checking segments for this component once crossing is found
        }
      }
    }
  }

  // 2b. Check for edge labels overlapping components they shouldn't
  for (const edge of edges) {
    if (!edge.sections || edge.sections.length === 0) continue;
    if (!edge.labels || edge.labels.length === 0) continue;

    const sourceId = edge.sources[0];
    const targetId = edge.targets[0];
    const section = edge.sections[0];
    const label = edge.labels[0];

    const points = [{ x: section.startPoint.x, y: section.startPoint.y }];
    if (section.bendPoints) {
      points.push(...section.bendPoints);
    }
    points.push({ x: section.endPoint.x, y: section.endPoint.y });

    const nearbyComps = components;

    let bestSeg = null;
    let bestScore = -Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const clearance = nearbyComps.length > 0
        ? Math.min(...nearbyComps.map(n => pointToBoxDist(mx, my, n)))
        : Infinity;
      const score = clearance * 10 + len;
      if (score > bestScore) { bestScore = score; bestSeg = { p1, p2 }; }
    }

    if (!bestSeg) continue;

    const midX = (bestSeg.p1.x + bestSeg.p2.x) / 2;
    const midY = (bestSeg.p1.y + bestSeg.p2.y) / 2;

    const labelBox = {
      x: midX - label.width / 2 - 4,
      y: midY - label.height / 2 - 2,
      width: label.width + 8,
      height: label.height + 4
    };

    for (const comp of components) {
      if (comp.id === sourceId || comp.id === targetId) continue;

      if (boxesOverlap(labelBox, comp)) {
        report.collisions.push({
          type: 'edge_label_node_crossing',
          edge: `${sourceId} -> ${targetId}`,
          label: label.text,
          node: comp.id,
          details: `Relationship label '${label.text}' on edge '${sourceId} -> ${targetId}' overlaps with node '${comp.label}' (${comp.id}).`
        });
      }
    }
  }

  // 3. Proximity check — flag non-overlapping nodes closer than 45px
  const minSafeDistance = 45;
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      const nA = components[i];
      const nB = components[j];

      const edgeDistance = boxEdgeDistance(nA, nB);
      if (edgeDistance > 0 && edgeDistance < minSafeDistance) {
        report.collisions.push({
          type: 'tight_spacing',
          elements: [nA.id, nB.id],
          distance: Math.round(edgeDistance),
          details: `Nodes '${nA.label}' and '${nB.label}' are extremely close (${Math.round(edgeDistance)}px separation), which may overlap text or look cramped.`
        });
      }
    }
  }

  return report;
}

// Retrieve active model from LM Studio
async function getActiveModel(apiUrl) {
  try {
    const res = await fetchWithTimeout(`${apiUrl}/v1/models`, { timeout: 3000 });
    const data = await res.json();
    if (data && data.data && data.data.length > 0) {
      // Find the first non-embedding model
      const active = data.data.find(m => !m.id.includes('embed'));
      return active ? active.id : data.data[0].id;
    }
  } catch (err) {
    console.warn("Could not retrieve model list from LM Studio, falling back to google/gemma-4-12b", err.message);
  }
  return "google/gemma-4-12b";
}

// Query the LLM to get layout options patch
export async function getLLMOptimizationPatch(apiUrl, currentOptions, layoutReport) {
  const activeModel = await getActiveModel(apiUrl);
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: activeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 2048
      }),
      timeout: 60000
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
