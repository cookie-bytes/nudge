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

## Making changes

- **Parser** (`src/mermaid_parser.js`) — converts Mermaid C4 syntax to the internal JSON model. Add test fixtures in `test/` to cover new node types.
- **Renderer** (`src/render.html`) — ELKjs layout + SVG output, evaluated in a headless browser. The two-pass layout and port namespace quirks are documented in CLAUDE.md (see project root if present) and in the file itself.
- **Critic** (`src/critic.js`) — geometric collision analysis and the LLM API client.
- **CLI** (`src/cli.js`) — orchestrates the optimizer loop.

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
