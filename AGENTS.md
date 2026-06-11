# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm install                               # Install dependencies
npx playwright install chromium           # Required one-time browser setup
npm start                                 # Run CLI optimizer on examples/search_service_container.mermaid
node src/cli/index.js <path/to/file>      # Run CLI on a custom .mermaid, .mmd, or .yaml file
node src/mcp/index.js                     # Start the MCP stdio server
npm test                                  # Run the full test suite (unit + integration + visual)
npm run test:unit                         # Run fast, isolated parser/geometry unit tests
npm run test:integration                  # Run CLI and MCP integration tests
npm run test:visual                       # Run rendering tests in Playwright with mathematical scorer
NUDGE_VISUAL_TEST=true npm run test:visual # Run rendering tests with optional LLM visual grading
npm run test:refactor                     # Run layout regression parity test against git baseline
```

`npm test` runs fast unit tests, integration tests (CLI & MCP server), renders every test diagram in Playwright, verifies boundary containment, and writes snapshots plus `test_outputs/test_results.md`. `NUDGE_VISUAL_TEST=true npm run test:visual` enables LLM visual grading; if the grader is unavailable it falls back to the math scorer. No test is skipped.

## Ubiquitous language

Use [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) as the canonical language for Nudge domain discussions, docs, issue writeups, PR descriptions, and user-facing explanations.

- Prefer **Architecture Element** over "node" when discussing diagram-domain concepts.
- Prefer **Connection Line** over "edge" when discussing the rendered visual line.
- Prefer **Relationship** for the semantic source-model connection between two architecture elements.
- Prefer **Connection Label** over "edge label".
- Prefer **Element Overlap**, **Connection-Line Element Crossing**, **Connection-Label Element Crossing**, **Connection-Line Crossing**, **Connection-Line Overlap**, and **Label-Line Intersection** for quality terms.
- Reserve **Node** and **Edge** for implementation-level graph, ELKjs, renderer, or code-identifier discussion.
- If a user uses a non-glossary or ambiguous term, translate to the canonical term when the meaning is obvious. Ask a short clarification question when it could mean multiple glossary concepts.
- When editing code, preserve existing code identifiers such as `nodes`, `edges`, `edgeQuality`, and CSS classes unless the task explicitly asks for a code rename.

## Architecture

Nudge is a **deterministic C4 layout engine with optional LLM enhancement**. It has two entry points — a CLI and an MCP server — sharing a common core layer.

```
src/
  core/optimizer.js     ← shared optimization loop
  core/geometry.js      ← geometric critic (overlaps, crossings, spacing)
  core/llm_client.js    ← LLM API client + visual hint/optimization calls
  cli/index.js          ← thin CLI wrapper (reads file, logs to stdout)
  mcp/index.js          ← MCP stdio server (exposes optimize_diagram tool)
  mermaid_parser.js     ← Mermaid C4 → internal JSON model
  render.html           ← HTML shell loaded by Playwright (sources render_engine.js and renderer/)
  render_engine.js      ← browser facade orchestration
  renderer/             ← browser-side layout and rendering modules
    container/          ← Kahn layering and container placement
    elk/                ← ELKjs integration for flat diagrams
    labels/             ← collision-aware label placement
    routing/            ← default grid-based A* router & legacy router
    svg/                ← shape rendering & SVG drawing
  utils.js              ← fetchWithTimeout helper
```

The renderer always produces a deterministic baseline. Container diagrams use the custom deterministic renderer plus an optional one-pass visual-hint pipeline: top-row order, port hints, and diagonal-route hints are tried as staged renders, and only non-worsening candidates are accepted. C4Context diagrams reuse the same pipeline: `normalizeDiagramModel` in `optimizer.js` wraps their internal architecture elements in a hidden synthetic boundary (`_synthetic: true`, never drawn) while persons and external systems stay outside in the external zones. Flat diagrams (no boundary, no person/external elements) use ELKjs; when LLM calls are enabled, the flat-diagram critic loop can ask for ELKjs parameter patches and repeat up to 4 times.

### Data flow

1. **`src/core/optimizer.js`** — The render/critique/export loop. Accepts `{ diagramModel, outputDir, apiUrl, maxIterations, onLog, signal, checkpointTimeout, optimizationTimeout, enhance }`. Calls `normalizeDiagramModel` first (diagram-type inference plus the synthetic context boundary), so the CLI and MCP entry points share the same model normalisation. Drives Playwright, calls `analyzeLayout`, runs the visual-hint pipeline for containers, and calls `getLLMOptimizationPatch` for flat diagrams only when LLM calls are enabled. Returns `{ success, history, svgContent, pngPath }`. SVG is always returned — on zero-collision success or as best-effort from the last rendered iteration. The `captureSvg` helper extracts both `#svg-root` innerHTML and the page's `<head><style>` block, embedding styles inline so the exported SVG is self-contained.

