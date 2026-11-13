# Fix: Connection Label buried in an element when its channel is too narrow (candidate INC-23)

**What this is:** a ready-to-execute spec for a single engine fix, written in the same shape as
[label-orphaning-fix.md](label-orphaning-fix.md) so it can fold into
[IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) as INC-23 once scheduled.

**Size:** M. Two independent changes, each individually shippable. Both are guarded by the
quality ratchet; expect a `npm run baseline:quality` re-capture.

**Status: LANDED** 2026-07-29 against `main` (`030f155`) — A1 + B, plus one thing the
investigation did not predict (§7.1). Diagnosis below is preserved as written; see §7 for what
actually shipped and what it cost.

**Relationship to [label-orphaning-fix.md](label-orphaning-fix.md):** same root condition —
a Connection Label wider than the channel it must sit in — but the *opposite* outcome. There the
escape search found a clear cell far from the line (orphaned, scored clean). Here every escape
cell is blocked, so placement degrades onto the element (buried, scored as a class-3 defect).
The two docs describe the two branches of one missing capability: **the placer cannot make a
label narrower when the corridor is narrow**, so it has to pick between two bad ends. Fix B below
supplies that capability and closes both.

---

## 1. The symptom

Latest output: [`system_context_one_marketplace_2026-07-29T13-30-11.svg`](../../nudge-output/system_context_one_marketplace_2026-07-29T13-30-11.svg)
(source: `Projects/Temp/one_marketplace_context.mermaid`).

The relationship

```
Rel(dealer-auction, google-idp, "Authenticates via", "OIDC application selecting manheim IDP configuration")
```

renders its Connection Label at centre **x≈1071.4, y=470** — box `x 925.4 … 1217.4`,
`y 453 … 487`. Dealer Auction occupies `x 840 … 1040`, `y 440 … 580`, so **115px of the label
sits on top of Dealer Auction**, obscuring its title. This is a **Connection-Label Element
Crossing** — class 3 in [src/core/severity.js](../src/core/severity.js), inside the
information-destroying tier that `isClean` gates absolutely.

The critic sees it correctly:

```
[Critique] Collisions: 1 (0 overlaps, 0 edge crossings)
[Critique] 1 Connection-Label Element Crossing(s) — labels buried in elements.
│ 0 │ 1 │ 1 │ 0 │ 0 │ 1 │ 0 │ 1 │ 0 │ 0 │ '1.21' │ '140' │ '110' │
```

So this is not a scoring blind spot like the orphaning bug. The defect is measured, reported, and
shipped anyway — because placement has no move left that improves it.

## 2. Root cause

Five facts compose. All five were verified by driving the real placer directly with the geometry
from the rendered SVG; the trace reproduces the shipped position **bit for bit**
(`x 925.4285714285713, y 453, w 292, h 34`).

### 2.1 The label is 72px wider than its channel

The box is **292 × 34** (textWidth 272 + 2×`H_PAD`). The channel is Dealer Auction's right face
(`x=1040`) to Google IDP's left face (`x=1260`) — **220px**, routed as one straight segment
`M 1040 470 L 1260 470`. No x position on that segment avoids overlapping one of the two boxes.

The entire 272px comes from the technology string: `[OIDC application selecting manheim IDP
configuration]` measures 272px at 11px, and `"Authenticates via"` measures 88px.

### 2.2 Both anchor placements are structurally unavailable

`createAnchorCandidate` ([connection_label_placement.js:826](../src/renderer/labels/connection_label_placement.js))
computes `anchorDist = max(45, textWidth/2 + 20) + arrowClearance` → **156** (source) and **186**
(target, +30 for the arrowhead), then bails on `totalLen < 2 * anchorDist`. With `totalLen = 220`
against thresholds of 312 and 372, **both anchors return `false` before any scoring happens**.
The wider the label, the further out the anchor wants to sit, and the sooner the whole anchor
strategy switches itself off — exactly backwards for the case that needs it.

Trace: `anchor target = false`, `anchor source = false`, `clear midpoint = false`.

### 2.3 The fallthrough parks it dead centre

With every strategy refusing, `chooseInitialLabelPlacement` reaches
`findMiddleGutterPlacement` ([:978](../src/renderer/labels/connection_label_placement.js)),
which is the one path that returns a position unconditionally. It yields **(1150, 470)** — the
segment midpoint, buried in *both* elements.

### 2.4 The escape hatch is blocked by a boundary that is never drawn

