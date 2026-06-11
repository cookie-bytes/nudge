# Renderer Refactor Status And End Design

This document records the current state of the renderer refactor and the intended end design. It is a companion to `docs/renderer_refactor_blueprint.md` and `docs/renderer_refactor_todo.md`.

## Current Status

The physical module split is complete. `src/render_engine.js` is now a browser-facing facade, while renderer responsibilities live under `src/renderer/` as classic browser scripts attached to `window.NudgeRenderer`.

Latest verified checkpoint:

```text
npm run test:refactor
15 fixtures passed
json=same svg=same for every fixture
```

Last verified slice:

```text
window.NudgeRenderer.svgRenderer moved to src/renderer/svg/svg_renderer.js
```

No fixture files were modified. The refactor rig was updated earlier in the refactor to materialize `src/renderer/` for candidate renders; do not otherwise weaken or normalize it.

## Current File State

Primary facade:

- `src/render_engine.js`

Renderer modules:

- `src/renderer/namespace.js`
- `src/renderer/shared/text.js`
- `src/renderer/shared/geometry.js`
- `src/renderer/elk/layout_policies.js`
- `src/renderer/elk/elk_graph_transform.js`
- `src/renderer/container/container_plan.js`
- `src/renderer/container/plan_summary.js`
- `src/renderer/container/utility_row_rules.js`
- `src/renderer/container/container_layout.js`
- `src/renderer/routing/route_geometry.js`
- `src/renderer/routing/route_specifications.js`
- `src/renderer/routing/route_candidate_rules.js`
- `src/renderer/routing/connection_line_router.js`
- `src/renderer/routing/visibility_graph.js`
- `src/renderer/routing/grid_connection_line_router.js`
- `src/renderer/svg/architecture_element_shapes.js`
- `src/renderer/svg/connection_line_rendering.js`
- `src/renderer/svg/svg_renderer.js`
- `src/renderer/labels/connection_label_placement.js`
- `src/renderer/labels/connection_label_rendering.js`

Known unrelated untracked file:

- `REFRAMING.md`

## Facade Responsibilities

`src/render_engine.js` should remain small and own only browser-facing orchestration:

- initialize ELK;
- expose `window.renderDiagram(diagramData)`;
- expose `window.computeContainerPlan(diagramData)`;
- dispatch Boundary diagrams to the custom Container Layout Engine;
- dispatch flat diagrams to ELK graph transformation and ELK layout;
- preserve the second-pass side-port refinement for upward ELK Relationships;
- call `window.NudgeRenderer.svgRenderer.drawGraph(...)`;
- preserve the Playwright-facing return shape.

Current facade orchestration:

- `layoutContainerDiagram(diagramData)` orchestrates container layout using extracted modules.
- Boundary diagrams call `window.NudgeRenderer.containerPlan.buildContainerZonePlan(...)` directly.
- Flat diagrams call `window.NudgeRenderer.elkGraphTransform.transformToElkGraph(...)` directly and assign the returned `ranks` inline.
- Rendering calls `window.NudgeRenderer.svgRenderer.drawGraph(...)` directly.

## Module Responsibilities

### Shared

- `shared/text.js`: text measurement, wrapping, label constants, and `createConnectionLabel`.
- `shared/geometry.js`: point, segment, box, flattening, and intersection helpers.

### ELK

- `elk/layout_policies.js`: layout policies by diagram type.
- `elk/elk_graph_transform.js`: ELK graph transformation, hierarchy assembly, ranks, ports, ordering rules, and Relationship attachment.

The `ranks` mutation contract is intentionally explicit: the module returns `{ graph, ranks }`, and the facade assigns the returned `ranks` to the closure-level binding used by second-pass port refinement.

### Container

- `container/container_plan.js`: Boundary child discovery, Kahn layering, Utility Row insertion, External Zone classification, connectivity sort, and layout override application.
- `container/plan_summary.js`: summary data for `window.computeContainerPlan`.
- `container/utility_row_rules.js`: Message Bus width scaling and paired Utility Row detection.
- `container/container_layout.js`: Boundary sizing, child placement, external Architecture Element placement, geometry accessors, and output graph assembly.

### Routing

- `routing/route_geometry.js`: route point/section conversion and conflict geometry helpers.
- `routing/route_specifications.js`: bundle, reserved-drop, and direct-drop specifications.
- `routing/route_candidate_rules.js`: ordered Route Candidate generation (legacy).
- `routing/connection_line_router.js`: legacy router (`routeEdge`), route set evaluation, corridor assignment, lane reservation, and rerouting.
- `routing/visibility_graph.js`: sparse orthogonal visibility graph generator.
- `routing/grid_connection_line_router.js`: default grid-based A* router with rip-up-and-reroute and channel nudging.

The default A* grid router uses the visibility graph; the legacy candidate router remains as a fallback.

### SVG And Labels

- `svg/architecture_element_shapes.js`: Architecture Element shape strategies and text rendering.
- `svg/connection_line_rendering.js`: Connection Line path preparation, SVG path data, marker direction, and line rendering.
- `labels/connection_label_placement.js`: Connection Label candidates, scoring, collision checks, fallback placement, and final adjustment.
- `labels/connection_label_rendering.js`: Connection Label DOM rendering and placed-label bookkeeping.
- `svg/svg_renderer.js`: SVG layer clearing, title rendering, viewport setup, graph drawing, and traversal orchestration.

SVG DOM order, attributes, text content, class names, and label coordinates are byte-sensitive.

## Script Loading Model

`src/render.html` uses classic browser scripts. Keep this model until a separate behavior-changing task says otherwise.

Current intended script order:

```html
<script src="renderer/namespace.js"></script>
<script src="renderer/shared/text.js"></script>
<script src="renderer/shared/geometry.js"></script>
<script src="renderer/elk/layout_policies.js"></script>
<script src="renderer/elk/elk_graph_transform.js"></script>
<script src="renderer/container/container_plan.js"></script>
<script src="renderer/container/plan_summary.js"></script>
<script src="renderer/container/utility_row_rules.js"></script>
<script src="renderer/container/container_layout.js"></script>
<script src="renderer/routing/visibility_graph.js"></script>
<script src="renderer/routing/grid_connection_line_router.js"></script>
<script src="renderer/routing/route_geometry.js"></script>
<script src="renderer/routing/route_specifications.js"></script>
<script src="renderer/routing/route_candidate_rules.js"></script>
<script src="renderer/routing/connection_line_router.js"></script>
<script src="renderer/svg/architecture_element_shapes.js"></script>
<script src="renderer/svg/connection_line_rendering.js"></script>
<script src="renderer/labels/connection_label_placement.js"></script>
<script src="renderer/labels/connection_label_rendering.js"></script>
<script src="renderer/svg/svg_renderer.js"></script>
<script src="render_engine.js"></script>
```

## Validation Protocol

For any remaining cleanup slice:

1. Make one small change.
2. Run `node --check src/render_engine.js`.
3. Run `node --check` on any changed module file.
4. Run `npm run test:refactor`.
5. If parity fails, inspect `test_outputs/refactor_rig/refactor_test_results.json` before changing anything else.

Do not run a separate pre-slice parity check after a green post-slice run unless the workspace state is unknown.

## Remaining Work

The main module split is complete. Remaining work is optional cleanup and final validation:

- keep `layoutContainerDiagram(diagramData)` as facade orchestration;
- remove stale comments only where clearly useful;
- run parser checks across all renderer modules;
- run `npm run test:refactor`;
- optionally run `npm test`.

Do not combine cleanup with behavior-affecting changes.
