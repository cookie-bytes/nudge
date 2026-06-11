# Routing Improvement Plan

> [!NOTE]
> This improvement plan has been succeeded and implemented by the default **Grid-Based Connection-Line Router** (A* pathfinding over a sparse orthogonal visibility graph) with rip-up-and-reroute and channel nudging. The legacy candidate router described in Phase 2 and Phase 3 below is retained as a fallback for unplaced leaf elements or cross-hierarchy relationships.

This plan tracks the historical layout-quality improvements for container diagrams. The goal was to keep the soft, direct-looking routes while reducing visual conflicts in dense diagrams.

## Phase 1 — Edge Quality Metrics

Status: implemented.

Added deterministic diagnostics for:

- edge-edge crossings
- edge overlap count
- edge overlap pixels
- label-edge intersections
- route complexity, measured as total bends and total routed length

These metrics appear in test output and generated Markdown reports, but they do not fail tests initially. The first purpose is to create a stable before/after scoreboard for future routing changes.

## Phase 2 — Lane Reservation

Status: implemented.

Added conservative lane reservation for unavoidable shared horizontal and vertical corridors. When an interior route segment overlaps already-routed segments beyond a small threshold, the renderer tries compact offsets such as `0, -10, 10, -18, 18`.

This happens after route selection, so route scoring still chooses clean paths and lane reservation only separates unavoidable sharing. Endpoint segments are left anchored to avoid visually detaching arrows from their source or target nodes.

## Phase 3 — Second-Pass Rerouting

Status: implemented.

After all edges have a first route:

1. Score every edge against the complete routed graph.
2. Pick the worst few edge-conflict offenders.
3. Re-run route selection for only those edges while treating the rest of the graph as fixed.
4. Keep a reroute only if total edge-quality score improves.

This gives the renderer a local optimization loop without turning it into a full graph-routing engine. The first experiment keeps reroutes conservative: only the worst few edge-conflict offenders are retried, reroutes are rejected if they introduce extra node crossings, and total route length may not grow beyond a small bound.

## Later Ideas

- Expand explicit side/endcap port handling for databases and message buses beyond the current targeted hint support.
- Make high-connectivity bus placement depend on connection span and direction balance instead of a simple threshold.
- Add optional route style modes such as `direct`, `balanced`, and `avoid-conflicts`.

## Completed Follow-Up — Label Edge Avoidance

Status: implemented.

Label placement now records actual rendered label coordinates on returned edge labels and uses edge-density-aware fallback scoring. The test suite's label-edge metric therefore measures the labels that were actually drawn. Fallback label candidates penalize node collisions, already-placed label collisions, and intersections with other connection lines.

## Completed Follow-Up — Container Visual Hints

Status: implemented.

Container optimization now renders staged snapshots for `step_0_initial` and `step_1_label_hints`. The LLM reviewer calls `getLLMLabelPlacementHints` to suggest connection label placement overrides (`source` or `target`) for long or bent lines. Each candidate is accepted only when the geometry score is no worse than the current accepted state, keeping the hint pipeline conservative.

## Guardrails

- Do not implement a hard "no line crosses another line" rule. Crossings should be expensive, not impossible, because hard constraints can produce long, ugly perimeter routes.
- Keep node overlaps and edge-node crossings as the hard pass/fail criteria.
- Review fixture PNGs after every routing change, especially dense container diagrams.