2. **`src/cli/index.js`** — Thin CLI entry point. Reads the input file from `process.argv[2]`, parses it, calls `optimizeDiagram`, prints the summary table, and exits with code 1 on failure. All logging goes to stdout via `onLog`.

3. **`src/mcp/index.js`** — MCP stdio server. Registers one tool: `optimize_diagram`. Accepts `{ content, format?, enhance? }` — Mermaid or YAML diagram source, format auto-detected. Runs the optimizer in a temp directory with `enhance: false` by default, returns a JSON summary and the inline SVG in the tool response. All `console.log/warn/error` are redirected to stderr at startup to protect the stdio JSON protocol. Passes `extra.signal` (from the MCP SDK request handler) through to the optimizer so cancellation from the client aborts all in-flight work immediately. Uses tighter timeouts than the CLI for future enhancement paths.

4. **`src/render.html`** — Loaded by Playwright as a `file://` URL. Bundles ELKjs locally (copied to `src/vendor/` on `npm install`). Sources `src/render_engine.js`, which exposes `window.renderDiagram(diagramData)` and `window.computeContainerPlan(diagramData)` called from Node via `page.evaluate(...)`.

5. **`src/render_engine.js`** — Browser-side renderer and layout engine. Flat diagrams use ELKjs. Container diagrams use a custom deterministic pipeline: Kahn layering, dedicated rows for message buses/databases, external zone classification, grid-based orthogonal line routing, SVG drawing, and label placement. It applies accepted `_layoutOverrides.internalOrder`, `_layoutOverrides.portHints`, and `_layoutOverrides.routeHints`, then returns absolute architecture element bounding boxes and flattened connection-line sections back to Node.js.

6. **`src/core/geometry.js`** — Stateless geometry analyzer (`analyzeLayout`). Detects element overlaps, connection-line element crossings, connection-label element crossings, poor aspect ratio, and tight spacing (<45px).

7. **`src/core/llm_client.js`** — Stateless LLM API client (`getLLMTopOrder`, `getLLMPortHints`, `getLLMDiagonalRouteHints`, `getLLMOptimizationPatch`, `getActiveModel`). All LLM functions accept `{ signal, timeout }` options — the signal is forwarded to `fetchWithTimeout` so the MCP cancellation chain reaches every fetch. Legacy zone/routing checkpoint helpers still exist in this file, but the active container optimizer uses the visual-hint functions.

8. **`src/mermaid_parser.js`** — Converts Mermaid `C4Context`/`C4Container` syntax into the internal JSON model (`{ title, diagramType, layoutOptions, nodes, edges, rules }`). Supports `%% Rule: X above Y` comments for layout ordering constraints resolved via Bellman-Ford relaxation inside `render.html`.

9. **`src/utils.js`** — `fetchWithTimeout` helper. Accepts an optional external `signal` alongside the internal timeout; links them so whichever fires first aborts the fetch.

### Key implementation details

**Cancellation chain**: `mcp/index.js` passes `extra.signal` → `optimizer.js` `signal` param → each `llm_client.js` function's `{ signal }` option → `fetchWithTimeout` `signal` option → linked to the internal timeout `AbortController`. Any upstream cancellation (Codex Desktop timeout or user cancel) immediately aborts all in-flight network calls.

**SVG style embedding**: `captureSvg(page, width, height)` in `optimizer.js` runs two Playwright calls in parallel — `page.locator('#svg-root').innerHTML()` and `page.evaluate(() => document.querySelector('head style')?.textContent)` — then wraps them into a self-contained `<svg>` with an inline `<style>` block. This is needed because the CSS classes (`.node`, `.boundary`, `.edge-line`, etc.) are defined in `render.html`'s `<head>`, not inside the SVG element itself.

