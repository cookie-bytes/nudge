# Container Diagram Layout Engine

This document describes the full layout pipeline used for C4Container diagrams (any Mermaid input that contains a `Boundary(...)` block). It replaces ELK for this diagram type entirely — ELK is only used for flat C4Context diagrams.

---

## Overview

The pipeline has two distinct engines and runs in this order every time a container diagram is processed:

```
Input model
    │
    ▼
[cli.js] LM Checkpoint Pipeline   ← runs ONCE before the optimisation loop
    │  computeContainerPlan()
    │  → Checkpoint 1: zone verification
    │  → Checkpoint 2: ordering verification
    │  → writes _layoutOverrides onto diagramModel
    │
    ▼
[cli.js] Optimisation Loop (up to 4 iterations)
    │
    ▼
[render.html] layoutContainerDiagram()
    │  Phase 1: boundary interior
    │  Phase 2: external node placement + edge routing
    │
    ▼
[render.html] renderEdges() / drawGraph()
    │  Phase 3: edge rendering & rule-based label placement
    │
    ▼
PNG screenshot + SVG export
```

---

## Phase 1 — Boundary Interior Layout

**File:** `src/render.html` → `layoutContainerDiagram()`  
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
- Reinserted into a dedicated horizontal row positioned at the **median** layer index of the bus's connections + 1 — so the bus sits as a spine between publishers above and consumers below, rather than being marooned at the top or bottom.
- **High-connectivity corner anchor:** a bus with ≥ 4 total connections is appended after database rows and right-aligned inside the boundary, using otherwise empty bottom-right space for a busy hub.
- **Width step-up:** a bus with 3 connections doubles in width; a corner-anchored bus uses 3× width. Below the threshold it stays at the standard container width.

**Databases (`database` / `ContainerDb`):**
- Excluded from Kahn's sort and from barycenter calculations.
- Reinserted into a dedicated row directly beneath the **deepest contributing service** layer. Dbs sharing the same deepest contributor layer share a single dedicated row.
- **Column override:** databases break the standard "centre each layer" rule. Each db is placed at the x of its deepest connecting service so storage sits directly beneath its owner. When multiple dbs in the same row collide on column, they pack left-to-right starting from the leftmost parent's x.

**Tighter spacing before a db row** (`DB_V_GAP = V_GAP / 2`): the gap between a service row and its paired db row is half the standard `V_GAP`, so the db visually pairs with its parent instead of floating in its own band of whitespace.

