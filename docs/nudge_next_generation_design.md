# Nudge Next-Gen: Architecture Design Proposal

This document outlines a blueprint for redesigning Nudge from the ground up, resolving key pain points identified during layout optimization, connection line routing, and LLM orchestration.

---

## 1. Core Philosophy: Constraint-First, LLM-Steered

The current Nudge architecture splits layout into two worlds: flat diagrams use ELKjs, while container diagrams use a custom Kahn-layering pipeline. External entities are placed via ad-hoc heuristics and iteratively shifted. 

The next generation of Nudge should unify these under a **Constraint-First, LLM-Steered** model. The layout engine itself should operate as a mathematical solver (solving for relative node positions and grid routing), while the LLM behaves as a high-level creative director (suggesting ordering, grouping, and semantic alignments).

```
┌────────────────────────┐      Layout Instructions     ┌────────────────────────┐
│  LLM Creative Director │ ───────────────────────────> │   Deterministic Core   │
│  (Semantic Ordering,  │                              │  (Constraint Solver &  │
│   Zone Alignment)      │ <─────────────────────────── │   Orthogonal Router)   │
└────────────────────────┘        Geometry Critique     └────────────────────────┘
```

---

## 2. Pillar 1: A Unified Hierarchical Layout Engine

Instead of having separate layout logic for container diagrams (Kahn) and flat diagrams (ELK), Nudge Next-Gen will use a single **Hierarchical Constraint Solver**.

### Node Placement as a Constraint Satisfaction Problem (CSP)
* **Relative Constraints**: Relative positions (e.g., `A above B`, `C left of D`, `E inside Boundary X`) are represented as mathematical inequalities:
  $$y_B \ge y_A + \text{height}_A + \text{gap}$$
* **Deterministic Baseline**: A solver (like Bellman-Ford or a linear programming solver) computes the absolute coordinates of the boxes.
* **Unified Nesting**: Boundaries are not special cases; they are simply parent nodes that enforce containment constraints on their children.

---

## 3. Pillar 2: Grid-Based Lane & Port Resource Routing

In the current router, connection lines are routed using ad-hoc rules (Z-curves, message bus drops, external side entries) which are prone to overlaps (e.g., when a bottom connection overlaps with a downward drop). 

Nudge Next-Gen will treat routing as **Pathfinding over a Shared Resource Grid**.

```
          Target Entity
       ┌─────────────────┐
       │     [Port 1]    │
       └────────┬────────┘
                │ (Occupied Lane)
                ▼
```

### Port and Corridor Resource Map
1. **Ports as Resources**: Every face of a node has discrete ports (e.g., `bottom-1`, `bottom-2`, `right-1`). When an edge connects to a port, that port is marked **occupied**.
2. **Automatic Target-Face Checks**: Before any candidate route is generated, the router queries the port resource map. If the target's bottom face ports are occupied by a vertical drop, the routing grid blocks those ports for other connections, naturally redirecting them to the side faces.
3. **Orthogonal Grid Routing (A*)**: Connection lines are routed using an $A^*$ pathfinding algorithm on a dynamic grid. The cost function penalizes:
   * **Node Crossings**: $\infty$ cost.
   * **Edge-Edge Crossings**: High cost (e.g., $+200$).
   * **Edge Overlaps**: Medium cost (handled primarily by the nudging phase, see 3.4).
   * **Bends**: Low cost (e.g., $+40$ per bend).

### 3.1 Sparse Orthogonal Visibility Graph (not a uniform pixel grid)

The routing graph is **not** a uniform pixel/cell grid. It is a sparse **orthogonal visibility graph** in the style of libavoid (Wybrow, Marriott & Stuckey, *Orthogonal Connector Routing*): candidate grid lines are generated only at

* element face boundaries inflated by the routing clearance,
* element centre lines (so straight centre-to-centre drops exist in the graph), and
* channel midlines — the corridors between element rows/columns and around the boundary.

Graph vertices are the intersections of these lines; graph edges are the collision-free segments between adjacent intersections. This keeps the graph at hundreds of vertices for C4-scale diagrams (10–40 elements), produces routes that are naturally centred in lanes rather than snapped to arbitrary pixel rows, and gives the "lane" concept a first-class representation: a **channel** is a maximal run of parallel segments between two obstacles, with a known capacity.

