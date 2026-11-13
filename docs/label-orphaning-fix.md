# Fix: Connection Labels orphaned far from their line (candidate INC-22)

**What this is:** a ready-to-execute spec for a single engine fix. A Connection Label that is
too wide for the channel between its endpoint elements is currently parked in the nearest
element-clear cell — which can be hundreds of pixels away from the line it belongs to — and the
result scores as a clean layout. This doc records the diagnosis, the exact code path, and two
candidate fixes so it can be picked up later. It is written to fold into
[IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) as INC-22 once scheduled.

**Size:** M. Touches placement logic guarded by the quality ratchet; needs a full `npm test`
pass and probably a `npm run baseline:quality` re-capture.

**Status: believed closed** by the technology-string wrapping in
[label-buried-narrow-channel-fix.md](label-buried-narrow-channel-fix.md) (landed 2026-07-29).
That change is Option A's missing precondition: a tech-dominated label can now actually be made
narrower, so it fits its channel instead of being exiled from it. Re-running the §3 reproduction
puts the `Delegates authentication to` label on its own line (a 91 × 86 box the line passes
through) with an all-zero defect vector. Note the scratch file's layout today is not the
side-by-side arrangement described in §1, so this confirms the mechanism rather than that exact
geometry — **if you can construct a diagram that still orphans a label, this doc is still live**
and Option B remains the fallback.

Originally diagnosed and reproduced 2026-07-24 against `main` (`030f155`).

---

## 1. The symptom

Render this C4Context (Auth0 → AutoTrader is the relevant relationship):

```
Rel(auth0, dealer-auction-external-idp, "Delegates authentication to", "OIDC — upstream IdP connection")
```

with Auth0 and AutoTrader side by side on the bottom external row. The
`Delegates authentication to [OIDC — upstream IdP connection]` label renders at center **x≈212,
y≈809**, ~320px to the *left* of Auth0 — while its own connection line runs `M 530 809 L 670 809`
in the gap between the two boxes. The label is visually orphaned, yet the defect vector is
**all zeros**: `Element Overlap 0, Line×Elem 0, Label×Elem 0, Line Overlap 0, Line×Line 0,
Label×Line 0, Label×Label 0`.

That "clean" score is the bug. Nothing in `src/core/severity.js` penalises a label being far
from the line it annotates, so a detached-but-clear placement is indistinguishable from a good
one.

## 2. Root cause

Two facts combine:

1. **The label is wider than its channel.** The box is ~190px wide (driven entirely by the
   `[OIDC — upstream IdP connection]` technology string); the gap between Auth0 (ends x=530) and
   AutoTrader (starts x=670) is only 140px. The label physically cannot sit on its line without
   burying into one of the two boxes.

2. **The escape search picks the nearest element-clear *cell*, not the nearest on-line
   position.** When the on-line placement buries into an element, `nudgeLabelClear`
   ([src/renderer/labels/connection_label_placement.js:1051](../src/renderer/labels/connection_label_placement.js))
   searches a coarse grid — steps of one full label height vertically, one full label width
   horizontally — sorted nearest-first, vertical before horizontal:
   - **Vertical fails:** down is inside the boxes (they span y=774–914); up is blocked by the
     stack of `Authenticates via [OIDC]` labels in that middle column.
   - **Horizontal one step** (±~194px) still clips Auth0 (left) or AutoTrader (right).
   - **Horizontal two steps left** (−~388px → x≈212) is the first fully clear cell. It wins.

The subsequent `rescueLabelFromConnectionLineHits`
([:518](../src/renderer/labels/connection_label_placement.js)) *does* carry an `offRoute`
distance penalty, but it only walks the label's own route (x=530–670), where every candidate
buries into a box (cost `buried * 100000`). That is worse than the orphaned-but-clear cell, so
rescue cannot pull the label back.

