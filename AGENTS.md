# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm install                               # Install dependencies
npx playwright install chromium           # Required one-time browser setup
npm start                                 # Run CLI optimizer on examples/system_context.yaml
node src/cli/index.js <path/to/file>      # Run CLI on a custom .mermaid, .mmd, or .yaml file
node src/mcp/index.js                     # Start the MCP stdio server
npm test                                  # Run the test suite (renders all test/*.mermaid files)
```

Tests require a running local LLM server for LLM-based grading; if unavailable, they fall back to a math-based scorer. No test is skipped — the fallback is automatic.

## Architecture

Nudge is a **Critic-Loop optimizer** with two entry points — a CLI and an MCP server — sharing a common core layer.

```
src/
  core/optimizer.js     ← shared optimization loop
  core/geometry.js      ← geometric critic (overlaps, crossings, spacing)
  core/llm_client.js    ← LLM API client + checkpoint calls
  cli/index.js          ← thin CLI wrapper (reads file, logs to stdout)
  mcp/index.js          ← MCP stdio server (exposes optimize_diagram tool)
  mermaid_parser.js     ← Mermaid C4 → internal JSON model
  render.html           ← ELKjs layout engine + SVG renderer (loaded by Playwright)
  utils.js              ← fetchWithTimeout helper
```

Each iteration of the optimizer: parse input → render in headless browser → run geometric collision analysis → query LLM for an ELKjs parameter patch → repeat (max 4 times). Container diagrams also run a pre-render checkpoint pipeline for zone and ordering verification.

### Data flow

1. **`src/core/optimizer.js`** — The optimization loop. Accepts `{ diagramModel, outputDir, apiUrl, maxIterations, onLog, signal, checkpointTimeout, optimizationTimeout }`. Drives Playwright, calls `analyzeLayout`, `getLLMOptimizationPatch`, and the two checkpoint functions. Returns `{ success, history, svgContent, pngPath }`. SVG is always returned — on zero-collision success or as best-effort from the last rendered iteration. The `captureSvg` helper extracts both `#svg-root` innerHTML and the page's `<head><style>` block, embedding styles inline so the exported SVG is self-contained.

2. **`src/cli/index.js`** — Thin CLI entry point. Reads the input file from `process.argv[2]`, parses it, calls `optimizeDiagram`, prints the summary table, and exits with code 1 on failure. All logging goes to stdout via `onLog`.

3. **`src/mcp/index.js`** — MCP stdio server. Registers one tool: `optimize_diagram`. Accepts `{ content, format? }` — Mermaid or YAML diagram source, format auto-detected. Runs the optimizer in a temp directory, returns a JSON summary and the inline SVG in the tool response. All `console.log/warn/error` are redirected to stderr at startup to protect the stdio JSON protocol. Passes `extra.signal` (from the MCP SDK request handler) through to the optimizer so cancellation from the client aborts all in-flight LLM fetches immediately. Uses tighter timeouts than the CLI: 15 s for checkpoint calls, 20 s for optimization calls.

4. **`src/render.html`** — Loaded by Playwright as a `file://` URL. Bundles ELKjs locally (copied to `src/vendor/` on `npm install`). Sources `src/render_engine.js`, which exposes `window.renderDiagram(diagramData)` and `window.computeContainerPlan(diagramData)` called from Node via `page.evaluate(...)`.

5. **`src/render_engine.js`** — Browser-side renderer and layout engine. Flat diagrams use ELKjs. Container diagrams use a custom deterministic pipeline: Kahn layering, dedicated rows for message buses/databases, external zone classification, hybrid route scoring, SVG drawing, and label placement. Returns absolute node bounding boxes and flattened edge sections back to Node.

6. **`src/core/geometry.js`** — Stateless geometry analyzer (`analyzeLayout`). Detects node overlaps, edge-node crossings, edge-label-node overlaps, poor aspect ratio, and tight spacing (<45px).

7. **`src/core/llm_client.js`** — Stateless LLM API client (`getLLMZoneVerification`, `getLLMRoutingVerification`, `getLLMOptimizationPatch`, `getActiveModel`). All LLM functions accept `{ signal, timeout }` options — the signal is forwarded to `fetchWithTimeout` so the MCP cancellation chain reaches every fetch.