### 3.2 Search State Includes Heading

A* state is **(vertex, heading)**, not just position. Bends can only be counted when the search knows the direction it arrived from, and port entry/exit constraints (e.g. "enter the top face heading south") are expressed as restrictions on the heading at terminal vertices. Without heading in the state, bend penalties are unimplementable and the router degenerates to shortest-path with staircase artifacts.

### 3.3 Routing Order and Rip-Up-and-Reroute

Crossing and overlap costs depend on connection lines that are already routed, so a single sequential pass has a first-mover problem: the first line takes the best corridor and later lines contort around it. The router therefore runs as:

1. **Order**: route connection lines hardest-first (longest Manhattan distance, most constrained ports, fewest candidate channels).
2. **Route**: A* each line against the obstacles plus the lines routed so far.
3. **Rip-up-and-reroute**: repeatedly select the worst-scoring routed lines, remove them, and re-route them against the rest. Accept only if the **global** route-set score improves. Iterate until convergence or an iteration cap.

This is the same control loop as the current `improveRoutedSections`/`evaluateRouteSet` pair — that logic carries over as the outer loop; only the inner per-line router changes from candidate enumeration to graph search.

### 3.4 Routing and Nudging Are Separate Phases

Per-pixel overlap penalties inside A* make costs path-dependent and unstable. Instead:

* **Routing phase**: lines may share a channel; sharing incurs only a mild congestion cost so the search prefers — but is not forced into — empty channels.
* **Nudging phase**: after all lines are routed, each channel orders the parallel lines passing through it and offsets them onto separated lanes (minimum gap apart), keeping endpoints fixed at their ports.

The current `reserveRouteLanes` interior-segment offsetting is a hand-rolled version of the nudging phase and its intent carries over directly.

### 3.5 Aesthetic Conventions as Cost Shaping

Rules that are early-returns in the current router — parent→database straight drops, stacked containers reading as a single vertical, message-bus side entries — become **cost discounts** (e.g. a strong negative cost for a bend-free centre-aligned drop) so the search prefers those shapes when they are achievable and degrades gracefully when they are not, instead of special-cased code paths that need escape hatches.

---

## 4. Pillar 3: Multi-Pass Reinforcement Critique Loop

Currently, Nudge runs a sequential one-pass visual-hint pipeline (Top Order $\rightarrow$ Port Hints $\rightarrow$ Diagonal Routes). If a step fails or is rejected, it cannot back-propagate.

Nudge Next-Gen will use a **Multi-Pass Critique Loop**:

```
        ┌───────────────┐     1. Initial Render     ┌─────────────────┐
        │   Parser /    │ ────────────────────────> │ Geometric Critic│
        │  Input Model  │                           │ (Detects Cross, │
        └───────────────┘                           │  Overlaps, Gap) │
                ▲                                   └────────┬────────┘
                │                                            │
        4. Apply Override                                    │ 2. Textual
        (Zone / Constraint)                                  │    Report
                │                                            ▼
        ┌───────────────┐  3. Suggest Corrections   ┌─────────────────┐
        │ Layout Solver │ <──────────────────────── │  LLM Optimizer  │
        └───────────────┘                           └─────────────────┘
```

1. **Text-Based Geometric Feedback**: The Critic analyzes the layout and produces a detailed text report:
   ```json
   {
     "collisions": [
       { "type": "edge_overlap", "edgeA": "aws_eventbridge->partner_sync_lambda", "edgeB": "partner_sync_lambda->database", "pixels": 55 }
     ]
   }
   ```
2. **LLM Reasoning**: The LLM reads the report and suggests **semantic** changes only — ordering, grouping, zone assignment, alignment of peers (e.g., `"SHIFT_ZONE of aws_eventbridge to right"`). The LLM never dictates geometry: port choice, bend placement, and lane assignment are the router's job. If the LLM has to force a port, the router has failed.
3. **Iterative Convergence**: The loop runs up to $N$ times until collisions reach $0$ or the layout score stops improving.
4. **LLM-Free Local Search First**: Because the core is deterministic and the constraint vocabulary is small, the loop can also run as plain local search — try $k$ constraint perturbations, keep the best-scoring render. The LLM acts as a semantic prior / tie-breaker, not a required component. This keeps `NUDGE_NO_LLM=1` runs strong, reproducible, and cheap.

