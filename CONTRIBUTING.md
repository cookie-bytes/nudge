# Contributing to Nudge

Thanks for your interest. Here's what you need to know.

## Dev setup

```bash
git clone https://github.com/cookie-bytes/nudge.git
cd nudge
npm install
npx playwright install chromium
```

A local LLM server is optional. The default test command uses deterministic math grading; the visual test mode can call an OpenAI-compatible LLM and falls back to math scoring when one is not running.

## Running tests

```bash
npm test                  # Run the full test suite (unit + integration + visual)
npm run test:unit         # Run fast unit tests (parser, geometry math)
npm run test:integration  # Run CLI and MCP integration tests
npm run test:visual       # Run visual Playwright-driven rendering tests
npm run test:refactor     # Run layout regression parity tests
```

`npm test` runs fast, Playwright-free unit tests first, followed by CLI and MCP server integration tests, and finally renders every `.mermaid` file in `test/fixtures/diagrams/core/` using Playwright, analyzing geometry, verifying boundary containment, writing PNG/SVG snapshots, and grading with the built-in math scorer. `NUDGE_VISUAL_TEST=true npm run test:visual` enables the optional LLM visual grader. If an OpenAI-compatible server is unavailable on `localhost:1234` (or `$NUDGE_LLM_API`), that grader falls back to the math scorer.

When changing `src/render_engine.js`, inspect the generated PNGs in `test_outputs/` as well as the console summary and `test_outputs/test_results.md`. The math scorer catches node overlaps, edge-node crossings, and boundary containment failures, while the report also includes observational edge-quality metrics: edge-edge crossings, edge overlaps, overlap pixels, label-edge intersections, bends, and route length.

## Code structure

The codebase has three layers — changes should respect the boundaries between them:

- **`src/core/optimizer.js`** — The shared optimization loop. Called by both the CLI and the MCP server. Flat diagrams use the iterative ELKjs critic loop here; container diagrams run the staged visual-hint pipeline here. Any change to loop logic, visual-hint acceptance, iteration behaviour, or SVG export belongs here. Accept new behaviour via parameters rather than reading from `process.env` or `process.argv` directly, except for established flags such as `NUDGE_NO_LLM`.
- **`src/cli/index.js`** — Thin CLI wrapper. Should only handle argument parsing, file I/O, and console output. Business logic belongs in `core/`.
- **`src/mcp/index.js`** — MCP stdio server. Should only handle tool registration, request parsing, and response formatting. Business logic belongs in `core/`. Remember: stdout is sacred for the MCP JSON protocol — any logging must go to stderr.
- **`src/mermaid_parser.js`** — Converts Mermaid C4 syntax to the internal JSON model. Add test fixtures in `test/` to cover new node types or relationship forms.
- **`src/render.html`** — HTML shell loaded by Playwright as a `file://` URL. Bundles ELKjs via `<script src="vendor/elk.bundled.js">` and sources the rendering engine.
- **`src/render_engine.js`** — ELKjs layout engine + SVG renderer. Exposes `window.renderDiagram` and `window.computeContainerPlan`. The custom container renderer applies `_layoutOverrides.internalOrder`, `_layoutOverrides.portHints`, and `_layoutOverrides.routeHints`. The two-pass ELK layout and port namespace quirks are documented in CLAUDE.md.
- **`src/core/geometry.js`** — Pure geometric algorithms for the post-render critic: overlap detection, segment-intersection, edge-node crossings, label-node crossings, and spacing warnings. No side-effects or network calls.
- **`src/core/llm_client.js`** — Stateless LLM API client for flat-diagram optimization and container visual hints (`getLLMTopOrder`, `getLLMPortHints`, `getLLMDiagonalRouteHints`). All functions accept `{ signal, timeout }` — keep this consistent if adding new LLM calls so the MCP cancellation chain stays intact.
- **`src/utils.js`** — `fetchWithTimeout` with external signal support. Don't add unrelated utilities here.

## Pull requests

1. Fork the repo and create a branch: `git checkout -b your-feature`
2. Make your changes and add or update tests in `test/`
3. Run `npm test` and confirm it exits `0`
4. For renderer changes, include before/after notes for at least the affected fixture PNGs.
5. Open a PR against `main` with a clear description of what changed and why

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include your input file + console output.

## Code style

- ESM throughout (`import`/`export`, no `require`)
- No build step — keep it that way
- Comments only when the *why* is non-obvious
