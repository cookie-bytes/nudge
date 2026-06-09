# Nudge 📐🤖

[![Tests](https://github.com/cookie-bytes/nudge/actions/workflows/test.yml/badge.svg)](https://github.com/cookie-bytes/nudge/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](package.json)

**AI-Driven Architecture Diagram Layout Optimizer**

Nudge automatically produces clean, publication-ready C4 Model architecture diagrams. It combines a deterministic custom layout engine for container diagrams with an iterative LLM feedback loop that detects and fixes geometric defects — overlapping components, edge-to-node crossings, and tight spacing — using locally-running AI.

Nudge runs as a **CLI tool** for direct use from the terminal, and as a local **MCP server** so LLM clients like Claude Desktop can call it as a tool — generating and optimizing diagrams in a single conversational step.

---

## Example Output

| Before (Mermaid C4 Baseline) | After (Nudge Optimized) |
| :---: | :---: |
| ![Core banking Mermaid baseline](docs/core-banking-single-boundary-before.png) | ![Core banking Nudge optimized layout](docs/core-banking-single-boundary.png) |

See the full comparison source in [docs/core-banking-single-boundary-comparison.md](docs/core-banking-single-boundary-comparison.md).

---

## How It Works

Nudge runs on a **Critic-Loop** architecture:

```mermaid
graph TD
    A[Input YAML or Mermaid] --> B[Parse Diagram Model]
    B --> C[LM Checkpoint Pipeline\ncontainer diagrams only]
    C --> D[Render Diagram in Playwright]
    D --> E[Geometric Critique Analyzer]
    E -->|Defects Detected?| F[Query LLM with Report & Options]
    F -->|JSON Layout Patch| G[Apply Parameters]
    G --> D
    E -->|No Defects or Max Iterations Met| H[Export SVG & PNG]
```

1. **Ingestion**: Parses C4 Context or C4 Container diagrams from `.mermaid` or `.yaml` specifications.
2. **LM Checkpoint Pipeline** *(container diagrams only)*: Before the optimization loop, two LLM checkpoints verify and correct zone assignments and node ordering — ensuring callers are above the boundary, callees below, and external nodes are ordered to minimise edge crossings.
3. **Rendering**: Playwright loads the diagram template and executes the layout pipeline:
   - **Flat diagrams (C4Context)**: Arranged dynamically via **ELKjs** (layered algorithm).
   - **Nested diagrams (C4Container)**: Arranged via a custom, deterministic **Container Layout Engine** (see below).
4. **Criticism**: Measures DOM bounding boxes to detect geometric defects (overlaps, edge-node crossings, edge-label collisions, aspect ratio). Container routing also scores candidate paths against already-routed edges to reduce stacked line corridors.
5. **Correction**: Feeds the critique report to a local LLM, requesting layout property adjustments or ordering swap overrides.
6. **Iteration**: Repeats up to 4 times or until a clean layout is produced. A best-effort SVG is always exported even if collisions remain.

---

## Layout Engines & Algorithms

Nudge uses two distinct engines depending on the C4 model type:

### 1. Flat C4 Context Layout (ELKjs)
Flat context diagrams are laid out using the **Eclipse Layout Kernel (ELKjs)** with a layered algorithm. The critic loop iteratively tunes layout properties like spacing, node distances, and routing directions by prompting the LLM.

### 2. Nested C4 Container Layout (Custom Engine)
Container diagrams containing boundary blocks bypass ELKjs entirely and use a custom deterministic layout pipeline:

- **Phase 1: Kahn Layering (Boundary Interior)**: Children of the boundary are sorted into horizontal layers using a modified Kahn's topological sort. Nodes receiving cross-boundary edges are automatically seeded as entry nodes in the top row (Layer 0); unconnected utility nodes are pushed down to minimise clutter. Cycles are silently broken by appending remaining nodes to a final layer.
- **Phase 2: Dedicated Utility Rows**: Message buses and databases are excluded from Kahn's sort and reinserted into purpose-built rows. Busy buses widen into clear spines; all message buses are corner-anchored in the bottom-right. Databases sit in tighter rows beneath their deepest contributing service.
- **Phase 3: Zone Classification & Connectivity Sorting**: External nodes are classified into layout zones — callers go **above**, callees go **below**, and overflow nodes spill into **left** and **right** columns. Each zone is automatically sorted by the average layer/column index of the internal nodes it connects to, so external nodes align visually with their counterparts inside the boundary with minimal edge crossings. LLM override commands (`zoneOverrides`, `SWAP_NODE_ORDER`, `SHIFT_ZONE`) from the checkpoint pipeline are applied on top of the automatic sort.
- **Phase 4: Hybrid Edge Routing**: Candidate routes are scored by node crossings first, then by a weighted mix of existing edge overlaps/crossings, bend count, and path length. This keeps direct-looking lines when they are clean, while choosing row-gap or gutter detours only when they avoid real conflicts. After the first route pass, interior lane reservation separates unavoidable shared corridors, and a conservative second pass reroutes only the worst edge-conflict offenders when the global score improves. Bend points are post-processed into broad SVG quadratic bezier curves so detours read as soft paths rather than rigid right-angle wiring.
- **Phase 5: Rule-Based Edge Label Placement**: Relationship labels are placed along the edge using four strategies evaluated in order: (0) straight-line midpoint, (1) target-anchored, (2) source-anchored, (3) edge-density-aware segment scoring. Every strategy checks for collision against node bounding boxes, source/target boxes, previously-placed labels, and nearby connection lines, so duplicate-text labels on co-terminal edges are separated and labels avoid busy corridors where possible. Long labels wrap automatically; technology notes (e.g. `[HTTPS]`) are rendered in a smaller, semi-transparent style beneath the main text.

### LM Checkpoint Pipeline (Container diagrams)
Before the 4-iteration optimization loop runs, two LLM checkpoints fire once:

- **Checkpoint 1 — Zone Verification**: The LLM reviews the computed zone plan and may issue `zoneOverrides` (move a node to a different zone) or `SWAP_NODE_ORDER` commands.
- **Checkpoint 2 — Ordering Verification**: If Checkpoint 1 changed any zones, the plan is recomputed first. The LLM then checks whether the left-to-right ordering within each zone minimises edge crossings, and may issue further `SWAP_NODE_ORDER` or `SHIFT_ZONE` commands.

All override commands are written to `diagramModel._layoutOverrides` and applied on every subsequent render pass.

---

## Features

- 🎯 **Automatic Defect Detection**: Finds overlapping components, intersecting arrows, edge-label collisions, and poor aspect ratios.
- 🔄 **Critic Loop**: Continuous optimization loop that improves layout quality iteratively (up to 4 passes).
- 🤖 **LM Checkpoint Pipeline**: Two pre-render LLM checkpoints verify and correct zone assignments and node ordering for container diagrams before the main loop begins.
- 🔌 **MCP Server**: Exposes an `optimize_diagram` tool over stdio so Claude Desktop and other MCP clients can generate and render diagrams conversationally.
- 🎨 **Supports Mermaid & YAML**: Seamless support for C4 diagrams in `.mermaid`/`.mmd` syntax and structured `.yaml` specifications.
- 📏 **Standardized Sizing & Grid**: All nodes are standardized to a width of `200px`. Heights: `200px` for Person, `140px` for Container/Database/External, `80px` for MessageBus — ensuring consistent alignment and a clean grid.
- 🧭 **Dedicated Bus & Database Rows**: Message buses and databases are separated from ordinary service layers, with message buses always anchored in the bottom-right and databases visually paired beneath their owner service.
- 💬 **3-Line Descriptions**: Node descriptions support a 3-line clamp, providing space for detailed technical notes without clipping.
- 🏷️ **Collision-Aware Label Placement**: Edge labels check four strategies sequentially — straight-middle, target-anchored, source-anchored, and edge-density-aware segment scoring. Each strategy checks for collision against node boxes, already-placed labels, and connection lines, preventing co-terminal labels from stacking and reducing label-edge intersections.
- 🔌 **Hybrid Edge Routing**: Cross-boundary and internal boundary edges compare direct, row-gap, and gutter candidates. Node crossings are avoided as a hard priority, while shared edge corridors and edge-edge crossings are reduced with weighted scoring, lane reservation, and bounded second-pass rerouting.
- 🌐 **Connectivity-Based Zone Sorting**: External nodes are auto-sorted to align with the internal layer or column they connect to, reducing edge crossings without LLM intervention.
- 🏠 **No Cloud Dependencies**: Runs fully on your machine using Playwright and a local LLM backend (like LM Studio). The layout engine (ELKjs) is bundled locally via `npm install` — no CDN calls at runtime.

---

## Prerequisites

Before using Nudge, make sure you have:

1. **Node.js**: Version 18 or newer.
2. **Playwright Browsers**: Required for rendering diagrams.
   ```bash
   npx playwright install chromium
   ```
3. **Local LLM Server**: A running OpenAI-compatible API server on `http://127.0.0.1:1234` (e.g., [LM Studio](https://lmstudio.ai/)).
   - **Recommended Models**: `google/gemma-2-9b-it`, `google/gemma-4-12b` or other reasoning models.

---

## Installation

```bash
git clone https://github.com/cookie-bytes/nudge.git
cd nudge
npm install
```

---

## Usage

### CLI

Start your local LLM server in LM Studio (default port `1234`), then run Nudge.

#### Configuration & Environment Variables

You can customize Nudge's layout tuning behavior and LLM connections using environment variables:

| Variable | Description | Default / Fallback |
|---|---|---|
| `NUDGE_LLM_API` | The base URL of your OpenAI-compatible API endpoint. | `http://127.0.0.1:1234` |
| `NUDGE_LLM_MODEL` | The model name Nudge should request. | `google/gemma-4-12b` |
| `NUDGE_LLM_API_KEY` | The API Key to send in the `Authorization` header. | *(none)* |
| `OPENAI_API_KEY` | Alternative API key if `NUDGE_LLM_API_KEY` is unset. | *(none)* |

**Examples:**
- **Local LM Studio/Ollama (Custom Port)**:
  ```bash
  export NUDGE_LLM_API=http://localhost:11434
  export NUDGE_LLM_MODEL=gemma2:9b
  ```
- **Remote Hosted API (e.g., OpenRouter / OpenAI)**:
  ```bash
  export NUDGE_LLM_API=https://openrouter.ai/api/v1
  export NUDGE_LLM_MODEL=google/gemma-2-9b-it
  export NUDGE_LLM_API_KEY=sk-or-...
  ```

**Optimize the included Core Banking container diagram** (the example shown in the comparison above):
```bash
node src/cli/index.js test/core-banking-single-boundary.mermaid
```

**Run on any Mermaid or YAML file:**
```bash
node src/cli/index.js path/to/diagram.mermaid
node src/cli/index.js path/to/diagram.yaml
```

#### YAML Input Format

YAML is an alternative to Mermaid syntax that maps directly to Nudge's internal model. It gives you explicit control over node types, dimensions, and initial ELKjs layout parameters.

```yaml
title: "My System"
layoutOptions:
  "elk.algorithm": "layered"
  "elk.direction": "DOWN"
  "elk.spacing.nodeNode": "80"
  "elk.layered.spacing.nodeNodeBetweenLayers": "110"

nodes:
  - id: user
    label: "Customer"
    type: "person"          # person | container | database | message_bus | external
    description: "End user of the system"

  - id: api
    label: "API Gateway"
    type: "container"
    tech: "Node.js"
    description: "Routes requests to downstream services"

  - id: db
    label: "Postgres"
    type: "database"
    description: "Stores all persistent data"

edges:
  - from: user
    to: api
    label: "Sends requests [HTTPS]"
  - from: api
    to: db
    label: "Reads & writes"
```

See [`examples/`](examples/) for full working examples including container diagrams with boundary blocks.

**Outputs** are written to `.nudge/`:
- `iteration_N.png` — screenshot at each optimization pass
- `optimized.png` — final layout as PNG
- `optimized.svg` — final layout as a self-contained SVG with embedded styles
- `layout.cache.json` — final ELKjs parameter patch (C4Context diagrams)

**Run the test suite:**
```bash
npm test
```
Renders all diagrams in `test/` and grades them. If a local LLM is unavailable, grading falls back to a math-based scorer automatically — no test is skipped.

---

### MCP Server

Nudge exposes an `optimize_diagram` tool over stdio, compatible with Claude Desktop, Claude Code, and any MCP client.

#### Tool: `optimize_diagram`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | Mermaid C4Context/C4Container syntax or YAML diagram source |
| `format` | `"mermaid"` \| `"yaml"` | no | Auto-detected from content if omitted |

**Returns**: a JSON summary (`success`, `iterations`, `finalCollisions`) followed by a self-contained SVG string. A best-effort SVG is always returned even when collisions remain after 4 iterations.

#### Connecting to Claude Desktop

Add the following to your `claude_desktop_config.json` (on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nudge": {
      "command": "node",
      "args": ["/absolute/path/to/nudge/src/mcp/index.js"],
      "env": {
        "NUDGE_LLM_API": "http://127.0.0.1:1234",
        "NUDGE_LLM_MODEL": "google/gemma-4-12b"
      }
    }
  }
}
```

Quit and relaunch Claude Desktop after editing the config. Verify the server loaded by checking:
```bash
tail -20 ~/Library/Logs/Claude/mcp-server-nudge.log
```

#### Example prompt for Claude Desktop

```
You have access to the nudge MCP server with an optimize_diagram tool.

I want a C4 Container diagram for the following system:
[describe your system — services, databases, external users, integrations]

Steps:
1. Write the diagram as Mermaid C4Container syntax
2. Call optimize_diagram with that content
3. Return the SVG and summarise the result
```

Or to optimize an existing diagram directly:

```
Call the nudge optimize_diagram tool with this diagram and return the SVG:

[paste Mermaid or YAML here]
```

---

## Folder Structure

```
├── .nudge/                 # Output directory for rendered iterations and final exports
├── docs/                   # Documentation and example images
├── examples/               # Example C4 model YAML and Mermaid diagrams
├── scripts/                # Developer utilities for iterating on SVG symbol designs
├── src/
│   ├── core/
│   │   ├── optimizer.js    # Shared optimization loop — called by both CLI and MCP
│   │   ├── geometry.js     # Pure geometric algorithms: overlap, intersection, label placement
│   │   └── llm_client.js   # Stateless LLM API client — zone/routing/optimization calls
│   ├── cli/
│   │   └── index.js        # CLI entry point — argument parsing, file I/O, console output
│   ├── mcp/
│   │   └── index.js        # MCP stdio server — registers and handles optimize_diagram tool
│   ├── mermaid_parser.js   # Mermaid C4 syntax → internal JSON model
│   ├── render.html         # HTML shell loaded by Playwright — sources render_engine.js
│   ├── render_engine.js    # ELKjs layout engine + SVG renderer (window.renderDiagram)
│   └── utils.js            # fetchWithTimeout with cancellation signal support
├── test/                   # Test diagrams (.mermaid) and test runner
├── test_outputs/           # Rendered PNGs, SVGs, and test result summary from npm test
├── LICENSE
└── package.json
```

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code structure guidance, and PR guidelines.

---

## License

This project is licensed under the [MIT License](LICENSE).