**ELKjs port namespace quirk**: Port side properties must be set redundantly under three namespaces simultaneously — `properties["port.side"]`, `properties["org.eclipse.elk.port.side"]`, and `layoutOptions["port.side"]`/`layoutOptions["org.eclipse.elk.port.side"]` — and `portConstraints` must be set as `"FIXED_SIDE"` under all three namespaces (`elk.portConstraints`, `portConstraints`, `org.eclipse.elk.portConstraints`). This is required because ELKjs resolves property keys inconsistently depending on context.

**Port constraints are only applied to same-parent relationships**: Cross-hierarchy relationships (source and target with different parents) skip port assignment entirely to avoid ELK node resolution errors.

**Side ports for upward relationships**: The two-pass layout exists because upward relationships (where `rankSrc > rankTgt`) need their target port side set to EAST or WEST based on the *actual* rendered x-coordinates from Pass 1, not the hint coordinates.

**Container utility rows**: In `render_engine.js`, `message_bus` and `database` children are excluded from Kahn layering and reinserted afterward. Message buses are always marked `_cornerAnchor` and right-aligned in the bottom-right corner; they are sized based on connectivity (3× width for 4+ connections, 2× for 3+ connections). Databases are placed in tighter rows beneath the deepest connected container, with direct parent→database vertical routing when column-aligned.

**Grid connection-line routing (default)**: Connection lines are routed using A* pathfinding over a sparse orthogonal visibility graph (in `grid_connection_line_router.js`).
- **Sparse Visibility Graph**: Vertices are generated at inflated element boundaries, centerlines, and channel midlines to keep the search space small and routes centered.
- **Search State**: A* search state is `(vertex, heading)` to track and penalize bends.
- **Shared Port Resources**: Slots on faces are reserved on use, and face slot reuse incurs cost penalties.
- **Rip-Up-and-Reroute**: Runs hardest-first, then repeatedly rips up and reroutes worst-scoring edges against current paths to minimize global crossings, overlaps, and bends.
- **Nudging Phase**: Overlapping parallel segments in shared channels are separated into lanes.
- **Legacy Fallback**: The legacy candidate router (`connection_line_router.js`) is used as a fallback for edges whose endpoints are not placed leaf elements, or when explicitly requested via `NUDGE_ROUTER=legacy`.

**Label placement**: Connection labels try midpoint, target-anchored, source-anchored, and segment-clearance positions. Fallback placement now checks all architecture elements, including source/target elements, plus previously placed labels so labels do not settle on top of endpoint boxes.

**Container visual hints**: `optimizer.js` runs a single label placement optimization step (`step_1_label_hints.png`) on top of the deterministic baseline (`step_0_initial.png`). It calls `getLLMLabelPlacementHints` to get connection label placement suggestions (`source`, `target`, or `middle`) and accepts them if the layout geometry score does not worsen. LLM responses are saved to `visual_hints.json` when present. Set `NUDGE_NO_LLM=1` or leave `enhance: false` to keep the deterministic baseline and skip network calls. Product framing should treat these hints as optional polish on top of the deterministic baseline.

**Diagram model format**: YAML, Mermaid, and C4-PlantUML inputs are normalised to the same `diagramModel` JSON schema before rendering. YAML files are loaded directly; Mermaid files are transformed by `parseMermaidC4`; C4-PlantUML files are transformed by `parsePlantUMLC4`. The YAML schema mirrors the internal model directly (see `examples/system_context.yaml`).

**LLM response handling**: `src/core/llm_client.js` handles the case where `choice.message.content` is empty and falls back to `reasoning_content` — common with reasoning models in LM Studio.

**ESM**: The project uses `"type": "module"` — all files use `import`/`export`, no `require()`. The `postinstall` script uses an inline `node -e` with `require()` which is fine as it runs outside the module system.

**render.html path resolution**: `optimizer.js` resolves `render.html` using `new URL('../render.html', import.meta.url).pathname` so it works regardless of the working directory the process is invoked from.
