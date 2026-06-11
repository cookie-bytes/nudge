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
    │  → step_1_label_hints
    │  → accepts only score-improving _layoutOverrides.labelHints
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

### 2d: Grid-Based Orthogonal Edge Routing

Connection lines are routed using a deterministic grid-based router (in `grid_connection_line_router.js`) by default. This uses pathfinding over a sparse orthogonal visibility graph.

**Visibility Graph Construction:**
- The router constructs a **Sparse Orthogonal Visibility Graph** (in `visibility_graph.js`) where vertices are generated at inflated element boundaries, centerlines, and channel midlines to keep the search space compact and paths naturally centered.
- Obstacles (placed elements) are inflated by the routing clearance; vertices inside inflated obstacles are blocked.

**A* Pathfinding & Heading:**
- The router runs an **A\*** pathfinding algorithm over the visibility graph.
- The search state is a tuple of `(vertex, heading)`. Tracking the arrival heading allows the router to penalize bends as a first-class cost (e.g. $+40$ cost per bend).

**Port Reservation & Face Assignments:**
- Port slots on each face of a node are modeled as resources.
- Connecting to a port slot reserves it, raising the cost of reusing it for other connection lines to prevent overlapping drops.

**Hardest-First & Rip-Up-and-Reroute:**
- Edges are routed hardest-first based on their centre-to-centre Manhattan span.
- Once an initial pass is complete, the worst conflict offenders (measured by a global score weighing overlaps, crossings, and bends) are repeatedly ripped up and rerouted against current paths. A reroute is kept only if the global conflict score does not worsen.

**Channel Nudging & Straightening:**
- Once path topologies are established, a **channel nudging phase** offsets overlapping parallel segments within shared channels into separate lanes (using a minimum gap) while keeping endpoints fixed.
- Finally, minor kinks are straightened, and paths are drawn as standard straight line segments rather than bezier curves.

**Legacy Fallback & Override:**
- Edges that cannot be routed geometrically (such as cross-hierarchy relationships whose endpoints are not placed leaf elements) fall back to the legacy candidate router (`connection_line_router.js`) per edge.
- If needed, the entire routing pipeline can be forced back to the legacy router using the environment variable `NUDGE_ROUTER=legacy`.

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

### Stage 1 — Connection label placement hints

`getLLMLabelPlacementHints` reviews all connection lines in the diagram and suggests optimal placement overrides for their labels (`source`, `target`, or `middle`):

```json
{
  "suggestions": [
    {
      "edgeId": "edge_16",
      "placement": "source",
      "confidence": "high",
      "reason": "Very long route (2131px). Source placement is necessary to keep the label near the DRM Adapter before it traverses a large gap."
    }
  ],
  "rationale": "..."
}
```

Accepted overrides are written to:

```js
diagramModel._layoutOverrides.labelHints.edge_16 = "source";
```

The rendered candidate is saved as `step_1_label_hints.png` and accepted only if its score is no worse than the previous deterministic baseline.

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
- **Edge routing is grid-based pathfinding:** The grid router uses A* over a visibility graph, rip-up-and-reroute, and channel nudging to find optimal collision-free paths, falling back to legacy candidate routing when necessary. Crossings are expensive but not impossible, preventing long and visually awkward detours.
- **Post-render edge-to-edge scoring is observational:** The renderer uses edge-conflict scoring while choosing routes, and the test suite reports edge-edge crossings, overlaps, overlap pixels, label-edge intersections, bends, and route length. These metrics do not currently fail tests, so renderer changes that affect line corridors should still be reviewed visually.