The re-wrap fallback (`REWRAP_WIDTHS` in
[src/renderer/labels/connection_label_rendering.js:184](../src/renderer/labels/connection_label_rendering.js))
that would break the wide technology string onto more lines only triggers on an **off-canvas**
failure (`isUnplaceable` checks `failure === 'off-canvas'`). An orphaned in-canvas label is not
off-canvas, so it is never re-wrapped.

**One-line summary:** the placer treats "clear of every element" as success and has no notion
that a label must stay *near its own line*, so when a label can't fit its channel it degrades to
"far away but clean" instead of "on the line but narrower".

## 3. Reproduction

`scratch_one_marketplace.mermaid` at the repo root reproduces it (revert the last `Rel` to the
long `"OIDC — upstream IdP connection"` string). Then:

```bash
node src/cli/index.js scratch_one_marketplace.mermaid --out .nudge_repro
```

Inspect `.nudge_repro/optimized.svg`: the `edge-label-bg` rect for the Delegates label sits at
`x≈117` while the line is at `x=530..670`. Defect summary prints all zeros.

The data-level workaround (shortening the string to `"OIDC (upstream IdP)"`, which drops the box
to 129px so it fits the 140px gap) confirms the mechanism: with a narrower box the label places
on the line at first attempt. That workaround is fragile — it only holds while box width <
channel width — which is why the engine fix below exists.

## 4. Candidate fixes

### Option A — make off-route distance a re-wrap trigger (preferred)

Let a large off-route distance escalate to the `REWRAP_WIDTHS` fallback, not just off-canvas.
Then a label that would otherwise be orphaned is re-wrapped narrower (taller) and retried; a
129px/three-line box fits a 140px channel and lands on the line.

- Add an `off-route` failure mode alongside `off-canvas` in `placementFailure`
  ([connection_label_placement.js:641](../src/renderer/labels/connection_label_placement.js),
  called from
  [connection_label_rendering.js:165](../src/renderer/labels/connection_label_rendering.js)),
  triggered when the final box's `boxToPolylineDistance` to its own line exceeds a threshold
  (start ~1.5× label height; tune against the corpus).
- Extend `isUnplaceable` to treat `off-route` as unplaceable so the re-wrap loop keeps trying
  narrower widths.
- Keep the clamp/degrade path: if no width fits on-route either, degrade *on* the line (buried,
  a counted Label×Elem defect) rather than off it — a visible, correctly-scored defect beats an
  orphan.

**Risk:** re-wrapping changes what later labels see as occupied, and INC-16 already showed that
cascades (1 off-canvas label traded for 9 new overlaps). Must be measured across the whole
corpus, not one fixture.

### Option B — add an off-route term to `nudgeLabelClear`

Give `nudgeLabelClear` the same `offRoute` cost `rescueLabelFromConnectionLineHits` already uses,
so among element-clear cells it prefers the one nearest the line instead of the first found. This
would stop the far-left jump but does **not** make the label fit — it would still choose a
mildly-off cell over burial. Weaker than A; useful only if A proves too disruptive.

### Not recommended — a new Label-to-Line-distance defect class in `severity.js`

Tempting, but the project has one severity ordering by design (see CLAUDE.md "One severity
ordering"). Only add a class here if A and B both prove insufficient, and then add it to
`severity.js` so every consumer moves together — never a second cost model.

## 5. Verify

- Reproduction diagram: the Delegates label's `edge-label-bg` centre is within ~1 label-height
  of its line's polyline (assert `boxToPolylineDistance ≤ threshold`).
- `npm test` green — no fixture's defect vector rises (the ratchet).
- If any fixture *improves*, run `npm run baseline:quality` and commit the tightened baseline.
- Add a unit fixture under `test/fixtures/diagrams/` with a deliberately over-wide label in a
  narrow channel, and a `node --test` assertion that the rendered label stays near its line.

## 6. Done bar

A Connection Label whose natural width exceeds its channel is either re-wrapped to fit on its
line, or (if nothing fits) drawn buried on the line as a correctly-counted Label×Elem defect —
**never** placed clear of all elements but detached from its line. No corpus fixture regresses.
