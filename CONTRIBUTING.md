# Contributing to Nudge

Thanks for your interest. Here's what you need to know.

## Dev setup

```bash
git clone https://github.com/cookie-bytes/nudge.git
cd nudge
npm install
npx playwright install chromium
```

A local LLM server is optional — tests fall back to a math-based scorer when one isn't running.

## Running tests

```bash
npm test
```

Tests render every `.mermaid` file in `test/` using Playwright + ELKjs, analyse the geometry, and grade the layout. If an OpenAI-compatible server is running on `localhost:1234` (or `$NUDGE_LLM_API`), it grades visually; otherwise it uses the built-in math scorer.

## Code structure

The codebase has three layers — changes should respect the boundaries between them:

- **`src/core/optimizer.js`** — The shared optimization loop. Called by both the CLI and the MCP server. Any change to the loop logic, iteration behaviour, or SVG export belongs here. Accept new behaviour via parameters rather than reading from `process.env` or `process.argv` directly.
- **`src/cli/index.js`** — Thin CLI wrapper. Should only handle argument parsing, file I/O, and console output. Business logic belongs in `core/`.
- **`src/mcp/index.js`** — MCP stdio server. Should only handle tool registration, request parsing, and response formatting. Business logic belongs in `core/`. Remember: stdout is sacred for the MCP JSON protocol — any logging must go to stderr.
- **`src/mermaid_parser.js`** — Converts Mermaid C4 syntax to the internal JSON model. Add test fixtures in `test/` to cover new node types or relationship forms.
- **`src/render.html`** — ELKjs layout engine + SVG renderer, evaluated in a headless browser via Playwright. The two-pass layout and port namespace quirks are documented in CLAUDE.md.
- **`src/critic.js`** — Geometric collision analysis and the LLM API client. All LLM functions accept `{ signal, timeout }` — keep this consistent if adding new LLM calls so the MCP cancellation chain stays intact.
- **`src/utils.js`** — `fetchWithTimeout` with external signal support. Don't add unrelated utilities here.

## Pull requests

1. Fork the repo and create a branch: `git checkout -b your-feature`
2. Make your changes and add or update tests in `test/`
3. Run `npm test` and confirm it exits `0`
4. Open a PR against `main` with a clear description of what changed and why

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include your input file + console output.

## Code style

- ESM throughout (`import`/`export`, no `require`)
- No build step — keep it that way
- Comments only when the *why* is non-obvious
