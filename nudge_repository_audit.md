# Nudge Repository Audit & Security Review

This audit assesses the layout optimizer tool **Nudge** to ensure it is 100% fit for public consumption and professional sharing on LinkedIn. The review covers codebase architecture, security/privacy, repository hygiene, and developer experience.

---

## Executive Summary

Nudge is an innovative local tool combining deterministic graph rendering (ELKjs + a custom positioning pipeline) with a feedback loop driven by a local LLM. The core concept is excellent, and the codebase separation between the CLI wrapper, the MCP server, and the layout runner is modular.

However, several **Blockers** must be resolved before sharing this repository publicly:
1. ~~**Playwright Browser Leaks**: Browser instances are launched without a guarantee of closure (no `finally` block). Failures or cancellations will leak zombie Chromium processes.~~ (✅ **RESOLVED**)
2. ~~**Cancellation Loop Waste**: While the LLM fetch is aborted, the main iteration loop does not check the abort signal and runs to completion, wasting CPU and I/O.~~ (✅ **RESOLVED**)
3. ~~**No Integration/Critic Tests**: The test suite bypasses the actual optimization loop, rendering diagrams only once. The AI-critic portion is completely untested.~~ (✅ **RESOLVED**)
4. ~~**Local Paths in Untracked Log**: `output.log` contains absolute local user paths and is not ignored by `.gitignore`.~~ (✅ **RESOLVED**)
5. ~~**No Before/After Visuals**: The documentation lacks a side-by-side visual demonstration showing native Mermaid layouts vs. Nudge's corrected layouts.~~ (✅ **RESOLVED**)

---

## 1. Architectural & Code Quality Critique