---

## 5. Pillar 4: Sensible Defaults — Invariants, Conventions, Weights

Layout behaviour is organised into three explicit layers instead of being scattered through code paths:

1. **Invariants** (non-configurable, baked in): connection lines never cross architecture elements, children render inside their boundary, minimum element spacing. These are the $\infty$ costs and hard constraints — no flag can turn them off.
2. **Conventions** (defaults expressed as constraints, overridable per diagram): externals in the side zones, databases in bottom rows, message bus bottom-right, top-row ordering by connectivity. Today these are hardcoded placement logic; as default constraints they become things the LLM or a user can override without touching code. This also collapses the container/flat split — a flat diagram is simply one where fewer conventions fire.
3. **Aesthetic weights** (one small profile object): crossing $200$, overlap $100$, bend $40$, length $1$, straight-drop bonus, channel congestion. One documented place — replacing the current `_scoreBias` literals scattered across candidate generators — with optional per-diagram-type presets.

**Design test**: supporting a new element type or aesthetic preference must mean adding a constraint or a weight — never a new candidate generator or special-cased code path.

---

## 6. Migration Plan (No Big-Bang Rewrite)

The router is the highest-value, lowest-risk pillar and ships first, behind a flag:

1. **Baseline**: capture per-fixture math-scorer metrics across the full test corpus as a committed JSON snapshot (`test/fixtures/baselines/`). "Better" is defined numerically before any router code is written.
2. **Visibility graph module**: pure geometry (placed boxes in, graph out), unit-tested under `node --test`, inert until used.
3. **A\* router behind `NUDGE_ROUTER=grid`**: drop-in alternative to `routeEdge` (same contract: edge + placed boxes in, sections out).
4. **Corpus A/B**: render every fixture with both routers, diff against the baseline. Promote only when the grid router dominates. *(Done — crossings −76%, overlaps −25%, bends −25%, length −8%; grid is now the default, `NUDGE_ROUTER=legacy` opts out.)*
5. **Port the survivors**: `reserveRouteLanes` → channel nudging; `improveRoutedSections`/`evaluateRouteSet` → rip-up-and-reroute outer loop; aesthetic early-returns → cost discounts. *(Done, plus a kink-straightening pass for port-quantization Z-jogs.)*
6. **Delete** `route_candidate_rules.js` and its bias constants once promoted. *(Blocked until the multi-boundary placement fix lands: the legacy router is still the per-edge fallback for relationships whose endpoints are not placed leaf elements.)*
7. **Then** label-aware routing (reserve connection-label boxes during search), the conventions refactor of placement, and only afterwards revisit Pillar 1 unification — much of its motivation may evaporate once routing and conventions are clean.

---

## 7. Summary of Redesign Benefits

| Feature | Current Implementation | Proposed Next-Gen Redesign |
| :--- | :--- | :--- |
| **Diagram Engine** | Separate Kahn engine (containers) and ELKjs (flat). | Unified Constraint-Satisfaction Solver. |
| **Port Conflicts** | Ad-hoc checks (e.g., `targetHasConnectionsBelow`). | Port Resource Reservation Map. |
| **Line Routing** | Hardcoded candidate generators (Z-curves) with hand-tuned `_scoreBias` constants. | A* over a sparse orthogonal visibility graph, hardest-first order, rip-up-and-reroute, separate nudging phase. |
| **Parallel Lines** | `reserveRouteLanes` interior-segment offsets. | Channel-based lane assignment (nudging phase). |
| **Aesthetic Rules** | Early-return special cases per element type. | Cost shaping (discounts for preferred shapes). |
| **Defaults** | Behaviour scattered across code paths and bias literals. | Three layers: invariants / overridable conventions / one weights profile. |
| **LLM Integration** | One-pass sequential visual hints pipeline. | Closed-loop critique; LLM emits semantic constraints only, local search works LLM-free. |
