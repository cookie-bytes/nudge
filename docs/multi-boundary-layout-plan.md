# Implementation plan — multi-Boundary layout

Status: **plan — no layout code changed** (2026-07-26)
Branch so far: `feat/multi-boundary-grid-routing` (measurement + ratchet landed; layout not started)
Supersedes the framing of [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) INC-20, and is a prerequisite
for it and for INC-15.

---

## 1. What this fixes, measured

The container layout engine plans **exactly one Boundary**. `container_plan.js`
(`buildContainerZonePlan`) starts with:

```js
const boundaryNode = (diagramData.nodes || []).find(n => n.type === 'boundary');
const children = boundaryNode.children || [];
```

Everything downstream — Kahn layering, Utility Rows, External Zones, boundary sizing, the
router's obstacle set — is derived from that one node's direct children. Anything else is never
placed and never drawn, while the relationships pointing at it are still emitted and routed to
coordinates that mean nothing.

Measured over the 43-fixture corpus (`test/integration/element_coverage.test.js`):
**22 dropped elements across 4 fixtures** (2 diagrams × 2 notations).

| Fixture | Dropped | Renders as |
| --- | --- | --- |
| `multi_boundary_cross_parent_routes` | 6 of 12 — `platform` and all five children (`accounts`, `orders`, `events`, `accountsDb`, `ordersDb`) | The second Boundary is absent entirely; four labelled arrows dangle into the top-left corner |
| `nested_boundary_characterization` | 5 of 10 — every leaf child of both sub-Boundaries (`api`, `commands`, `accounts`, `ledger`, `ledgerDb`) | `core` and `edge` render as **empty 200×80 default boxes**; `bank` contains nothing |

Both fixtures graded **PASSED** before the coverage ratchet landed, because every quality metric
is computed over the elements that did render. Silently deleting user content was the one outcome
nothing measured.

### This reframes INC-20

INC-20 reads the 28 legacy-router fallbacks as a routing-quality problem and sets "zero fallbacks"
as the criterion for deleting the legacy router. All 28 are in these two diagrams, and the cause is
not that the grid router routes them badly — **their endpoints are not in the obstacle set at all**,
because those elements were never laid out. `routeOne` returns null on
`obstacleById.get(e.from)`/`get(e.to)`, and the legacy fallback invents a route.

So the dependency order is: multi-Boundary **layout** → fallbacks reach zero → legacy router is
deletable. Not the other way round. INC-15 (router lateral clearance) also wants to come after
this, since these two fixtures carry the bulk of the corpus's remaining defects (16 and 18) and
their route geometry is currently meaningless.

---

## 2. Why this is not a small change

The single-Boundary assumption is not localised to the one `find()` call. Counted in source:

- **48** references to the singular `bndX` / `bndY` / `bndW` / `bndH` across `render_engine.js`
  and `container_layout.js`
- **16** references to the singular `boundaryNode` across `container_plan.js`,
  `container_layout.js`, `plan_summary.js` and `render_engine.js`
- The grid router takes a single `boundaryRect` and prices `borderCrossings` against it
  (`grid_connection_line_router.js`), so "inside the boundary" is currently a boolean, not a set

Total surface: `container_plan.js` (379), `container_layout.js` (343), `render_engine.js` (1,144).

