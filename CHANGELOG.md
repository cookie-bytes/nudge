# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning policy

Nudge follows [Semantic Versioning](https://semver.org/), with one clarification
that matters more than any other for a layout engine:

> **Changed layout output is not a breaking change.**

The semver surface is the **public API** (`src/index.js`: `renderDiagram`,
`parseDiagram`, `detectFormat`), the **CLI flags**, and the **MCP tool schema**.
The exact coordinates Nudge produces are not part of it. Improving layout means
moving pixels, and treating every pixel as a breaking change would mean either a
major bump per improvement or no improvements at all.

In exchange, **every release states its quality delta** against the checked-in
baseline in `test/fixtures/baselines/quality_baseline.json`, across all six
defect classes. If a release makes some diagram worse, that shows up here rather
than in a user's diagram.

Everything under `src/` other than `src/index.js` is internal and may change in
any release.

## [Unreleased]

### Added
- **Public API** (`src/index.js`) — `renderDiagram({ source, format }) → { svg, report }`,
  plus `parseDiagram` and `detectFormat`. Nudge can now be used as a library
  instead of only by shelling out to the CLI.
- **Quality ratchet** — a checked-in per-fixture defect vector covering all six
  defect classes. A change that fixes one diagram and worsens another can no
  longer merge silently. Regenerate with `npm run baseline:quality`.
- **Property-based invariant tests** over seeded generated diagrams, so edge
  cases are found before users draw them.
- **Determinism test** — the same fixture rendered twice on a fresh page must
  produce identical output.
- Counters for **Connection-Label Element Crossing** and **Label-Label Overlap**,
  the two defect classes that previously had none. All six classes are now
  reported by the CLI table, the MCP JSON summary and the optimizer history.
- `npm run baseline:quality` and `scripts/determinism_check.js`.
- **UNSATISFIABLE placement outcome.** When no label width and no position yields
  an in-canvas placement, Nudge now says so: the label is re-wrapped narrower,
  clamped inside the canvas, marked in the SVG and reported through `warnings`,
  instead of being drawn off the edge while reporting success.
- **External corpus** — 7 third-party C4 diagrams from C4-PlantUML's samples
  (MIT), so layout is no longer graded only against fixtures written here.
- **One declared severity ordering** (`src/core/severity.js`) shared by every
  Node-side scorer, replacing three separately tuned cost models.
- **Self-relationships now route as a loop** beside their element. The grid router
  previously refused them (a self-loop is a fixed shape, not a path search) and the
  legacy fallback drew a straight line from one bounding-box face to the opposite
  one — through the element the relationship belongs to.

### Changed
- 🔴 **Nudge is now explicitly a single-Boundary tool, and says so.** Diagrams with
  sibling or nested boundaries are **refused** with an actionable message naming the
  offending boundaries, instead of being partially drawn. Previously the engine laid
  out the first boundary and silently discarded everything else while still routing
  the relationships that pointed at the discarded elements: one corpus diagram
  rendered with 6 of 12 elements missing and four labelled arrows dangling into the
  corner, and reported success.

  This follows C4's own structure — a Container diagram zooms into one system, a
  Component diagram into one container — and matches observed usage: all 7
  third-party corpus diagrams declare exactly one boundary and none nest. The source
  keyword is not restricted: `System_Boundary`, `Container_Boundary` and
  `Enterprise_Boundary` all describe one boundary, so an `Enterprise_Boundary`
  wrapping plain systems still renders.

  **Migration:** split the diagram into one per system, or keep one boundary and
  declare the others as `System_Ext(...)` outside it. Affected input previously
  produced a diagram that was missing elements, so no correct output changes.

  **Quality delta:** corpus known defects **92 → 24** across 39 fixtures. 68 of those
  described the two unrenderable multi-boundary diagrams, now kept as rejection
  fixtures. Five of seven defect classes are zero corpus-wide; only Connection-Line
  Crossing (22) and Label-Line Intersection (2) remain — the two least severe in the
  declared ordering. Every information-destroying class is zero.
- **The grid router now routes every relationship Nudge accepts** (326/326, asserted
  absolutely). The legacy candidate router is dead code and `NUDGE_ROUTER=legacy` is
  slated for removal in a future release.
- **Text measurement is now pure JavaScript**, against a baked Outfit glyph table
  generated at install time, replacing canvas `measureText`. Layout no longer
  depends on a webfont arriving over the network, and the layout core is
  unit-testable without a browser. Agrees with Chromium to under 0.2 px; the
  36-fixture corpus rendered identically.
- **Connection Label scoring no longer double-charges label overlap.** Burying a
  label inside an architecture element correctly costs more than grazing another
  label; previously it cost less, so the placer preferred the worse defect.
- **`nudgeLabelVertically` → `nudgeLabelClear`** — the label rescue stage can now
  move on both axes, bounded to the diagram's content box.
- The container/context success gate now includes **Connection-Label Element
  Crossing**. It previously checked 2 of 6 defect classes, making the primary
  product's gate weaker than the little-used flat/ELK path.
- The visual test suite renders `test/fixtures/diagrams/refactor/` as well as
  `core/`, and no longer reports success via a grade clause that could never fail.
- `engines.node` is now `>=20` (was `>=18`, which is end-of-life). CI runs a
  20/22/24 matrix, caches the Playwright browser download, and runs the layout
  parity rig.
- `package.json` has a `files` allowlist. `npm publish` shipped 190 files
  including private tooling and the whole test corpus; it now ships 47.

### Quality delta

**Off-canvas Connection Labels eliminated: 6 → 0 across the fixture corpus, and
271 → 0 across the 40-seed generated corpus** (now an absolute invariant, not a
ratchet). A label that falls outside the canvas is clipped or invisible, so this
is the most severe class of label defect.

The declared cost: clamping those labels back inside puts them in occupied
space. `labelLabelOverlaps` 0 → 10 and `labelLineIntersections` 2 → 12, both
concentrated in the two hardest multi-boundary fixtures (since removed from the
corpus — see the single-Boundary change above). Total known defects
70 → 92 (the last +2 arrived with the new third-party corpus). By the declared
severity ordering this is a net improvement — an off-canvas label destroys
information, an overlapping one degrades readability — and every affected label
is marked `data-nudge-unsatisfiable` in the SVG and reported in `warnings`.

## [1.0.0]

Initial release.
