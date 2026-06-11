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
   * **Edge Overlaps**: Medium cost (e.g., $+100$ per shared pixel, unless bundled).
   * **Bends**: Low cost (e.g., $+40$ per bend).

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
2. **LLM Reasoning**: The LLM reads the report and suggests logical changes (e.g., `"SHIFT_ZONE of aws_eventbridge to right"`, `"FORCE_PORT of partner_sync_lambda to right"`).
3. **Iterative Convergence**: The loop runs up to $N$ times until collisions reach $0$ or the layout score stops improving.

---

## 5. Summary of Redesign Benefits

| Feature | Current Implementation | Proposed Next-Gen Redesign |
| :--- | :--- | :--- |
| **Diagram Engine** | Separate Kahn engine (containers) and ELKjs (flat). | Unified Constraint-Satisfaction Solver. |
| **Port Conflicts** | Ad-hoc checks (e.g., `targetHasConnectionsBelow`). | Port Resource Reservation Map. |
| **Line Routing** | Hardcoded candidate generators (Z-curves). | Dynamic Grid Pathfinding ($A^*$ solver). |
| **LLM Integration** | One-pass sequential visual hints pipeline. | Closed-loop Multi-pass Critique feedback. |
