# Renderer Refactor Outstanding Task List

This is the current task list for completing the behavior-preserving renderer refactor described in `docs/renderer_refactor_blueprint.md`.

## Guardrails

- Preserve byte-for-byte parity: every fixture must report `json=same svg=same`.
- Run `npm run test:refactor` after every small slice. A green post-slice run is the baseline for the next slice.
- Do not run a separate pre-slice parity check unless the workspace state is unknown, such as at the start of a fresh session or after unrelated edits.
- Do not modify fixtures or weaken `test/refactor_test_rig.js`.
- Do not intentionally change renderer behavior.
- If parity fails, inspect `test_outputs/refactor_rig/refactor_test_results.json`, fix the candidate renderer, and rerun the rig before continuing.

## Current Checkpoint

- Last verified command: `npm run test:refactor`
- Last verified result: all 15 fixtures passed with `json=same svg=same`.
- Last verified slice: `transformToElkGraph` facade wrapper removed; ELK transform is called directly and `ranks` is assigned inline.
- Current facade: `src/render_engine.js` is now a small browser-facing file with public entrypoints and orchestration.
- Current module root: `src/renderer/`
- Known unrelated untracked file: `REFRAMING.md`.

## Completed Physical Module Moves

- [x] `src/renderer/namespace.js`
- [x] `src/renderer/shared/text.js`
- [x] `src/renderer/shared/geometry.js`
- [x] `src/renderer/elk/layout_policies.js`
- [x] `src/renderer/elk/elk_graph_transform.js`
- [x] `src/renderer/container/container_plan.js`
- [x] `src/renderer/container/plan_summary.js`
- [x] `src/renderer/container/utility_row_rules.js`
- [x] `src/renderer/container/container_layout.js`
- [x] `src/renderer/routing/route_geometry.js`
- [x] `src/renderer/routing/route_specifications.js`
- [x] `src/renderer/routing/route_candidate_rules.js`
- [x] `src/renderer/routing/connection_line_router.js`
- [x] `src/renderer/svg/architecture_element_shapes.js`
- [x] `src/renderer/svg/connection_line_rendering.js`
- [x] `src/renderer/labels/connection_label_placement.js`
- [x] `src/renderer/labels/connection_label_rendering.js`
- [x] `src/renderer/svg/svg_renderer.js`

## Immediate Next Slice

- [ ] Run final focused parser checks:
  - `node --check src/render_engine.js`
  - `node --check` on each file in `src/renderer/`
- [ ] Run `npm run test:refactor`.
- [x] Inspect `src/render_engine.js` for now-unnecessary wrapper comments or stale references.
- [x] Remove the now-unnecessary facade wrappers for `drawGraph`, `buildContainerZonePlan`, and `transformToElkGraph`, each as a separate parity-checked slice.
- [ ] Update this task list if any cleanup slice is intentionally deferred.

## Optional Cleanup Candidates

- [x] Decide whether to keep the thin local wrappers in `src/render_engine.js`.
  - Removed `buildContainerZonePlan`, `transformToElkGraph`, and `drawGraph` wrappers in separate parity-checked slices.
  - Keep `layoutContainerDiagram(diagramData)` in the facade because it is the main Container Layout Engine orchestration.

- [ ] Review comments in `src/render_engine.js`.
  - Keep comments that explain public orchestration.
  - Remove comments that describe implementation blocks now living in module files only if doing so is useful.
  - Do not reword route or label implementation comments during this behavior-preserving refactor unless they are clearly stale.

- [ ] Review script order in `src/render.html`.
  - Keep classic browser scripts.
  - Do not introduce ESM, bundling, dynamic imports, or build steps.
  - Current order should keep dependencies before `render_engine.js`.

- [ ] Review `test/refactor_test_rig.js`.
  - It currently copies `src/renderer/` into the candidate lane so physical module moves can be tested.
  - Do not otherwise weaken or normalize the rig.

## Final Validation

- [ ] `node --check src/render_engine.js`
- [ ] `find src/renderer -name '*.js' -print` and run `node --check` for every listed file.
- [ ] `npm run test:refactor`
- [ ] Optional broader suite: `npm test`

## Handoff Notes

- The refactor has preserved byte-for-byte parity after every module move.
- `src/render_engine.js` should remain the browser API facade exposing:
  - `window.renderDiagram(diagramData)`
  - `window.computeContainerPlan(diagramData)`
- Domain-facing names should continue to use the Ubiquitous Language:
  - Architecture Element
  - Relationship
  - Connection Line
  - Connection Label
  - Boundary
  - Utility Row
  - External Zone
  - Route Candidate
  - Route Intent
  - Lane Reservation
- Implementation identifiers such as `nodes`, `edges`, `children`, `sections`, `ports`, `x`, `y`, `width`, `height`, `layoutOptions`, and `ranks` should remain unchanged.