**Parent→db direct vertical route:** when a parent service sits directly above its db (column-aligned within half the smaller node's width), the edge bypasses the standard distribution logic and runs from the bottom-centre of the parent straight into the top-centre of the db. Other outgoing edges from the same parent still use the distributed exit points.

### 1b: Boundary dimensions

```
bndW = max(layer widths) + 2 × B_PAD     (B_PAD = 80px each side)
bndH = sum(layer heights) + sum(gapBefore(layer)) + B_PAD + B_BOT
```

`gapBefore(i)` returns `0` for the top layer, `DB_V_GAP` when layer `i` is a database row, and `V_GAP` otherwise — so paired service+db rows are tighter than service-to-service spacing.

Constants & Sizing Rules:
| Constant / Rule | Value | Purpose |
|-----------------|-------|---------|
| `H_GAP`         | 80px  | Horizontal gap between nodes in the same layer |
| `V_GAP`         | 80px  | Vertical gap between layers |
| `DB_V_GAP`      | 40px (`V_GAP / 2`) | Vertical gap when the next layer is a database row |
| `B_PAD`         | 80px  | Boundary padding — left, right, and top |
| `B_BOT`         | 84px  | Bottom clearance for the boundary label area |
| Default Width   | 200px | Standardized width for all nodes (database, person, container, external) to align them nicely in a grid |
| Default Height  | 80px / 140px | Standardized heights: 140px for database, person, container, and external systems; 80px for other types |
| Description Clamp | 3 lines | Text clamping for the node description (`.node-desc`) using `-webkit-line-clamp` |

### 1c: Child positions (relative to boundary)

Each layer is centred horizontally inside the boundary. Positions are stored in `childPos[id]` as offsets relative to the boundary's top-left corner.

**Database row exception:** db rows skip the centring step. Each db is placed at the x of its deepest connecting service (looked up from `childPos`, which has already been computed for the parent's row since dbs always sit below their parent). If two dbs in the same row resolve to overlapping columns, they pack left-to-right starting from the leftmost parent's x.

**Corner bus row exception:** high-connectivity message bus rows skip the centring step and right-align to `bndW - B_PAD`, keeping standard right padding while placing the bus in the boundary's bottom-right quadrant.

---

## Phase 2 — External Node Placement

**File:** `src/render.html` → `layoutContainerDiagram()`  
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

This sorting runs deterministically in the browser rendering pass with zero latency cost, producing a clean initial layout before the LLM optimisation loop begins.

**Override support (`_layoutOverrides`):**  
After sorting, any `zoneOverrides` map from `diagramModel._layoutOverrides` is applied — each entry moves a node out of its current zone and into the specified one. Then `swapCommands` of type `SWAP_NODE_ORDER` reorder within each zone's array. Overrides take precedence over the automatic sort order.

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

**Hybrid route scoring:** for internal boundary edges, the router compares the standard route, a direct route, a row-gap dogleg, and left/right gutter detours. Candidates are scored by node crossings first, then a weighted mix of existing edge overlaps/crossings, bend count, and path length. This keeps direct-looking lines when they are clean, while only using detours for routes that would cut through nodes or pile onto existing line corridors.

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

**File:** `src/render.html` → `renderEdges()`

After the absolute layout positions are computed, the edges and their description labels are rendered dynamically. To prevent relationship labels from overlapping with nodes and arrowheads, a rule-based placement engine evaluates segment clearance and selects the best location.

### 3a: Collision Analysis
`checkLabelCollision(cx, cy, w, h, nodesList)` calculates a bounding box around a candidate center label position (padded with horizontal and vertical margins) and checks for intersection/overlap against all node bounding boxes in the diagram. Only nodes that are not the direct source or target of the edge are considered potential collision risks.

### 3b: Placement Rules (Evaluated Sequentially)
1. **Preference 0: Midpoint (No Collision)**: If there are no node collisions along the straight path, the label is placed directly at the midpoint (`fraction = 0.5`) of the edge.
2. **Rule 1: Target-Anchored Placement**: If the midpoint fails or a collision is found, the engine attempts to anchor the label near the target node. It calculates a dynamic distance `targetAnchorDist = Math.max(45, (labelDimension / 2) + 20)` (which ensures the label does not overlap the target arrowhead) and checks for collision.
3. **Rule 2: Source-Anchored Placement**: If target placement fails, it tries to anchor near the source node using a dynamic distance `sourceAnchorDist = Math.max(45, (labelDimension / 2) + 20)`.
4. **Rule 3: Fallback (Gutter Clearance Segment Scoring)**: If all anchor placements collide, the engine performs a clearance scan of every individual routing segment. Each segment is scored based on:
   ```
   Score = (Min Distance to Nearby Nodes × 10) + Segment Length
   ```
   This prioritizes segments that are far from surrounding nodes and have sufficient length. Once the segment is chosen, the label coordinates are clamped to the safe inner bounds of the segment.
5. **Default Fallback**: If all else fails, the label defaults to the absolute middle of the start/end points.

### 3c: Text Wrapping
Labels containing technology notes (e.g. `Relationship Label [JSON/HTTPS]`) are split. The main description label is wrapped automatically into multiple lines based on `MAX_LABEL_WIDTH` (160px), and the technology label is positioned underneath with a smaller, semi-transparent font style.

---

## LM Checkpoint Pipeline

**File:** `src/cli.js`  
**Functions:** `getLLMZoneVerification`, `getLLMRoutingVerification` (both in `src/core/llm_client.js`)
**Runs:** Once, before the 4-iteration optimisation loop, only when `hasBoundary` is true.

### Step 1 — Compute initial plan

`window.computeContainerPlan(diagramData)` is called via `page.evaluate`. It mirrors Phase 1 + Phase 2a of `layoutContainerDiagram` but returns structured data instead of an ELK-compatible graph:

```json
{
  "zones": {
    "above": [{ "id": "...", "label": "...", "type": "..." }],
    "below": [...],
    "left":  [...],
    "right": [...]
  },
  "boundary": {
    "id": "...",
    "label": "...",
    "layers": [[{ "id": "...", "label": "..." }], [...]]
  },
  "crossZoneEdges": [
    { "from": "...", "to": "...", "label": "...", "fromZone": "above", "toZone": "boundary" }
  ],
  "zoneDensity": { "above": 2, "below": 1, "left": 0, "right": 0, "maxAbove": 6 }
}
```

### Checkpoint 1 — Zone assignment verification (`getLLMZoneVerification`)

The LM is asked to verify that callers are above and callees are below. It may return:

```json
{
  "zoneOverrides": { "nodeId": "above|below|left|right" },
  "swapCommands": [{ "type": "SWAP_NODE_ORDER", "nodeA": "id1", "nodeB": "id2" }],
  "rationale": "..."
}
```

Any non-empty `zoneOverrides` or `swapCommands` are collected into `overrides`.

### Checkpoint 2 — Node ordering verification (`getLLMRoutingVerification`)

If Checkpoint 1 changed any zones, the plan is recomputed with those overrides applied first. The LM then checks whether left-to-right ordering within each zone minimises edge crossings.

It may return `SWAP_NODE_ORDER` or `SHIFT_ZONE` commands:

```json
{
  "swapCommands": [
    { "type": "SWAP_NODE_ORDER", "nodeA": "id1", "nodeB": "id2" },
    { "type": "SHIFT_ZONE", "nodeId": "id", "from": "above", "to": "left" }
  ],
  "rationale": "..."
}
```

`SHIFT_ZONE` is handled by `layoutContainerDiagram` the same way as `zoneOverrides` — removing the node from its current zone array and pushing it to the target zone.

### Applying overrides

All collected overrides are merged and written to `diagramModel._layoutOverrides`:

```js
diagramModel._layoutOverrides = {
  zoneOverrides: { ... },  // node ID → target zone
  swapCommands: [...]       // SWAP_NODE_ORDER | SHIFT_ZONE
}
```

This object is then passed into every subsequent `renderDiagram` call inside the optimisation loop, where `layoutContainerDiagram` applies it during Phase 2a.

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
- **SHIFT_ZONE not fully wired in routing pass:** `SHIFT_ZONE` commands from Checkpoint 2 are currently fed into `_layoutOverrides.swapCommands`, which `layoutContainerDiagram` ignores (it only processes `SWAP_NODE_ORDER` from `swapCommands`). A future pass should re-read `swapCommands` for `SHIFT_ZONE` and apply them as `zoneOverrides`.
- **Edge routing is heuristic:** The orthogonal router has no obstacle avoidance — it routes by spatial relationship only. Edges may still cross left/right overflow nodes if those nodes happen to sit in the same vertical band as a cross-boundary edge's path.
- **Post-render edge-to-edge scoring is limited:** The renderer's candidate scorer penalizes overlaps and crossings against already-routed edges, but the post-render geometric critic (`analyzeLayout` in `src/core/geometry.js`) still grades node overlaps, edge-node crossings, label-node overlaps, spacing, and aspect ratio. It does not currently fail tests on edge-edge crossings, so renderer changes that affect line corridors should still be reviewed visually.