8. **`src/mermaid_parser.js`** — Converts Mermaid `C4Context`/`C4Container` syntax into the internal JSON model (`{ title, diagramType, layoutOptions, nodes, edges, rules }`). Supports `%% Rule: X above Y` comments for layout ordering constraints resolved via Bellman-Ford relaxation inside `render.html`.

9. **`src/utils.js`** — `fetchWithTimeout` helper. Accepts an optional external `signal` alongside the internal timeout; links them so whichever fires first aborts the fetch.

### Key implementation details

**Cancellation chain**: `mcp/index.js` passes `extra.signal` → `optimizer.js` `signal` param → each `llm_client.js` function's `{ signal }` option → `fetchWithTimeout` `signal` option → linked to the internal timeout `AbortController`. Any upstream cancellation (Codex Desktop timeout or user cancel) immediately aborts all in-flight network calls.

**SVG style embedding**: `captureSvg(page, width, height)` in `optimizer.js` runs two Playwright calls in parallel — `page.locator('#svg-root').innerHTML()` and `page.evaluate(() => document.querySelector('head style')?.textContent)` — then wraps them into a self-contained `<svg>` with an inline `<style>` block. This is needed because the CSS classes (`.node`, `.boundary`, `.edge-line`, etc.) are defined in `render.html`'s `<head>`, not inside the SVG element itself.

**ELKjs port namespace quirk**: Port side properties must be set redundantly under three namespaces simultaneously — `properties["port.side"]`, `properties["org.eclipse.elk.port.side"]`, and `layoutOptions["port.side"]`/`layoutOptions["org.eclipse.elk.port.side"]` — and `portConstraints` must be set as `"FIXED_SIDE"` under all three namespaces (`elk.portConstraints`, `portConstraints`, `org.eclipse.elk.portConstraints`). This is required because ELKjs resolves property keys inconsistently depending on context.

**Port constraints are only applied to same-parent edges**: Cross-hierarchy edges (source and target with different parents) skip port assignment entirely to avoid ELK node resolution errors.

**Side ports for upward edges**: The two-pass layout exists because upward edges (where `rankSrc > rankTgt`) need their target port side set to EAST or WEST based on the *actual* rendered x-coordinates from Pass 1, not the hint coordinates.

**Container utility rows**: In `render_engine.js`, `message_bus` and `database` children are excluded from Kahn layering and reinserted afterward. Buses are always marked `_cornerAnchor` and right-aligned in the bottom-right corner; they are sized based on connectivity (3× width for 4+ connections, 2× for 3+ connections). Databases are placed in tighter rows beneath the deepest connected service, with direct parent→db vertical routing when column-aligned.

**Hybrid route scoring**: `routeEdge(e, idx)` builds route candidates and chooses with `chooseBestRoute`. Node crossings are the hard first priority. Candidate scores then weigh already-routed edge overlaps, already-routed edge crossings, bend count, and path length. `reserveRouteLanes` offsets only interior segments to separate unavoidable shared corridors, and `improveRoutedSections` reroutes the worst few offenders only when the global edge-quality score improves without adding node crossings or excessive route length. This is intentionally not a hard “no edge crosses another edge” rule; it reduces stacked corridors without forcing huge perimeter detours.

**Label placement**: Edge labels try midpoint, target-anchored, source-anchored, and segment-clearance positions. Fallback placement now checks all components, including source/target nodes, plus previously placed labels so labels do not settle on top of endpoint boxes.

**Diagram model format**: Both YAML and Mermaid inputs are normalised to the same `diagramModel` JSON schema before rendering. YAML files are loaded directly; Mermaid files are transformed by `parseMermaidC4`. The YAML schema mirrors the internal model directly (see `examples/system_context.yaml`).

**LLM response handling**: `src/core/llm_client.js` handles the case where `choice.message.content` is empty and falls back to `reasoning_content` — common with reasoning models in LM Studio.

**ESM**: The project uses `"type": "module"` — all files use `import`/`export`, no `require()`. The `postinstall` script uses an inline `node -e` with `require()` which is fine as it runs outside the module system.

**render.html path resolution**: `optimizer.js` resolves `render.html` using `new URL('../render.html', import.meta.url).pathname` so it works regardless of the working directory the process is invoked from.