This is the documented Known Limitation in
[container-diagram-layout.md](container-diagram-layout.md) ("Single boundary only … Nested
boundaries are not supported in container mode") and it is Pillar 1 of
[nudge_next_generation_design.md](nudge_next_generation_design.md). Treat it as a multi-session
change, not a patch.

---

## 3. Target design

Two independent capabilities. **Ship them separately** — nested is materially easier and delivers
a whole fixture on its own.

### 3a. Nested Boundaries — flatten, then derive the sub-Boundary rectangle

A sub-Boundary carries no layout information of its own; it is a *grouping annotation* over its
leaf elements. So do not lay it out — lay out the leaves and infer the box:

1. Flatten the Boundary tree so the planned `children` are always **leaf elements**, each tagged
   with its ancestor chain (`_boundaryPath: ['bank', 'core']`).
2. Run the existing single-Boundary pipeline unchanged over that flat child list — Kahn layering,
   Utility Rows, everything. This is why nested is the cheaper half: the interior algorithm does
   not change at all.
3. Add a **grouping constraint** to layer ordering so siblings of the same sub-Boundary stay
   contiguous within a layer. Without it the derived rectangles interleave and the grouping reads
   as noise.
4. After placement, derive each sub-Boundary's rectangle as the union of its descendants' boxes
   plus padding, and draw it *behind* the elements.

Risk: step 3 is a real constraint on the barycenter ordering and can fight the existing
connectivity sort. If they conflict, prefer grouping — a sub-Boundary that does not visually
contain its children is worse than one extra crossing.

### 3b. Sibling Boundaries — interior layout, then a meta-layout over super-nodes

1. Run the interior layout **once per Boundary**, independently, producing a sized box per
   Boundary. The existing code already does exactly this for one; the work is making it reentrant
   and free of module-level singular state.
2. Treat each sized Boundary as a **super-node** and run the *same* layering/ordering pass over
   the Boundary graph (a relationship between two Boundaries is any relationship between their
   descendants). Sibling Boundaries then stack by flow direction like elements do.
3. Place externals around the **union** of the placed Boundaries, reusing the External Zone
   classifier against the union rect.
4. Give the router a **set** of boundary rects instead of one, and price a border crossing per
   rect. A cross-parent relationship legitimately crosses two borders; an intra-Boundary line that
   leaves and re-enters should still be penalised.

Step 4 is the only router change, and it is small — `borderCrossings(seg, boundaryRect)` becomes a
sum over rects. **The router was never the problem.**

---

## 4. Staging, with a gate per stage

Every stage ends with `npm test` green and the coverage ratchet tightened, never loosened.

| Stage | Work | Done when |
| --- | --- | --- |
| **A** | Make the interior layout reentrant: `buildContainerZonePlan(diagramData, boundaryNode)` takes its Boundary as a parameter and holds no singular state. Pure refactor, still called once. | `npm run test:refactor -- --baseline-ref main` reports **no** SVG/JSON change on all 43 fixtures |
| **B** | Nested flattening (3a steps 1–2, no grouping constraint yet) | `nested_boundary_characterization` drops **0** elements; its `KNOWN_DROPPED` entry deleted |
| **C** | Grouping constraint + derived sub-Boundary rectangles (3a steps 3–4) | Every leaf renders inside its declared sub-Boundary rect — assert it, extending the existing boundary-containment invariant to ancestors |
| **D** | Boundary meta-layout (3b steps 1–3) | `multi_boundary_cross_parent_routes` drops **0** elements; `KNOWN_DROPPED` deleted, file removed |
| **E** | Router takes a set of boundary rects (3b step 4) | `router_coverage` fallbacks reach **0**, which fires its own deliberate failure naming the legacy files to delete |
| **F** | Delete the legacy router (INC-20's payoff) | ~1,800 lines and cost model #2 gone |

**Stage A is not optional and must land alone.** It is the only stage with a byte-parity gate
available, and it is what makes B and D tractable rather than entangled.

### Extend the property generator alongside B and D

`test/generators/diagram_generator.js` emits exactly one Boundary, so the 40-seed invariant sweep
covers none of this. Add sibling-Boundary and one-level-nested shapes to the generator **as each
capability lands** (not before — 38 red seeds would tell you nothing you do not already know). The
invariants that matter are already written: every child inside its boundary, every endpoint on its
element face, every segment axis-aligned.

Note the generator was itself inert until `ea1d414` — it emitted `source`/`target` where the
renderer reads `from`/`to`, so every generated relationship routed as a zero-length stub. Any
claim in IMPROVEMENT_PLAN about generated-corpus routing predates that fix.

---

## 5. Abort criteria

- **Stage A** shows any SVG diff on any fixture ⇒ the extraction changed behaviour. Revert and
  re-slice; do not accept "looks the same".
- **Stage C** cannot keep sub-Boundary children contiguous without raising corpus defects above the
  ratchet ⇒ stop and put the trade to a human. Grouping vs. crossings is a judgement call, and the
  severity model does not price "reads as a group".
- **Stage D** needs the interior layout to change (not just be called twice) ⇒ stop. That means the
  interior algorithm has a hidden dependency on being the only Boundary, which is a redesign and
  belongs with Pillar 1, not here.

---

## 6. Out of scope

Full Pillar 1 constraint-solver unification. This plan deliberately keeps the existing Kahn
interior layout and adds a meta-layout above it, because that reuses the part of the engine that
demonstrably works — 0 Element Overlaps across 43 fixtures and 40 generated diagrams. Revisit
unification only if the meta-layout proves insufficient.