`nudgeLabelClear` ([:1051](../src/renderer/labels/connection_label_placement.js)) then walks
±1..3 label-steps on both axes. **(1150, 356)** — box `y 339 … 373` — is clear of every
architecture element and would be accepted.

It is rejected because it clips the top border strip of `__context_boundary`.

This boundary is the **synthetic context boundary** that `normalizeDiagramModel`
([optimizer.js:185](../src/core/optimizer.js)) wraps around a C4Context's internal elements. It is
`_synthetic: true` and **is never drawn** — `architecture_element_shapes.js:176` returns early for
it. But `buildBoundaryBorderObstacles`
([svg_renderer.js:64](../src/renderer/svg/svg_renderer.js)) still emits four 24px-thick strips for
it. Measured here: boundary `(80, 360) 1040 × 554`, so

| strip  | extent |
|--------|--------|
| top    | `x 68 … 1132`, `y 348 … 372` |
| bottom | `x 68 … 1132`, `y 902 … 926` |
| left   | `x 68 … 92`,   `y 348 … 926` |
| right  | `x 1108 … 1132`, `y 348 … 926` |

Two consequences, both material:

- The **top** strip (`y 348 … 372`) is what rejects the (1150, 356) escape.
- The **right** strip (`x 1108 … 1132`) runs straight down the middle of the 1040…1260 channel,
  so it blocks on-line placements too — including the good ones that Fix B would otherwise
  produce (see §4.2).

`nudgeLabelClear` is also the **only** stage that treats a border strip as a hard blocker.
`rescueCost` ([:544](../src/renderer/labels/connection_label_placement.js)) deliberately separates
`buried * 100000` from `borderClips * 1500`, and `placementFailure` ([:657](../src/renderer/labels/connection_label_placement.js))
skips strips outright with the comment *"clipping one is cosmetic rather than
information-destroying"*. `nudgeLabelClear`'s `isClear` predicate is a plain boolean over the
combined obstacle list and never got that distinction.

### 2.5 The INC-16 re-wrap fallback cannot fire, and could not help if it did

Two independent blocks:

1. **It is not triggered.** `isUnplaceable` ([connection_label_rendering.js:197](../src/renderer/labels/connection_label_rendering.js))
   is `failure === 'off-canvas'`. The failure here is `buried in 'dealer-auction'`. INC-16 narrowed
   this deliberately and for good measured reasons — see §4.3.

2. **It would be a no-op.** `createConnectionLabel` ([shared/text.js:71](../src/renderer/shared/text.js))
   wraps the main text but measures the bracketed technology string as **one unbroken line**:

   ```js
   const mainLines = wrapText(match[1].trim(), maxWidth, 11);
   const techW = measureTextWidth(`[${match[2].trim()}]`, 11);
   const w = Math.max(...mainLines.map(l => measureTextWidth(l, 11)), techW);
   ```

   Measured across all four `REWRAP_WIDTHS`:

   | maxWidth | width | height |
   |----------|-------|--------|
   | 120 | 272 | 28 |
   | 92  | 272 | 28 |
   | 72  | 272 | 41 |
   | 56  | 272 | 41 |

   Width never moves, so the `dims.width >= attempt.textWidth` guard
   ([:206](../src/renderer/labels/connection_label_rendering.js)) skips every retry. `appendLabelText`
   ([:316](../src/renderer/labels/connection_label_rendering.js)) has the matching omission —
   it emits the technology string as a single `<text>` element regardless of `MAX_LABEL_WIDTH`.

**One-line summary:** the only lever that can fit a wide label into a narrow channel — making it
narrower — does not work on technology strings, and the only escape route left is blocked by the
border of a boundary that is never drawn.

## 3. Reproduction

```bash
NUDGE_NO_LLM=1 node src/cli/index.js ../Temp/one_marketplace_context.mermaid --out .nudge_repro
```

Reports `Label×Elem 1`. In `.nudge_repro/optimized.svg` the `edge-label-bg` rect is at
`x=925.4285714285713 y=453 width=292 height=34`, overlapping the Dealer Auction `node` rect at
`x=840 y=440 width=200 height=140`.

The placer can also be driven directly in Node (no Playwright) — `connection_label_placement.js`
and `shared/text.js` are pure since INC-9 — by feeding the element boxes, the route
`[{1040,470},{1260,470}]`, and the four synthetic-boundary strips from §2.4. That is how the
counterfactuals in §4 were measured, and it is the shape the regression test should take.

