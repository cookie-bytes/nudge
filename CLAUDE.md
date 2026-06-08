# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                          # Install dependencies
npx playwright install chromium      # Required one-time browser setup
npm start                            # Run optimizer on examples/system_context.yaml
node src/cli.js <path/to/file>       # Run on a custom .mermaid, .mmd, or .yaml file
npm test                             # Run the test suite (renders all test/*.mermaid files)
```

Tests require a running local LLM server for LLM-based grading; if unavailable, they fall back to a math-based scorer. No test is skipped — the fallback is automatic.

## Architecture

Nudge is a **Critic-Loop optimizer**. Each iteration: parse input → render in headless browser → run geometric collision analysis → query LLM for an ELKjs parameter patch → repeat (max 4 times).

### Data flow

1. **`src/cli.js`** — Entry point. Owns the optimization loop. Parses input (YAML via `js-yaml` or Mermaid via `mermaid_parser.js`), drives Playwright, calls `analyzeLayout` and `getLLMOptimizationPatch`, writes iteration PNGs and final outputs to `.nudge/`.

2. **`src/render.html`** — Loaded by Playwright as a `file://` URL. Contains ELKjs (CDN-loaded) and exposes `window.renderDiagram(diagramData)` which is called from Node via `page.evaluate(...)`. It runs a **two-pass ELK layout**: Pass 1 computes initial positions; Pass 2 refines port-side constraints for upward/backward edges. Returns absolute node bounding boxes and flattened edge sections back to Node.

3. **`src/critic.js`** — Stateless geometry analyzer (`analyzeLayout`) and LLM API client (`getLLMOptimizationPatch`). Detects: node overlaps, edge-node crossings, edge-label-node overlaps, and tight spacing (<45px). Calls the OpenAI-compatible LM Studio API at `http://localhost:1234` with a structured system prompt. Extracts the JSON patch from the LLM response via regex.

4. **`src/mermaid_parser.js`** — Converts Mermaid `C4Context`/`C4Container` syntax into the internal JSON model (`{ title, diagramType, layoutOptions, nodes, edges, rules }`). Supports `%% Rule: X above Y` comments for layout ordering constraints resolved via Bellman-Ford relaxation inside `render.html`.

### Key implementation details

**ELKjs port namespace quirk**: Port side properties must be set redundantly under three namespaces simultaneously — `properties["port.side"]`, `properties["org.eclipse.elk.port.side"]`, and `layoutOptions["port.side"]`/`layoutOptions["org.eclipse.elk.port.side"]` — and `portConstraints` must be set as `"FIXED_SIDE"` under all three namespaces (`elk.portConstraints`, `portConstraints`, `org.eclipse.elk.portConstraints`). This is required because ELKjs resolves property keys inconsistently depending on context.

**Port constraints are only applied to same-parent edges**: Cross-hierarchy edges (source and target with different parents) skip port assignment entirely to avoid ELK node resolution errors.

**Side ports for upward edges**: The two-pass layout exists because upward edges (where `rankSrc > rankTgt`) need their target port side set to EAST or WEST based on the *actual* rendered x-coordinates from Pass 1, not the hint coordinates.

**Diagram model format**: Both YAML and Mermaid inputs are normalised to the same `diagramModel` JSON schema before rendering. YAML files are loaded directly; Mermaid files are transformed by `parseMermaidC4`. The YAML schema mirrors the internal model directly (see `examples/system_context.yaml`).

**LLM response handling**: `critic.js` handles the case where `choice.message.content` is empty and falls back to `reasoning_content` — common with reasoning models in LM Studio.

**ESM**: The project uses `"type": "module"` — all files use `import`/`export`, no `require()`.