### ✅ RESOLVED: Playwright Browser Leak on Failure
In [optimizer.js](file:///Users/admin/Projects/nudge/src/core/optimizer.js), `chromium.launch` was previously called without a `try...finally` block, leaving the headless Chromium process running on failures. 
* **Fix Applied**: Wrapped the entire layout optimization pipeline inside a `try...finally` block that guarantees `await browser.close()` is called on success, error, or cancellation.

### ✅ RESOLVED: Incomplete Cancellation Handling in Optimization Loop
Previously, if a request was cancelled, the loop in [optimizer.js](file:///Users/admin/Projects/nudge/src/core/optimizer.js) would proceed to subsequent iterations even if the LLM fetch calls rejected, causing resource waste.
* **Fix Applied**: Added `signal?.aborted` checks at the entry point of the optimization flow, before/after LLM zone checkpoints, and at the start and end of every rendering/critic iteration. The run now aborts immediately and cleans up resources.

### ✅ RESOLVED: Separation of Concerns in `critic.js`
The original `critic.js` file mixed:
1. Deterministic geometry math functions (`lineSegmentsIntersect`, `boxesOverlap`, `analyzeLayout`).
2. Async network clients for OpenAI-compatible completions.
* **Fix Applied**: Removed `critic.js` and split the logic into two modular files under `src/core/`:
  - [geometry.js](file:///Users/admin/Projects/nudge/src/core/geometry.js): Pure geometric algorithms and layout critique checks.
  - [llm_client.js](file:///Users/admin/Projects/nudge/src/core/llm_client.js): Stateless client logic for local/remote LLM interactions.
All imports in [optimizer.js](file:///Users/admin/Projects/nudge/src/core/optimizer.js) and [run_tests.js](file:///Users/admin/Projects/nudge/test/run_tests.js) have been updated accordingly.

### 🟡 Enhancement: Brittle Parameter Parsing for System-level C4 Macros
In [mermaid_parser.js](file:///Users/admin/Projects/nudge/src/mermaid_parser.js#L114-L142), the argument tokenizer parses macro parameters:
```javascript
const [id, label, descOrTech, descAfterTech] = args;
```
For standard C4-Mermaid macros:
- `Container(id, label, tech, desc)` has `tech` in position 3 and `desc` in position 4.
- `System(id, label, desc)` has `desc` in position 3, and no `tech` field.
The parser currently processes both using the same logic: if there is a 4th argument (like `System(admin, "Admin", "Manages users", "sprite")`), the parser incorrectly sets `tech = "Manages users"` and `description = "sprite"`.
* **Recommendation**: Differentiate node extraction based on whether the macro type natively supports a technology field.

---

## 2. The "Public Shame" & Security Audit

### ✅ RESOLVED: Untracked `output.log` exposing Local System Paths
Previously, a local run log `output.log` containing absolute system paths was untracked but not ignored.
* **Fix Applied**: Added `output.log` and `*.log` to [.gitignore](file:///Users/admin/Projects/nudge/.gitignore) so log files generated during development are never accidentally staged.

### ✅ RESOLVED: Lacking API Key Support for Hosted/Remote LLMs
Previously, Nudge only sent default headers, preventing users from authenticating against remote paid/cloud endpoints (like OpenAI or OpenRouter).
* **Fix Applied**: Added a `getHeaders()` helper function in [llm_client.js](file:///Users/admin/Projects/nudge/src/core/llm_client.js#L5) that automatically appends `Authorization: Bearer <key>` using `NUDGE_LLM_API_KEY` or `OPENAI_API_KEY` environment variables if present. If no key is set, local endpoints continue to function without any changes.

---

## 3. Repository Hygiene & Production Readiness

### ✅ RESOLVED: Major Test Suite Gaps (No Critic Loop Tests)
Previously, the test runner only executed standard rendering calls in the page, leaving the actual iterative critic loop completely uncovered.
* **Fix Applied**: Added a fully mocked, offline-deterministic integration test (`runIntegrationTest`) in [run_tests.js](file:///Users/admin/Projects/nudge/test/run_tests.js). By dynamically intercepting and mocking `globalThis.fetch`, it feeds pre-defined layout parameter patches back into [optimizeDiagram](file:///Users/admin/Projects/nudge/src/core/optimizer.js), verifying that layout iterations are executed, spacing parameters are modified, and output assets are created, without relying on non-deterministic LLM behaviors.

### ✅ RESOLVED: Brittle Path Resolution in Tests
Previously, `src/render.html` was resolved relative to the current working directory, which would crash if the test suite was invoked from another folder.
* **Fix Applied**: Updated the resolution inside [run_tests.js](file:///Users/admin/Projects/nudge/test/run_tests.js) to resolve the template path relative to the module file itself via `new URL('../src/render.html', import.meta.url).href`.

### 🟡 Enhancement: Brittle postinstall Script
The `postinstall` script in `package.json` copies `elk.bundled.js` using a hardcoded path:
### ✅ RESOLVED: Brittle postinstall Script
Previously, the `postinstall` script in [package.json](file:///Users/admin/Projects/nudge/package.json) was hardcoded to look inside the physical `./node_modules/` path, which fails under advanced package managers like `pnpm` or `yarn`.
* **Fix Applied**: Updated the command to resolve `elkjs` dynamically using `require.resolve('elkjs/lib/elk.bundled.js')`. This dynamically resolves the module path regardless of the package hoisting strategy or manager in use.

---

## 4. Documentation & Developer Experience (DX)

### ✅ RESOLVED: Missing Before/After Visual Comparison
Previously, the README lacked a side-by-side visual demonstration proving the layout optimization quality.
* **Fix Applied**: Updated the [README.md](file:///Users/admin/Projects/nudge/README.md) to render a side-by-side Markdown comparison table. It visually contrasts native Mermaid's raw layout results ([MermaidBefore.png](file:///Users/admin/Projects/nudge/docs/MermaidBefore.png)) against Nudge's layout result ([search_service_container.png](file:///Users/admin/Projects/nudge/docs/search_service_container.png)), showing a clear resolution of overlaps and crossings.

### 🟡 Enhancement: Missing Custom LLM configuration docs
The README instructs users to download Gemma, but does not document:
- The `NUDGE_LLM_MODEL` environment variable.
- How to route request authentication (once API keys are implemented).

---

## Prioritized Action Plan

### Phase 1: Blockers (Must Fix before LinkedIn Share)
1. **[optimizer.js](file:///Users/admin/Projects/nudge/src/core/optimizer.js)**: Wrap browser in `try ... finally` block.
2. **[optimizer.js](file:///Users/admin/Projects/nudge/src/core/optimizer.js)**: Add checks for `signal?.aborted` to short-circuit the loop immediately.
3. **[.gitignore](file:///Users/admin/Projects/nudge/.gitignore)**: Add `output.log` and `*.log` to prevent local system paths from being checked in.
4. ~~**[test/run_tests.js](file:///Users/admin/Projects/nudge/test/run_tests.js)**: Add an integration test that runs the full `optimizeDiagram` function.~~ (✅ **RESOLVED**)
5. ~~**[README.md](file:///Users/admin/Projects/nudge/README.md)**: Generate and display a "Before vs After" visual comparison.~~ (✅ **RESOLVED**)

### Phase 2: Enhancements (Post-launch Iterations)
1. ~~**[package.json](file:///Users/admin/Projects/nudge/package.json)**: Update `postinstall` to use `require.resolve('elkjs/lib/elk.bundled.js')`.~~ (✅ **RESOLVED**)
2. ~~**[llm_client.js](file:///Users/admin/Projects/nudge/src/core/llm_client.js)**: Add `Authorization: Bearer` headers powered by `NUDGE_LLM_API_KEY` or `OPENAI_API_KEY`.~~ (✅ **RESOLVED**)
3. **[mermaid_parser.js](file:///Users/admin/Projects/nudge/src/mermaid_parser.js)**: Refine macro parameter parsing based on specific node types (`System` vs `Container`).
4. ~~**[critic.js](file:///Users/admin/Projects/nudge/src/critic.js)**: Split geometry algorithms and LLM calls into modular files.~~ (✅ **RESOLVED**)