## 4. Candidate fixes

Measured outcomes for this label, all from the direct-drive trace:

| variant | final box | on its line? | outcome |
|---------|-----------|--------------|---------|
| today | `925.4, 453, 292 × 34` | on it, buried | **Label×Elem defect** |
| A only (strips soft) | `1004, 339, 292 × 34` | 97px above | clean, but detached |
| B only (tech wraps) | `1068.3, 408, 132 × 60` | touching, clips synthetic strip | clean |
| **A + B** | **`1084, 440, 132 × 60`** | **dead centre, in the channel** | **clean, first candidate tried** |

### Fix A — stop treating an undrawn border as an obstacle

Two nested scopes; take the narrow one first.

**A1 (narrow, preferred): exclude synthetic boundaries from `buildBoundaryBorderObstacles`.**
A border strip exists to stop a label sitting on a *drawn* boundary edge. `__context_boundary` is
never drawn, so its strips protect nothing and cost the placer four large forbidden regions —
one of which bisects the very channel in this bug.

*Prerequisite:* `flattenNodes` ([shared/geometry.js:43](../src/renderer/shared/geometry.js))
currently drops `_synthetic` when it copies node fields, so `buildBoundaryBorderObstacles` cannot
see it. Propagate the flag there first. `container_layout.js:324` already sets it on the graph
node, and `architecture_element_shapes.js:176` already honours it when drawing.

*Blast radius:* the 7 C4Context fixtures (`ecommerce_context`, `library_context`,
`label_crowding_parallel_rels`, `polygot-media-context`, `three_tier_context`,
`external_zone_classification`, `dense_context_crossings`) plus the PlantUML landscape ones.
Container diagrams with real boundaries are untouched.

