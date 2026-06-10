# Container Diagram Layout Engine

This document describes the full layout pipeline used for C4Container diagrams (any Mermaid input that contains a `Boundary(...)` block). It replaces ELK for this diagram type entirely — ELK is only used for flat C4Context diagrams.

---

## Overview

The pipeline has two distinct engines and runs in this order every time a container diagram is processed:

```
Input model
    │
    ▼
[core/optimizer.js] Visual-Hint Pipeline   ← runs ONCE for containers
    │  renderDiagram()
    │  → step_0_initial
    │  → step_1_top_order
    │  → step_2_port_hints
    │  → step_3_diagonal_routes
    │  → accepts only score-improving _layoutOverrides
    │
    ▼
[core/optimizer.js] Final critique + export
    │
    ▼
[render_engine.js] layoutContainerDiagram()
    │  Phase 1: boundary interior
    │  Phase 2: external node placement + edge routing
    │
    ▼
[render_engine.js] renderEdges() / drawGraph()
    │  Phase 3: edge rendering & rule-based label placement
    │
    ▼
PNG screenshot + SVG export
```

---

## Phase 1 — Boundary Interior Layout

**File:** `src/render_engine.js` → `layoutContainerDiagram()`  
**Sub-phases:** 1a, 1b, 1c

### 1a: Kahn's topological layer assignment

Children of the boundary are sorted into horizontal layers using a modified Kahn's algorithm.

**Key rule — entry-node seeding:**
- Nodes that receive at least one edge from *outside* the boundary (`extEdges` where `e.to` is a child) are flagged as `hasExternalIn`.
- Zero-in-degree nodes that are in `hasExternalIn` become the `seedLayer` (Layer 0).
- Zero-in-degree nodes with *no* external incoming edges (`lateralNodes`) are **not** seeded into Layer 0 — they fall into Layer 1 naturally on the next Kahn pass.

This prevents utility/support nodes (e.g. background lambdas with no callers) from cluttering the entry row.

**Cycle handling:** If the Kahn queue empties before all nodes are processed (i.e. a cycle exists), the remaining unplaced nodes are dumped into one final layer.

### 1a′: Dedicated rows for buses and databases

Two node types are excluded from the topological sort and reinserted into purpose-built rows after Kahn + barycenter have settled. Without these overrides, Kahn treats both as sinks (everything points at them, nothing points out) and lumps them into the deepest layer alongside services they should be visually distinct from.

**Message buses (`message_bus` / `ContainerQueue`):**
- Excluded from Kahn's sort and from barycenter calculations.
- **Bottom-right corner anchor:** all message buses are appended after database rows and right-aligned inside the boundary, using otherwise empty bottom-right space.
- **Width step-up:** a bus with 3 connections doubles in width; a bus with 4+ connections uses 3× width. Below the threshold it stays at the standard container width.

**Databases (`database` / `ContainerDb`):**
- Excluded from Kahn's sort and from barycenter calculations.
- Reinserted into a dedicated row directly beneath the **deepest contributing service** layer. Dbs sharing the same deepest contributor layer share a single dedicated row.
- **Column override:** databases break the standard "centre each layer" rule. Each db is placed at the x of its deepest connecting service so storage sits directly beneath its owner. When multiple dbs in the same row collide on column, they pack left-to-right starting from the leftmost parent's x.

**DB row spacing** (`DB_V_GAP = V_GAP`): database rows use the same vertical gap as service rows. Visual pairing with the parent is established by the x-centering rule below, so no tighter spacing is needed.

