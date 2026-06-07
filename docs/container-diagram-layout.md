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
[render.html] drawGraph()
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

### 1b: Boundary dimensions

```
bndW = max(layer widths) + 2 × B_PAD     (B_PAD = 50px each side)
bndH = sum(layer heights) + (layers-1) × V_GAP + B_PAD + B_BOT
```

Constants:
| Constant | Value | Purpose |
|----------|-------|---------|
| `H_GAP`  | 80px  | Horizontal gap between nodes in the same layer |
| `V_GAP`  | 80px  | Vertical gap between layers |
| `B_PAD`  | 50px  | Boundary padding — left, right, and top |
| `B_BOT`  | 84px  | Bottom clearance for the boundary label area |

### 1c: Child positions (relative to boundary)

Each layer is centred horizontally inside the boundary. Positions are stored in `childPos[id]` as offsets relative to the boundary's top-left corner.

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

**Override support (`_layoutOverrides`):**  
After the base classification, any `zoneOverrides` map from `diagramModel._layoutOverrides` is applied — each entry moves a node out of its current zone and into the specified one. Then `swapCommands` of type `SWAP_NODE_ORDER` reorder within each zone's array.

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

| Spatial relationship | Route shape |
|----------------------|-------------|
| Target directly below source | L-shape: source bottom → horizontal jog at midpoint → target top |
| Target directly above source | L-shape: source top → horizontal jog at midpoint → target bottom |
| Source and target are vertically aligned (centres within 3px) | Straight vertical line, no bend points |
| Same horizontal band | Straight horizontal line from side edge to side edge |
| Fallback (none of the above) | U-shape arcing above both nodes |

Bend points are post-processed by `renderEdges` into SVG quadratic bezier curves with a 10px corner radius to remove sharp kinks.

---

## LM Checkpoint Pipeline

**File:** `src/cli.js`  
**Functions:** `getLLMZoneVerification`, `getLLMRoutingVerification` (both in `src/critic.js`)  
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