**A2 (broader, only if A1 is insufficient): make `nudgeLabelClear` honour `_borderStrip`.**
It is the last stage that treats a strip as a hard blocker while every other stage prices it as
cosmetic. Rather than skipping strips outright, run the candidate loop twice — first accepting
only strip-clear cells (today's behaviour, so nothing that currently works changes), then
accepting strip-clipping cells before giving up. Keeps drawn-boundary hygiene where there is room
for it and stops a thin cosmetic strip forcing a class-3 defect where there is not.

While in here, note the `n <= 3` step cap: in this diagram the first clear cell was at `n = 3`,
the last one tried. A geometry needing `n = 4` fails outright. Consider raising the cap or
switching to a continuous escape distance — but measure, since a bigger cap means labels can
travel further from their line, which is the orphaning failure mode.

### Fix B — wrap the technology string

Make `createConnectionLabel` wrap `[tech]` with `wrapText` at the same `maxWidth`, count the
extra lines in `height`, and mirror the change in `appendLabelText` so the drawn text matches the
measured box.

Measured for this label:

| maxWidth | lines | box (incl. padding) |
|----------|-------|---------------------|
| 120 | 4 | **132 × 60** |
| 92  | 4 | 112 × 60 |
| 72  | 7 | 89 × 99 |
| 56  | 8 | 89 × 112 |

At the **default** `MAX_LABEL_WIDTH` of 120 the box becomes 132 × 60 — comfortably inside the
220px channel. Combined with A it is accepted by `tryPlaceClearMidpoint`, the *first* strategy
tried, at exactly the segment midpoint. No fallback, no rescue, no adaptive re-wrap involved. That
stability is the argument for B over any amount of further search tuning.

This is also the capability [label-orphaning-fix.md](label-orphaning-fix.md) needs: a
tech-dominated label that cannot fit its channel can now be *made* to fit rather than exiled.

*Blast radius is smaller than it looks.* Across the whole fixture corpus: **273** Connection
Labels carry a technology string, but only **3** are currently tech-dominated (box wider than
`MAX_LABEL_WIDTH`), and **none** exceeds 220px. Every other label already wraps on its main text
and is unaffected. The corollary matters more than the number: **the corpus has no coverage of
this defect class at all**, which is why the ratchet never caught it. See §5.

### Fix C — extend `isUnplaceable` beyond `off-canvas`

This is Option A from [label-orphaning-fix.md](label-orphaning-fix.md) §4: let `buried` and a new
`off-route` failure escalate to the `REWRAP_WIDTHS` loop.

**Not needed for this bug once A + B land** — the label places correctly at the natural width, so
the re-wrap loop never runs. Keep it in reserve for labels whose channel is narrower still.

Worth recording explicitly: INC-16 measured "treat burial as unsatisfiable" and found it *worse*
(1 off-canvas label traded for 9 new label overlaps), and that measurement is the stated reason
`isUnplaceable` is so narrow. **B changes the premise of that measurement.** At the time, re-wrap
could not narrow a tech-dominated label at all, so escalating to it perturbed neighbours for no
width gain. With B, re-wrap has real power, and the trade should be re-measured before C is
rejected again on the old evidence.

### Fix D — the structural fix (INC-15 territory)

Nothing upstream of placement knows the corridor has to carry a 292px label: the external-zone
placement sets Google IDP 220px from Dealer Auction, and the grid router then draws straight
across it. INC-15's *"corridor half-width vs the widest label that corridor must carry"* is the
same idea one axis over — here it is the **element gap**, not the route, that needs the clearance
term. Correct, largest blast radius, already deliberately deferred. A + B make it unnecessary for
this diagram.

### Fix E — shorten the technology string in the source

`"OIDC application selecting manheim IDP configuration"` → something under ~20 characters drops
the box under 220px and it places. Same fragile data-level workaround the orphaning doc records:
it holds only while box width < channel width, and it asks the author to serve the renderer.
Useful as an immediate unblock, not as the fix.

### Recommendation

**A1 + B, in that order, each measured separately against the ratchet.** A1 is a small, defensible
correctness fix (an undrawn border is not an obstacle) with a bounded blast radius. B is the
missing capability that closes both this bug and the orphaning one. Neither adds a cost model, so
the "one severity ordering" rule in [CLAUDE.md](../CLAUDE.md) is unaffected. Hold C in reserve and
re-measure it after B; leave D to INC-15.

## 5. Verify

- **New fixture, needed either way.** Nothing in `test/fixtures/diagrams/` has a technology string
  long enough to exceed its channel — 0 of 273 labels — so the corpus cannot currently regress or
  confirm this. Add a C4Context fixture with a deliberately long technology string across a narrow
  external-zone gap, and capture its baseline.
- **Unit test, no Playwright.** Drive `connection_label_placement` directly (as `§3` and
  `test/unit/connection_label_placement.test.js` already do): assert the final box does not
  overlap any non-`_borderStrip` obstacle, and that `boxToPolylineDistance` to its own route stays
  within ~1 label height. That second assertion is what stops A-alone shipping as an orphan.
- **`createConnectionLabel` unit test** for B: a bracketed technology string wraps at `maxWidth`
  and the reported `height` matches the number of lines `appendLabelText` will draw. The two have
  to move together or the critic scores a box nothing was drawn at.
- `npm test` green — no fixture's defect vector rises.
- If any fixture improves, `npm run baseline:quality` and commit the tightened baseline.
- Re-run the repro in §3 and confirm `Label×Elem 0`.

## 6. Done bar

A Connection Label whose natural width exceeds its channel is **re-wrapped narrow enough to sit on
its own line**. It is never buried in an architecture element, and never parked clear of
everything but detached from its line. A boundary that is not drawn does not constrain placement.
No corpus fixture regresses, and the corpus gains a fixture that would have caught this.

---

## 7. What landed

**A1 + B, as recommended.** The One Marketplace label now places at `x 1084 … 1216`,
`y 440 … 500` — a 132 × 60 box centred in the 220px channel, on its own line, accepted by
`tryPlaceClearMidpoint` on the first attempt. `Label×Elem` for that diagram: **1 → 0**.

### 7.1 The part the investigation missed: extent is not obstacles

A1 as specified regressed three fixtures — `library_context.{mermaid,puml}`
(`labelLineIntersections` 0 → 1, `labelLabelOverlaps` 0 → 1) and
`label_crowding_parallel_rels.mermaid` (`labelLineIntersections` 2 → 3). Bisecting showed **all
three came from A1, none from B.**

The cause was a coupling §2.4 did not anticipate. `contentBounds` — which decides what counts as
`off-canvas`, and which `clampToBounds` clamps into — was fed the *obstacle* set, and the
obstacle set's only members beyond the elements were the border strips. So removing synthetic
strips silently shrank the drawable area to the element union box. In `library_context` the
`notifications → patron` route legitimately runs out to `x=130`, left of every element
(`x≥160`); its label was then judged off-canvas at every re-wrap width, declared UNSATISFIABLE,
and clamped on top of its neighbour. At `HEAD` the same label placed fine at `x=77`.

The fix separates the two concerns:

- `buildBoundaryExtents` ([svg_renderer.js](../src/renderer/svg/svg_renderer.js)) emits **every**
  boundary — synthetic included — as one rect inflated by the same 12px clearance. The union of
  the four strips *is* the inflated rect, so the extent is bit-identical to what it was.
- `contentBounds` is computed from elements + strips + extents; only the obstacle list drops
  synthetic strips.
- `nudgeLabelClear` and `adjustFinalLabelPlacement` take `bounds` as a parameter instead of
  re-deriving it from the obstacles. Both fall back to the old derivation when it is absent, so
  direct callers keep working.

All three regressions went away and the corpus returned to its exact baseline.

**The general lesson, worth carrying:** `_borderStrip` obstacles were doing two unrelated jobs —
"do not put a label here" and "this is how far the diagram reaches". They were only ever one list
because a boundary happened to serve both. Any future change to the obstacle set has the same
trap.

### 7.2 Measured cost across the corpus

**Zero.** Corpus totals are unchanged: `connectionLineElementCrossings=12`,
`connectionLineOverlaps=34`, `connectionLineCrossings=36`, `labelLineIntersections=12`,
`labelLabelOverlaps=10` — 92 ungated defects before and after. The baseline diff is only the two
new fixtures plus metadata.

The parity rig (`npm run test:refactor`) reports four diffs against `HEAD`, all expected:

- `refactor/narrow_channel_wide_label.{mermaid,puml}` — new, so absent from the baseline lane.
- `external/bigbankplc_container.puml` and `external/techtribesjs_container.puml` — the three
  tech-dominated labels §4 predicted, re-wrapped narrower and taller:

  | label | before | after |
  |-------|--------|-------|
  | `Uses [sync/async, XML/HTTPS]` | 128 × 28 | 65 × 41 |
  | `Reads from [MongoDB wire protocol, port 27017]` | 180 × 28 | 102 × 41 |
  | `Reads from and writes to [MongoDB wire protocol, port 27017]` | 180 × 41 | 110 × 54 |

  Element geometry and **every route** are byte-identical in both fixtures — verified by
  comparing the rig's two lanes field by field. Only label boxes moved. The rig renders `HEAD`
  against the working tree, so it flags any deliberate behaviour change; it goes green once this
  is committed.

### 7.3 Side effect: the orphaning bug is closed too

[label-orphaning-fix.md](label-orphaning-fix.md)'s repro — the `Delegates authentication to
[OIDC — upstream IdP connection]` label that used to park ~320px from its line and still score
all zeros — now renders as a 91 × 86 box its own line passes straight through, with a
`0` defect vector. §4 predicted this; it holds. The layout that scratch file produces today is
not the side-by-side arrangement that doc describes, so this confirms the *mechanism* (a
tech-dominated label can now be narrowed to fit) rather than that exact geometry.

### 7.4 Tests added

- `test/fixtures/diagrams/refactor/narrow_channel_wide_label.{mermaid,puml}` — **verified to fail
  at `HEAD`** (`labelElementCrossings: 1`) and pass with the fix. A regression fixture that does
  not reproduce the defect is worth nothing, so this was checked by stashing the fix, not assumed.
  The topology is load-bearing: `payment-gateway` has to land in the *right* external zone to get
  a narrow horizontal corridor, which needs it called by an internal element that is **not** in
  the deepest layer (see the zone rules in `container_plan.js`). The first draft of this fixture
  put the externals below, produced a 194px vertical gap, and passed at `HEAD` — useless.
- `test/unit/text_metrics.test.js` — technology strings wrap; `maxWidth` actually narrows them;
  an unbreakable token is still reported at its true width.
- `test/unit/connection_label_placement.test.js` — the One Marketplace geometry driven directly
  through the placer: the box fits the channel, is buried in nothing, stays within one label
  height of its route, and sits on the channel midpoint. Plus a test that `nudgeLabelClear` takes
  explicit bounds rather than inferring them, pinning §7.1.

### 7.5 Not done

Fix C (extending `isUnplaceable` past `off-canvas`) and Fix D (INC-15) remain open, as
recommended. C's re-measurement is now worth doing on the evidence stated in §4.3 — B changed the
premise INC-16 rejected it on — but nothing in the corpus currently needs it.