**Parent→db direct vertical route:** when a parent service sits directly above its db (column-aligned within half the smaller node's width), the edge bypasses the standard distribution logic and runs from the bottom-centre of the parent straight into the top-centre of the db. Other outgoing edges from the same parent still use the distributed exit points.

### 1b: Boundary dimensions

```
bndW = max(layer widths) + leftPad + rightPad
bndH = sum(layer heights) + sum(gapBefore(layer)) + B_PAD + B_BOT
```

`gapBefore(i)` returns `0` for the top layer, `DB_V_GAP` when layer `i` is a database row, and `V_GAP` otherwise — so paired service+db rows are tighter than service-to-service spacing.

`leftPad` and `rightPad` start at `B_PAD` and may grow independently when the internal edge router predicts heavy long-route pressure on that side. This reserves an in-boundary route corridor beside the content band instead of sizing the boundary from container boxes alone. Child layers are positioned inside the stable content band (`contentLeft ... contentRight`), so extra corridor space is genuinely available for long gutter routes rather than being lost to recentring.

Constants & Sizing Rules:
| Constant / Rule | Value | Purpose |
|-----------------|-------|---------|
| `H_GAP`         | 80px  | Horizontal gap between nodes in the same layer |
| `V_GAP`         | 80px  | Vertical gap between layers |
| `DB_V_GAP`      | same as `V_GAP`    | Vertical gap before a database row (same as standard) |
| `B_PAD`         | 80px  | Boundary padding — left, right, and top |
| Route corridor extra | 80px per busy side | Extra left/right boundary padding when long internal routes need a side corridor |
| `B_BOT`         | 84px  | Bottom clearance for the boundary label area |
| Default Width   | 200px | Standardized width for all nodes (database, person, container, external) to align them nicely in a grid |
| Default Height  | 80px / 140px | Standardized heights: 140px for database, person, container, and external systems; 80px for other types |
| Description Clamp | 3 lines | Text clamping for the node description (`.node-desc`) using `-webkit-line-clamp` |

### 1c: Child positions (relative to boundary)

Each layer is centred horizontally inside the boundary's content band. Positions are stored in `childPos[id]` as offsets relative to the boundary's top-left corner.

**Database row exception:** db rows skip the standard centring step. Each db is first given a tentative x equal to its deepest connecting service's x (looked up from `childPos`). The row is then packed left-to-right to resolve collisions, producing a cluster. The whole cluster is then shifted so its centre aligns with the centroid of all parent node centres in the row, then clamped to the content band so no db can escape into reserved route corridors. This guarantees the db cluster sits visually beneath its owning services without ever overflowing.

**Corner bus row exception:** message bus rows skip the centring step and right-align to the content band's right edge, keeping reserved route-corridor padding available while placing the bus in the boundary's bottom-right quadrant.

---

## Phase 2 — External Node Placement

**File:** `src/render_engine.js` → `layoutContainerDiagram()`  
**Sub-phases:** 2a, 2b, 2c, 2d

### 2a: External node classification

All non-boundary nodes are classified into zones based on their edges:

| Classification | Rule | Placement zone |
|----------------|------|----------------|
| **Caller** | Has at least one edge *into* the boundary (`e.to` is a child) | `above` |
| **Callee** | Has edges *from* the boundary only (`e.from` is a child, not also a caller) | `below` |
| **Bidirectional** | Edges both into and out of the boundary | treated as **caller** → `above` |
| **Unconnected** | No cross-boundary edges at all | treated as **caller** → `above` |

**Overflow rule:** Up to `MAX_ABOVE = 6` callers/unconnected nodes fit in the centred above-row. Beyond that, extras spill into `left`/`right` alternately (even index → left, odd → right).

### 2a′: Connectivity-based zone sorting

After classification, each zone's node array is sorted by the average layer/column index of the internal nodes it connects to. This ensures that external nodes are vertically (or horizontally) aligned with their connected internal components, minimising edge crossings.

**Vertical zones (left, right):** Nodes are sorted by the average Kahn layer index of their connected internal nodes. For example, an external system connected to a Layer 0 internal node is placed above one connected to a Layer 1 node.

**Horizontal zones (above, below):** Nodes are sorted by the average column index (position within a layer) of their connected internal nodes.

**Stable sort fallback:** When two external nodes have the same average connected index, their original declaration order in the Mermaid source file is preserved.

This sorting runs deterministically in the browser rendering pass with zero latency cost, producing a clean initial layout before any optional visual hints are evaluated.

**Override support (`_layoutOverrides`):**  
The active container optimizer writes accepted visual hints into `_layoutOverrides`. `internalOrder` can override the left-to-right order of an internal layer, `portHints` can request source/target sides for specific edges, and `routeHints` can request route intents such as `LEFT_LANE`, `RIGHT_LANE`, or `ORTHOGONAL_NEAR_TARGET`. The renderer also still understands `zoneOverrides` and `swapCommands` for older experiments, but the production optimizer currently uses the visual-hint keys.

### 2b: Total diagram dimensions

```
innerW  = max(aboveRow width, boundaryWidth, belowRow width)
totalW  = innerW + leftColumnWidth + rightColumnWidth
totalH  = aboveRowHeight + EXT_GAP + boundaryHeight + EXT_GAP + belowRowHeight
```

`EXT_GAP = 80px` — vertical gap between the boundary and each external row (omitted if that row is empty).

Left/right columns are as wide as their widest node plus `H_GAP`.

### 2c: Absolute node positions

- **Above row:** centred horizontally over `innerW`, y = 0
- **Boundary:** centred over `innerW`, y = aboveRowHeight + EXT_GAP
- **Below row:** centred over `innerW`, y = boundaryBottom + EXT_GAP
- **Left nodes:** stacked vertically, x = boundaryLeft − nodeWidth − H_GAP, starting at boundaryTop
- **Right nodes:** stacked vertically, x = boundaryRight + H_GAP, starting at boundaryTop

### 2d: Orthogonal edge routing

Each edge is routed by `routeEdge(e)`, which uses absolute coordinates (converting boundary-relative child positions to absolute via `getAbs`).

**Type-specific overrides** are evaluated first and short-circuit the spatial-relationship table below:
- **Parent → database (column-aligned):** if the target is a database sitting directly below the source and their centres are within `min(srcWidth, tgtWidth) / 2`, route a straight line from source bottom-centre to target top-centre, bypassing the standard edge-distribution logic.
- **Source → message bus (vertical entry blocked):** when the source sits above a bus, try side-entry first (route into the left or right end-cap of the bus) to keep the bus's top edge available for label placement.

**Source and target slot ordering:** when a node has multiple outgoing edges, source exit slots are ordered by target centre X so left-going edges leave from the left side of the source and right-going edges leave from the right side. Message-bus entry slots are ordered by source approach X, so routes arriving from the right corridor enter toward the right side of the bus instead of crossing back across the bus row. Databases with a direct vertical parent drop keep that centre drop clear; other incoming database edges are biased to the opposite/nearest side to avoid crossing the direct persistence line.

**Hybrid route scoring:** for internal boundary edges, the router compares the standard route, a direct route, a row-gap dogleg, and left/right gutter detours. Candidates are scored by node crossings first, then a weighted mix of existing edge overlaps/crossings, bend count, and path length. This keeps direct-looking lines when they are clean, while only using detours for routes that would cut through nodes or pile onto existing line corridors.

**Lane reservation:** after a route is selected, `reserveRouteLanes` may offset interior horizontal or vertical segments by compact amounts when they overlap already-routed segments. Start and end segments stay anchored so arrows remain visually attached to their source and target nodes.

**Second-pass rerouting:** after all edges have an initial route, `improveRoutedSections` scores the complete route set, retries only the worst few edge-conflict offenders, and keeps a reroute only when the global score improves without adding node crossings or excessive route length. This removes remaining shared corridors without turning edge routing into a hard no-crossing constraint.

| Spatial relationship | Route shape |
|----------------------|-------------|
| Target directly below source | L-shape: source bottom → horizontal jog at midpoint → target top |
| Target directly above source | L-shape: source top → horizontal jog at midpoint → target bottom |
| Source and target are vertically aligned (centres within 3px) | Straight vertical line, no bend points |
| Same horizontal band | Straight horizontal line from side edge to side edge |
| Fallback (none of the above) | U-shape arcing above both nodes |

Bend points are post-processed by `renderEdges` into SVG quadratic bezier curves with a broad corner radius to remove sharp kinks.

---

## Phase 3 — Edge Rendering & Rule-Based Label Placement

**File:** `src/render_engine.js` → `renderEdges()`

After the absolute layout positions are computed, the edges and their description labels are rendered dynamically. To prevent relationship labels from overlapping with nodes, arrowheads, other labels, and dense route corridors, a rule-based placement engine evaluates segment clearance and selects the best location. The final rendered label coordinates are written back onto the returned edge labels so post-render metrics measure the actual placement rather than estimating it independently.

### 3a: Collision Analysis
`checkLabelCollision(cx, cy, w, h, nodesList)` calculates a bounding box around a candidate center label position (padded with horizontal and vertical margins) and checks for intersection/overlap against all node bounding boxes in the diagram. Only nodes that are not the direct source or target of the edge are considered potential collision risks.

### 3b: Placement Rules (Evaluated Sequentially)
1. **Preference 0: Midpoint (No Collision)**: If there are no node collisions along the straight path, the label is placed directly at the midpoint (`fraction = 0.5`) of the edge.
2. **Rule 1: Target-Anchored Placement**: If the midpoint fails or a collision is found, the engine attempts to anchor the label near the target node. It calculates a dynamic distance `targetAnchorDist = Math.max(45, (labelDimension / 2) + 20)` (which ensures the label does not overlap the target arrowhead) and checks for collision.
3. **Rule 2: Source-Anchored Placement**: If target placement fails, it tries to anchor near the source node using a dynamic distance `sourceAnchorDist = Math.max(45, (labelDimension / 2) + 20)`.
4. **Rule 3: Fallback (Edge-Density-Aware Segment Scoring)**: If all anchor placements collide, the engine samples every individual routing segment. Each candidate is scored based on:
   ```
   Score = node collision penalty + placed-label penalty + edge-hit penalty - node clearance reward - segment length reward
   ```
   This prioritizes candidates that avoid nodes, already-placed labels, and other connection lines, while still preferring segments that are far from surrounding nodes and have sufficient length. Once the segment is chosen, the label coordinates are clamped to the safe inner bounds of the segment.
5. **Default Fallback**: If all else fails, the label defaults to the absolute middle of the start/end points.

### 3c: Text Wrapping
Labels containing technology notes (e.g. `Relationship Label [JSON/HTTPS]`) are split. The main description label is wrapped automatically into multiple lines based on `MAX_LABEL_WIDTH` (160px), and the technology label is positioned underneath with a smaller, semi-transparent font style.

---

## Visual-Hint Pipeline

**File:** `src/core/optimizer.js`  
**Functions:** `getLLMTopOrder`, `getLLMPortHints`, `getLLMDiagonalRouteHints` (all in `src/core/llm_client.js`)  
**Runs:** Once for container diagrams, before final SVG/PNG export.

Container diagrams do not use the flat-diagram ELKjs parameter loop. Instead, the optimizer renders a small sequence of visual states and keeps only candidate hints that improve the renderer's geometry score. When `NUDGE_NO_LLM` is set, each stage is still rendered for inspection but no LLM hint calls are made.

### Stage 0 — Initial deterministic render

`renderContainerStep('step_0_initial')` calls `window.renderDiagram` with the current model and captures `step_0_initial.png`. This result becomes the baseline accepted state.

### Stage 1 — Top internal row order

`getLLMTopOrder` reviews the rendered top row of internal containers and may return a replacement order for that row:

```json
{
  "layerIndex": 0,
  "currentOrder": ["web", "mobile"],
  "suggestedOrder": ["mobile", "web"],
  "confidence": "medium",
  "reason": "..."
}
```

If the suggested order contains exactly the same IDs as the current row, the optimizer tries it as:

```js
diagramModel._layoutOverrides.internalOrder[0] = suggestedOrder;
```

The rendered candidate is saved as `step_1_top_order.png` and accepted only if its score is no worse than the previous accepted state.

### Stage 2 — Port hints

`getLLMPortHints` focuses on crossing edges and message-bus edges. It may request explicit source and target sides for a few edge IDs:

```json
{
  "suggestions": [
    {
      "edgeId": "edge_7",
      "sourceSide": "RIGHT",
      "targetSide": "LEFT",
      "confidence": "medium",
      "reason": "..."
    }
  ],
  "rationale": "..."
}
```

Accepted hints are stored as:

```js
diagramModel._layoutOverrides.portHints.edge_7 = {
  sourceSide: "RIGHT",
  targetSide: "LEFT"
};
```

The candidate is saved as `step_2_port_hints.png`.

### Stage 3 — Diagonal route hints

`getLLMDiagonalRouteHints` reviews long diagonal segments and may request a route intent:

```json
{
  "suggestions": [
    {
      "edgeId": "edge_12",
      "routeIntent": "LEFT_LANE",
      "confidence": "medium",
      "reason": "..."
    }
  ],
  "rationale": "..."
}
```

`KEEP_DIAGONAL` is ignored because it leaves the deterministic route untouched. Other accepted intents are stored as:

```js
diagramModel._layoutOverrides.routeHints.edge_12 = {
  routeIntent: "LEFT_LANE"
};
```

The candidate is saved as `step_3_diagonal_routes.png`.

### Candidate scoring and outputs

Every candidate is scored by `scoreContainerStep` in `src/core/optimizer.js`:

```
overlaps * 100000
+ edge-node crossings * 100000
+ edge-edge crossings * 500
+ edge overlaps * 500
+ edge overlap pixels * 2
+ label-edge intersections * 250
+ bends * 4
+ route length * 0.02
```

Only non-worsening candidates become the accepted state. The final accepted state is exported as `optimized.png` and `optimized.svg`. If any LLM hint call returned data, the raw responses are saved to `visual_hints.json`.

---

## Output Graph Format

`layoutContainerDiagram` returns a graph object compatible with `drawGraph` and `flattenNodes`/`flattenEdges`:

```js
{
  id: 'root',
  x: 0, y: 0,
  width: totalW,
  height: totalH,
  children: [
    // External nodes — absolute positions
    { id, x, y, width, height, type, label, description, edges: [] },
    ...
    // Boundary node
    {
      id, x: bndX, y: bndY, width: bndW, height: bndH,
      type: 'boundary', label, description, edges: [],
      children: [
        // Children — positions relative to boundary top-left
        { id, x, y, width, height, type, label, description, edges: [] }
      ]
    }
  ],
  edges: [
    // All edges (internal + cross-boundary) at root level with absolute section coordinates
    { id, sources: [from], targets: [to], labels: [...], sections: [{ startPoint, endPoint, bendPoints }] }
  ]
}
```

All edge coordinates are absolute. The `drawGraph` function uses `flattenNodes` to walk the children tree and `flattenEdges` on the root `edges` array.

---

## Known Limitations / Future Work

- **Single boundary only:** The engine assumes exactly one `Boundary(...)` node at the top level. Nested boundaries are not supported in container mode.
- **No cycle detection warning:** A cycle in the boundary's internal edges is silently broken by dumping remaining nodes into a final layer.
- **Legacy checkpoint helpers remain in `llm_client.js`:** `getLLMZoneVerification` and `getLLMRoutingVerification` are still present for older experiments, but the active container optimizer imports the visual-hint functions instead.
- **Edge routing is heuristic:** The hybrid router scores route candidates, reserves lanes, and performs bounded second-pass rerouting, but it is still not a full obstacle-avoidance engine. Edges may still cross when avoiding them would require long or visually awkward detours.
- **Post-render edge-to-edge scoring is observational:** The renderer uses edge-conflict scoring while choosing routes, and the test suite reports edge-edge crossings, overlaps, overlap pixels, label-edge intersections, bends, and route length. These metrics do not currently fail tests, so renderer changes that affect line corridors should still be reviewed visually.
