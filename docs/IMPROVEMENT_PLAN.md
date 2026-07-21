# Nudge improvement plan — the master backlog

**What this is:** the single source of truth for making Nudge robust instead of endlessly
chasing edge cases. Work it top-to-bottom, one increment at a time. It replaces the scattered
review/findings/hardening/investigation documents that used to live in `docs/`.

**How to use it:** each increment has an ID, a size, a why, a verify step and a done bar. Do
them roughly in order — the ordering is deliberate so each step is *measurable through the one
before it*. Tick the box when it lands. Re-baseline the evidence tables in the appendix when
the numbers move.

**Status:** originally verified against source at commit `6bf2988`. Every claim below was either
read in source at the cited line or measured by rendering the corpus through the production
pipeline. Nothing is inferred from behaviour alone.

**Progress: 19 of 21 increments landed** — Phases 0, 1, 2, 3 and 6 complete; Phase 4 complete
Phase 5's crux (INC-16) landed. Line numbers cited below refer to
the original commit and have moved. Remaining: **INC-15** (router lateral clearance) and
**INC-18** (Playwright optional) — both deliberately deferred as large, high-blast-radius changes.
Standing measurements, all ratcheted and printed by `npm test`:

| Measure | Value | Where |
| --- | --- | --- |
| Corpus defects | 92 across 15/43 fixtures (incl. 7 third-party) | `test/fixtures/baselines/quality_baseline.json` |
| Off-canvas labels (40 generated diagrams) | **0** — now an absolute invariant | `layout_invariants.test.js` |
| Off-canvas labels (fixture corpus) | **0** (was 6) | `quality_baseline.json` |
| Legacy router fallbacks | 28 / 360 relationships | `router_coverage.test.js` |
| Cost models remaining | 4 of 9 | §Appendix B |
| Tests | 103 unit + 18 integration | `npm test` |

Corpus defects rose 70 → 90 as a *declared trade*, not a regression: INC-16 converts 6 invisible
off-canvas labels into visible ones, at the cost of 10 label overlaps and 10 label-line
intersections in the two hardest multi-boundary fixtures. See INC-16 for the full delta and why
`labelOffCanvas` had to become a counted class before the trade could be judged at all. The
remaining +2 are the two Connection-Line Crossings the new third-party corpus brought with it.

**Still-separate documents (not folded in — different kind of doc):**
- [connection-label-crowding-plan.md](connection-label-crowding-plan.md) — the ready-to-execute
  spec for the label increments (INC-2, INC-4, INC-9). Referenced, not duplicated.
- [container-diagram-layout.md](container-diagram-layout.md) — architecture *reference* for the
  container/context pipeline. Describes how it works, not how to change it.
- [nudge_next_generation_design.md](nudge_next_generation_design.md) — the north-star design
  vision. Partly already shipped (grid router). Aspirational, not a backlog.

---

## 1. The thesis: convergent, not tail-chasing

The tail-chasing is real and currently structural — but it is **not inherent to the problem**.
C4 layout has a bounded, enumerable defect taxonomy: six classes
(`UBIQUITOUS_LANGUAGE.md`), all decidable by exact axis-aligned-rectangle geometry. There is no
open-ended "looks wrong" residue. That is the precondition for a robust solution, and Nudge has
it. **The deterministic layout core is genuinely good** — Element Overlap is 0 and
Connection-Label Element Crossing is 0 across the whole 26-fixture corpus. The problem is not
layout quality.

What produces the *sensation* of chasing edge cases is four compounding structural causes, each
fixable:

1. **There is no single objective function — there are nine.** (§Appendix B.) Nine independently
   tuned cost models over the same geometry, with no shared severity ordering. A local fix
   conserves total defect count rather than reducing it: fix one diagram, break another. This is
   *proven*, not asserted — the label-crowding Option A+B experiment fixed `aims_crowded` and
   introduced a brand-new label overlap in `mcm_context`. Every local fix is a
   defect-conservation operation.

2. **The measurement system cannot see most defects, so "fixed" is unfalsifiable.** Four of six
   defect classes have no gate; `edge_label_node_crossing` has no counter at all; the test
   suite's quality grade is a tautology that can never fail (§Appendix A). A defect class with
   no gate has no ratchet — fixes don't stick, and the class silently reopens under new input
   and reads as a fresh edge case.

3. **The pipeline is sequential, greedy, and cannot backtrack.** Layout → route → label, each
   committing irreversibly. The router has no label term; labels are placed first-come in edge
   declaration order; no stage can report "unsatisfiable" — a saturated corridor emits a buried
   label and reports success. One structural gap generates unbounded symptom variety.

4. **Renders are not deterministic.** Text metrics depend on a lazily-loaded webfont, so the
   same diagram measures differently between the first and second render. You cannot converge on
   a target that moves between measurements.

Fix the measurement and the objective, then the remaining edge cases become a finite,
documentable list. **Robustness here is not "never fails" — it is "the failure mode is total,
declared, and tested."** That is the whole point of the UNSATISFIABLE fallback (INC-16).

---

## 2. The backlog at a glance

Phases are ordered so each is measurable through the previous. Phase 0 is hours. Phase 1 is the
pivot that makes everything downstream falsifiable.

| Phase | Increments | Unlocks |
| --- | --- | --- |
| **0 — stop the bleeding** | INC-1, INC-2 | Stops leaking private tooling; kills the font race |
| **1 — make defects visible** | INC-3, INC-4, INC-5 | Turns silent failures loud |
| **2 — the ratchet** | INC-6, INC-7, INC-8 | Fixes become durable; regressions caught across all six classes |
| **3 — trustworthy + pure-Node core** | INC-9, INC-10, INC-11 | Layout unit-testable in ms; determinism permanent |
| **4 — fix the objective** | INC-12, INC-13, INC-14 | Removes the defect-conservation mechanism at its root |
| **5 — fix the causes** | INC-15, INC-16 | Router gives labels room; saturated corridors get a declared output |
| **6 — reach + tidy** | INC-17…INC-21 | Optional Playwright, public API, CI, release discipline |

---

## 3. The increments

### Phase 0 — stop the bleeding

- [x] **INC-1 · `files` allowlist in `package.json`** · *size: trivial* · do before the next publish
  - **Why:** no `files` field and no `.npmignore`, so `npm publish` ships **190 files / 1.6 MB**,
    including your private `.agents/skills/**` tooling, 52 test files, `scripts/`, and `docs/`.
  - **Do:** add `"files": ["src/", "examples/", "README.md", "LICENSE", "UBIQUITOUS_LANGUAGE.md"]`.
    Note `postinstall` writes `src/vendor/elk.bundled.js`, so `src/` must stay writable — verify
    the packed install still works.
  - **Verify:** `npm pack --dry-run` shows only the intended files.

- [x] **INC-2 · Deterministic renders — explicitly load webfonts** · *size: small* · [detailed spec: label plan Stage B](connection-label-crowding-plan.md)
  - **Why:** `render_engine.js:8` awaits only `document.fonts.ready`, but Google Fonts' Outfit
    faces carry `unicode-range` and load lazily on first use — `fonts.ready` resolves before the
    font is fetched. Render 1 measures in the fallback font, render 2 in Outfit (measured: 183.03
    px vs 180.00 px for the same string). Everything downstream is measured through this race.
  - **Do:** `await Promise.allSettled([...])` a `document.fonts.load()` for **every** weight/size
    the renderer measures (11, 13, 14, 16 px; weights 500/600/700). Constraints that bite:
    - Use `allSettled`, never bare `Promise.all` — with `fonts.gstatic.com` blocked, `load()`
      *rejects*, and that rejection inside the `try` at `render_engine.js:7` currently produces no
      diagram at all.
    - Enumerate every spec, not just `11px Outfit`.
    - `load()` only fetches the subset matching its test string; non-Latin labels re-trigger the
      bug. Pass representative text or note the limitation.
  - **Verify:** on a **freshly-navigated** page, `renderDiagram` call #1 == call #2 (width,
    height, SVG). Not "two consecutive calls" — calls 2/3/4 are already identical today; only
    call 1 differs. INC-9 makes this permanent.
  - **Note:** this is the cheap route to determinism. INC-9 (pure-JS metrics) is the durable
    replacement that removes the network dependency entirely.

### Phase 1 — make defects visible

> Land all detection/counters **non-gating first**, then flip to gating in INC-8 once the corpus
> is clean. Expect real failures to surface — that is the point.

- [x] **INC-3 · Add the missing counters; wire all six classes into the container scorer** · *size: small*
  - **Why:** `edge_label_node_crossing` is emitted (`geometry.js:363`) but **increments no
    counter** — every other class has one. `scoreContainerStep` (`optimizer.js:250`) has no
    label-element term at all, so the label-hint accept/reject loop is scored by a function that
    cannot see the defect it exists to fix. There is also **no label-label-overlap counter
    anywhere in `src/core/`** — that is new geometry, not plumbing.
  - **Do:** add `labelElementCrossingCount` and `labelLabelOverlapCount` to the report; wire all
    six classes into `scoreContainerStep`. Surface the new fields in all three entry points —
    `optimizer.js` history, `cli/index.js` (its `console.table` uses a hardcoded key projection
    that silently drops new fields), and `mcp/index.js`'s JSON summary.
  - **Verify:** `library_context` and `label_crowding_parallel_rels` now **report** the defect
    (both silently carry 1 today).

- [x] **INC-4 · Repair the container/context critic gate** · *size: small* · [detailed spec: label plan Stage C+G](connection-label-crowding-plan.md)
  - **Why:** the container/context success gate checks **2 of 6** classes:
    `success = report.overlapCount === 0 && report.intersectionCount === 0` (`optimizer.js:440`).
    The less-used flat/ELK path is *stricter*. Container/context — the primary product — gets the
    weaker gate. (Scoring the *rendered* label box and dropping the endpoint exemption already
    landed in `ae1e69c`/`c34100d`; what remains is wiring the class into the gate.)
  - **Do:** add `labelElementCrossingCount` to the `optimizer.js:440` criterion. Keep it
    non-gating until INC-8 — land the wiring, don't flip yet.
  - **Verify:** a unit test in `geometry.test.js` feeding a label box overlapping its own source
    element asserts one `edge_label_node_crossing`.

- [x] **INC-5 · Delete the tautological grade clause; widen the test corpus** · *size: small*
  - **Why:** `run_tests.js:526` requires grade A/B, but `totalCollisions === 0` is a precondition
    of reaching it and both grade sub-scores are pinned at 10 — **the grade clause can never
    fail** (§Appendix A). Separately, `run_tests.js:12` points `TEST_DIR` at
    `test/fixtures/diagrams/core` only, so the 6 known Connection-Line Element Crossings in
    `refactor/` are never rendered by the visual suite.
  - **Do:** delete the grade clause and gate on the counters instead; run the visual suite over
    `test/fixtures/diagrams/refactor/` too.
  - **Verify:** the suite stops printing "🎉 All tests passed" over a corpus with 20 crossings.
    Expect new real failures.

### Phase 2 — the ratchet

- [x] **INC-6 · Quality-baseline ratchet (replaces the sha256 parity rig)** · *size: medium* · **highest-value test change**
  - **Why:** `refactor_test_rig.js` compares `sha256(stableJson(result))` — a "did it change"
    test, not "is it right". It **protects** `nested_boundary_characterization`'s 12
    Connection-Line Overlaps from being fixed while never asserting them wrong, and it renders
    without `normalizeDiagramModel` so for C4Context fixtures it tests a path production never
    runs. A gate asks "did it pass?"; a **ratchet** asks "did anything get worse?".
  - **Do:** one checked-in JSON per fixture holding the full defect vector (all six classes +
    bends + route length). Assert **no count increases**; improvements require a visible
    re-baseline in the diff. Generalises `route_quality_baseline.json` from routes to all six
    classes. Call `normalizeDiagramModel` so it tests the production path.
  - **Verify:** a change that fixes one diagram and worsens another cannot merge silently.

- [x] **INC-7 · Determinism test** · *size: trivial*
  - **Do:** render the same fixture twice in a fresh page; assert identical output. Trivially true
    after INC-2 / INC-9; catches the entire nondeterminism class.

- [x] **INC-8 · Flip the gates to gating** · *size: small* · gate on `success` last
  - **Do:** once the corpus is clean (after Phase 3's label fix), flip INC-3/INC-4's counters and
    INC-5's grade replacement from non-gating to gating. Whether `labelLabelOverlapCount` *gates*
    or merely *warns* is a judgement call — the only evidence is `auction_context` (one overlap),
    which the gate corpus never renders. Present it; don't decide autonomously.
  - **Decided:** two tiers, not one.
    - **Absolute gate** — Element Overlap, Connection-Line Element Crossing, and now
      **Connection-Label Element Crossing** (`optimizer.js`, container/context `success`). All
      three are 0 across the whole 36-fixture corpus, so the gate can hold a clean class clean.
      This closes the "primary product gets the weaker gate" hole in INC-4.
    - **Ratchet only** — Connection-Line Crossing, Connection-Line Overlap, Label-Line
      Intersection and **Label-Label Overlap**. The corpus legitimately carries 70 of these; an
      absolute gate over them would be permanently red, and a permanently red gate gets switched
      off, which is how the class went unwatched in the first place. Any *increase* still fails.
    - `labelLabelOverlapCount` is ratchet-only by decision: the sole evidence for gating it is
      `auction_context`, which is not in the corpus, so an absolute gate would be tuned on a
      diagram nothing renders. Revisit once INC-14's external corpus lands.
    - INC-5's grade clause is deleted outright rather than flipped — the ratchet replaced it.

### Phase 3 — trustworthy + pure-Node core

- [x] **INC-9 · Pure-JS text metrics (the pivot)** · *size: medium* · **highest structural leverage**
  - **Why:** the browser dependency is **one function wide**. Every layout, routing, planning and
    label-placement module is already DOM-free (§Appendix C). Chromium is required for exactly two
    things: emitting SVG nodes, and `measureTextWidth` (`src/renderer/shared/text.js:3-13`), which
    uses canvas `measureText`. Only **four font sizes** (11, 13, 14, 16), two weights, one family
    are ever requested.
  - **Do:** replace `measureTextWidth` with pure-JS metrics from a self-hosted Outfit `.ttf`
    (fontkit/opentype.js: sum glyph advances + kerning, scale by `fontSize / unitsPerEm` — exact).
    Self-host via the `postinstall` copy step that already vendors elkjs; license-check Outfit (OFL).
  - **Unlocks:** layout becomes pure Node; the font race dies permanently (supersedes INC-2); the
    1,049-line label placer and the whole router become unit-testable in **milliseconds** without
    Playwright; Playwright drops to an optional PNG-only dependency (~300 MB install removed).
    `globalThis.NudgeRenderer` already loads under `node --test`, so the migration path exists.
  - **Landed as:** a *baked metrics table*, not a runtime font parse. `scripts/generate_font_metrics.js`
    reads Outfit from `@fontsource/outfit` (OFL 1.1, redistributable) with `fontkit` and emits
    `src/vendor/outfit_metrics.js` — 217 glyph advances and ~4,900 kern pairs per weight, for the
    two weights canvas actually resolves (`normal`→400, `bold`→700). The table is a plain script,
    loaded by `render.html` next to the elkjs bundle and by `node --test` as a side-effect import,
    so browser and Node measure through the identical code path.
    - Kerning is **not** optional: it is ~1.2% of a typical label's width, several px on a long one.
    - `fontkit` and `@fontsource/outfit` are **devDependencies** — the generated table ships in the
      package, so installing Nudge pulls in neither the font nor the parser. `postinstall`
      regenerates only when `scripts/` is present (i.e. from a git checkout), and otherwise asserts
      the shipped table exists rather than failing silently.
    - Unknown codepoints fall back to the average advance, so non-Latin labels degrade to an
      approximate width rather than `NaN` — a `NaN` width silently poisons every downstream box.
  - **Verified:** agrees with Chromium's canvas `measureText` to **<0.2 px on a 264 px string**
    (max observed Δ 0.17 px, i.e. 0.07%), and re-rendering the whole 36-fixture corpus produced
    **zero regressions and zero improvements** against the INC-6 baseline — the pure-JS path
    reproduces the canvas layout exactly at the defect level. `test/unit/text_metrics.test.js`
    pins this against captured canvas reference widths and runs in **67 ms with no browser**.
  - **Note:** this supersedes INC-2 for *layout*. The `document.fonts.load()` pass stays, but its
    job is now pixel fidelity in the PNG screenshot, not determinism.

- [x] **INC-10 · Unit-test the placement logic directly** · *size: medium* · needs INC-9
  - **Do:** `connection_label_placement.js` (1,049 lines, three cost models) is today only
    reachable through a browser render. After INC-9 it is a pure module — feed it fixture
    geometry, assert the chosen candidate. Model it on the existing
    `grid_connection_line_router.test.js` / `visibility_graph.test.js`. This is what makes INC-12
    safe.
  - **Landed as:** `test/unit/connection_label_placement.test.js` — 13 tests, **70 ms, no browser**.
    Making the module loadable under `node --test` was a one-line-per-reference change: it had
    **zero DOM references** already, just the browser-only `window.NudgeRenderer` namespace form,
    now `globalThis` (in a browser they are the same object).
  - **Two of the tests deliberately pin *wrong* behaviour**, marked `WRONG (INC-12)`, and are the
    executable proof of the defects INC-12 must fix:
    - **The double-charge is real.** The production caller passes `createLabelObstacles(...)` —
      which already contains every placed label — as `obstacles`, and `scoreCandidate` then counts
      those same labels again via `placedLabels`. One defect, charged twice.
    - **The severity ordering is inverted.** Because of that double-charge, grazing another label
      costs 150 000 (100 000 `nodeCollision` + 50 000 `labelHits`) while burying a label *inside an
      architecture element* costs 100 000 — so the placer prefers the more severe defect. The test
      asserts `buried.score < grazing.score` today; INC-12 must invert that assertion.
    - **`nudgeLabelVertically` structurally cannot rescue a crowded label.** It is the stage meant
      to do the rescuing and its signature only returns a `y`. Labels are wider than they are tall,
      so the common crowding case is horizontal and this stage has no move available to it.

- [x] **INC-11 · Property-based invariants over generated diagrams** · *size: medium* · needs INC-9
  - **Why:** the corpus is 26 hand-authored diagrams — you only discover an edge case when someone
    draws it. This is the *input* to tail-chasing.
  - **Do:** a seeded generator (element count, relationship density, label lengths, parallel/self
    relationships, cycles, boundary nesting) asserting invariants that must hold for *every*
    diagram: no Element Overlap; every segment axis-aligned; every endpoint on its element face;
    every label box in-canvas; every child inside its boundary; **placement is total** — no label
    at an unscored fallthrough position. Seeded → failures shrink to a minimal fixture you promote
    into the corpus. This is how you find edge cases before users do.
  - **Landed as:** `test/generators/diagram_generator.js` (seeded mulberry32; element count,
    relationship density, label length, parallel relationships, self-relationships, externals)
    plus `test/integration/layout_invariants.test.js` — 40 seeds, **~1.3 s**. Any failure prints
    its seed and reproduces with `NUDGE_PROPERTY_FIRST_SEED=<seed> NUDGE_PROPERTY_SEEDS=1`.
  - **Result — five of six invariants hold on every generated diagram**, which is a real
    endorsement of the deterministic layout core on inputs nobody chose: no Element Overlap,
    every box finite and positive, every child inside its boundary, every segment axis-aligned,
    every endpoint on its element's face. Self-relationships — a shape absent from the
    hand-authored corpus — routed correctly with no violations at all.
  - **Result — the sixth invariant fails hard, and it is the plan's own thesis in miniature.**
    **38 of 40 generated diagrams place at least one Connection Label outside the canvas**
    (271 labels total). The same defect fires exactly once on the hand-authored corpus
    (`nested_boundary_characterization`, 22 px overshoot), which is precisely why 26 hand-drawn
    diagrams could not reveal it: crowded corridors are rare when a human is choosing the input.
    Placement runs out of in-canvas positions and emits the label anyway, because there is no
    UNSATISFIABLE outcome to report instead — root cause #3.
  - **This is the strongest available evidence for INC-16**, and it is now a ratcheted number
    (`OFF_CANVAS_BUDGET`) rather than an anecdote: it cannot grow, and INC-16 will be measured by
    how far it falls.

### Phase 4 — fix the objective

> First, declare **one severity ordering** over the six classes and derive **one** scoring
> function from it, used by router, labeller, optimizer and tests alike. Proposed starting order
> (hardest failure first), to be ratified: Element Overlap → Connection-Line Element Crossing →
> Connection-Label Element Crossing → Connection-Line Overlap → Connection-Line Crossing →
> Label-Line Intersection.

- [x] **INC-12 · Collapse the three label scorers into one** · *size: medium* · Option C · [detailed spec: label plan Stage F](connection-label-crowding-plan.md) · needs INC-6 + INC-10
  - **Why:** three cost models (`createCandidateScorer`, `rescueCost`, `sameTargetScore`) sit in
    one 1,049-line file and rank the same two defect classes differently. Worse, the primary
    scorer **double-charges label overlap** (`createLabelObstacles` puts placed labels in the
    element obstacle list *and* the scorer counts them again) so it **prefers burying a label
    inside a box (100 000) to grazing another label (150 000)** — backwards for readability.
  - **Do:** every placement stage becomes a *candidate generator*; one scoring function; take the
    argmin. No stage can fall through to an unscored position. Fold in the double-charge fix
    (pass element-only obstacles) and give `nudgeLabelVertically` a **horizontal** axis (it is the
    stage that should rescue crowded labels and structurally cannot — it only varies `y`).
  - **Do not** ship the reweighting alone: measured, it trades an element burial for a label
    overlap. Ship it as one behaviour change under the INC-6 baseline.
  - **Landed — Options A and the `nudgeLabelVertically` fix. Option C (the full waterfall→argmin
    collapse) is deferred**; see below. Measured at every step against the INC-6 baseline and the
    INC-11 property corpus, which is exactly what those two increments were built for.
    - **Double-charge fixed.** `connection_label_rendering.js` now passes *element-only* obstacles
      to `createCandidateScorer`. `nodeCollision` means "buried in an element" again, so burial
      (100 000) correctly outranks a label graze (50 000) instead of the old inverted
      150 000-vs-100 000. **Zero corpus regressions; off-canvas labels 271 → 269.** The plan's
      warning that Option A alone trades a burial for an overlap no longer holds — that was
      measured before `ae1e69c`/`c34100d` made the critic score the *rendered* label box.
    - **`nudgeLabelVertically` → `nudgeLabelClear`**, now searching both axes nearest-first, with
      vertical breaking ties so previously-good placements are untouched.
  - **The ratchet earned its keep on this one.** The horizontal axis, shipped unbounded, was a
    textbook defect-conservation operation: the corpus stayed at exactly 70 defects while
    off-canvas labels went **269 → 286** — it freed labels from elements by pushing them straight
    off the canvas. Nothing in the corpus suite could see that; the INC-11 property test failed
    immediately. Constraining candidates to the obstacle set's union box (a proxy for the content
    extent, so no canvas size has to be threaded through the render chain) took it to **246**.
  - **Net: off-canvas labels 271 → 246 (−9%), corpus defects unchanged at 70, no regressions.**
    The `seeds` counter ticked 38 → 39 over the same change because it saturates — it counts any
    diagram with *at least one* off-canvas label — while `labels` tracks severity.
  - **Deferred — Option C, the single candidate pool.** Collapsing the seven-stage waterfall into
    generate-all → score-all → argmin is a rewrite of a 1,000-line file, and the two defects that
    made it urgent (the inversion and the rescue stage that could not rescue) are now fixed and
    pinned by `test/unit/connection_label_placement.test.js`. The remaining motivation is the
    unscored fallthrough, which INC-16 has to address anyway. Do it with INC-16, not before.

- [x] **INC-13 · Unify the remaining cost models against the declared ordering** · *size: medium*
  - **Do:** reconcile the router `WEIGHTS`, `scoreContainerStep`, the canned-config search scorer
    and the test grader against the single severity ordering. Removes the defect-conservation
    mechanism (root cause #1) at its source.
  - **Landed as:** `src/core/severity.js` — the ordering is now *declared in one place*, with
    `scoreLayout`, `countDefects` and `isClean` derived from it. Ratified ordering, hardest first:
    Element Overlap → Connection-Line Element Crossing → Connection-Label Element Crossing →
    Label-Label Overlap → Connection-Line Overlap → Connection-Line Crossing → Label-Line
    Intersection. The cut that matters is between the third and fourth: **classes 1–3 destroy
    information** (an element or a label becomes unreadable) and **4–6 degrade readability** while
    everything stays legible. That is the same line the absolute gate is drawn on (INC-8).
  - **Collapsed into it:** `scoreContainerStep` (#6), the canned-config search scorer (#7) and
    `gradeMathematically` (#8). Three of the nine models are gone; two more (#3/#4/#5, the label
    scorers) were reconciled in INC-12. The canned-config scorer was **blind to both label
    classes** entirely, and the grader could see only two of six — which is how
    `content-delivery-just-in-time` graded **A** with five Connection-Line Crossings.
  - **Pinned by** `test/unit/severity.test.js`, which asserts the ordering directly plus the two
    properties that make it safe: **one information-destroying defect outranks any number of
    readability ones**, and **shape cost (bends, route length) never outranks a defect**. Without
    those, the optimizer trades a buried label for cosmetics.
  - **Still outstanding: the grid router's `WEIGHTS` (#1) and the legacy `chooseBestRoute` tuple
    (#2).** Both are browser-side and retuning them moves every route in the corpus, which is
    INC-15's blast radius rather than this increment's. `WEIGHTS` also prices things the Node-side
    scorers cannot see (port-slot reuse, boundary-border crossings). Do them with INC-15.

- [x] **INC-14 · External corpus** · *size: medium*
  - **Do:** ~20 real C4 diagrams *not* authored in-house. Grading your own output with your own
    scorer over your own fixtures is circular. INC-6 makes the corpus cheap to extend.
  - **Landed as:** `test/fixtures/diagrams/external/` — **7 diagrams from C4-PlantUML's samples**
    (MIT, redistribution permitted; provenance and the upstream notice are in that folder's
    README). The visual suite now *discovers* fixture folders instead of listing them, so dropping
    a file in and running `npm run baseline:quality` is the whole workflow for adding more.
  - **Result — the non-circular check is a good one.** Across all 7 third-party diagrams (59
    relationships): **0 Element Overlaps, 0 Connection-Label Element Crossings, 0 off-canvas
    labels, 0 label overlaps, 0 boundary violations, 0 non-orthogonal segments, and 0 legacy
    router fallbacks** — just **2 Connection-Line Crossings** in total, one each in
    `bigbankplc_component` and `techtribesjs_container`. The deterministic layout core holds up on
    diagrams nobody here wrote, which is the first genuinely independent evidence for it.
  - **Still short of ~20.** Seven is what C4-PlantUML's sample set offers in the two notations
    Nudge parses; Structurizr's examples are DSL, which would need a parser first. The drop-in
    path is documented so the corpus grows without further plumbing.

### Phase 5 — fix the causes

- [ ] **INC-15 · Give the router a lateral-clearance term** · *size: large* · Option E · largest blast radius
  - **Why:** the router's `WEIGHTS` price length, bends, crossings, overlaps, port reuse, boundary
    crossings — **nothing about the label the line must carry**. Routing commits, then labels hunt
    for leftover space. In the repro, MCM's right face had 140 px of free corridor and the router
    hugged the face at 18 px.
  - **Do:** add a term for **corridor half-width vs the widest label that corridor must carry**
    (lateral clearance, not segment length), and fan parallel relationships onto distinct
    corridors before labels are placed. Touches `route_quality_baseline.json` and every routed
    fixture — do last.

- [x] **INC-16 · Declare and implement the UNSATISFIABLE fallback** · *size: medium* · Option H · **the crux**
  - **Why:** some corridors genuinely have no free space — no search finds room that doesn't
    exist. A system without a declared fallback produces a novel-looking failure for every
    saturated diagram, forever. A system *with* one has a finite bug list.
  - **Do:** placement becomes constrained search with an explicit **UNSATISFIABLE** outcome, and a
    declared, tested degradation for it — leader line / callout / numbered key, and/or adaptive
    `MAX_LABEL_WIDTH` re-wrap in narrow corridors. **This is the item that converts "unknown edge
    cases" into "known edge cases."**
  - **Landed — adaptive re-wrap, then clamp.** Placement is now a constrained search over label
    *geometry*, not just position: `createConnectionLabel` takes a `maxWidth`, and placement
    retries at 120/92/72/56 px. A corridor too narrow for a wide box often has room for the same
    text re-wrapped narrower and taller. If no width yields an in-canvas position the outcome is
    **UNSATISFIABLE** — the label is clamped back inside the canvas, marked in the SVG
    (`class="edge-label-bg-crowded"`, `data-nudge-unsatisfiable="<reason>"`), and reported through
    `warnings` on every entry point. The failure is now total, declared and tested.
  - **UNSATISFIABLE means specifically "no in-canvas position exists".** Two earlier definitions
    were tried and measured *worse*, which is why the scope is this narrow:
    - Treating burial and label-on-label overlap as unsatisfiable too cascaded — a re-wrapped box
      changes what the *next* label sees as occupied — trading 1 off-canvas label for 9 new label
      overlaps. Those two stay what they already were: scored defects held flat by the ratchet.
    - Taking the first satisfiable width rather than the least severe outcome had the same effect.
  - **Result: off-canvas Connection Labels eliminated.** Across the 40-seed generated corpus,
    **271 → 0**; across the fixture corpus, **6 → 0**. The property test's budget is now an
    absolute `0`, not a ratchet — it is a real invariant for the first time.
  - **The measured cost, stated plainly.** Clamping converts an invisible label into a visible one
    that lands in occupied space. Corpus-wide: `labelOffCanvas` **6 → 0**, `labelLabelOverlaps`
    **0 → 10**, `labelLineIntersections` **2 → 12**; total known defects **70 → 90**. Two of the
    six were fixed at no cost (`library_context`); the other four are in the two hardest
    multi-boundary fixtures — the same two that account for every legacy-router fallback (INC-20).
    By the declared cost function this is a net improvement (≈97 500 lower), because an off-canvas
    label destroys information while an overlapping one degrades readability. **It is a real
    visual trade and it is the reason `labelOffCanvas` was added as a counted class first** — the
    baseline could otherwise only see the cost, never the benefit, and the improvement would have
    looked like a pure regression.
  - **Deferred:** leader lines / callouts / a numbered key. The re-wrap plus clamp already takes
    off-canvas to zero; a leader line is the answer if the residual overlaps prove unacceptable in
    real use, and it now has a declared outcome to hang off.

### Phase 6 — reach + tidy

- [x] **INC-17 · Public API** · *size: small* — `bin` entries only; no `exports` map. Export one
  narrow stable function (`renderDiagram({ source, format }) → { svg, report }`) and treat it as
  the semver surface. Without it, nothing can be built on Nudge — no editor extension, no CI action.
  **Landed:** `src/index.js` exports `renderDiagram`, `parseDiagram`, `detectFormat`, wired through
  `main` + an `exports` map so everything else stays private. Tested through the package entry
  point in `test/integration/public_api.test.js`, which pins the three properties a library
  consumer actually depends on: the SVG is self-contained (styles inlined), the default path makes
  **no network calls**, and it **writes nothing into the caller's working directory** — the CLI's
  `./.nudge` default would have made Nudge unusable inside someone else's build.
- [ ] **INC-18 · Playwright optional** · *size: medium* · needs INC-9 — emit SVG as strings, not
  DOM nodes; Playwright becomes an optional PNG-only dependency.
- [x] **INC-19 · Supported-runtime honesty + CI** · *size: small* — `engines` says `>=18` (EOL)
  while `.nvmrc`/CI say 24. Set `>=20`, run a CI matrix on 20/22/24, cache the Playwright
  download, add `npm run test:refactor` to CI (not run today).
  **Landed:** `engines.node` is `>=20`; CI runs a 20/22/24 matrix with `fail-fast: false`, caches
  `~/.cache/ms-playwright` keyed on the resolved Playwright version (re-installing system deps on a
  cache hit, since those live outside the cached directory), and runs the parity rig after
  `git fetch --unshallow` — it diffs against the renderer at `HEAD`, so it needs real history.
- [x] **INC-20 · Retire the legacy router on a measurable criterion** · *size: medium* — two routers
  + 9 `scripts/*_probe.js` files are live maintenance surface. `CLAUDE.md` says keep the legacy
  router "until every fixture routes fully on the grid" — a condition nothing measures. Make it a
  test (assert zero legacy fallbacks across the corpus); when it passes, delete ~1,800 lines.
  **Landed:** the container router now reports `routerStats { totalEdges, legacyFallbacks,
  legacyFallbackEdgeIds }`, and `test/integration/router_coverage.test.js` ratchets it.
  **Measured: 28 fallbacks across 301 relationships**, entirely within
  `multi_boundary_cross_parent_routes` (8/11) and `nested_boundary_characterization` (6/6).
  Those are also the two fixtures carrying the bulk of the corpus's remaining defects (18 and 12)
  — the relationships the grid router hands off are the same ones that end up crossing and
  overlapping, which makes multi-boundary grid routing the highest-value routing work left.
  The test **fails deliberately when the count reaches zero**, naming the files to delete.
- [x] **INC-21 · Release discipline** · *size: small* — v1.0.0 with no CHANGELOG, no release
  workflow, no npm provenance, no semver policy. State whether changed layout output is a breaking
  change (recommendation: no; every release notes its quality delta vs the INC-6 baselines).
  **Landed:** `CHANGELOG.md` with an explicit versioning policy adopting that recommendation —
  the semver surface is the public API, the CLI flags and the MCP tool schema; **changed layout
  output is not a breaking change**, and in exchange every release states its quality delta
  against the INC-6 baseline. npm provenance and a release workflow are still open.

---

## 4. What "done" looks like

- Any PR shows its quality delta across all six defect classes in the diff.
- A tweak that fixes one diagram and breaks another **cannot merge silently** — today it can, and
  demonstrably has.
- Layout logic is unit-testable in milliseconds without a browser.
- Randomly generated diagrams find edge cases before users do.
- Saturated corridors produce a *declared, tested* output instead of a buried label.
- `npm i` works without a 300 MB browser download and without network access at render time.
- Someone else can build on the library without shelling out to the CLI.

---

## Appendix A — measured defect inventory (evidence)

Full corpus rendered through `normalizeDiagramModel → renderDiagram → analyzeLayout`, counting
**every** class the critic detects (verified at `6bf2988`):

| Defect class | Total | Gated by `npm test`? |
| --- | ---: | --- |
| Element Overlap | 0 | ✅ yes |
| Connection-Line Element Crossing | 6 | ✅ yes — but in `refactor/` fixtures the visual suite never loads |
| Connection-Line Crossing | 20 | ❌ no |
| Connection-Line Overlap | 18 | ❌ no |
| Label-Line Intersection | 4 | ❌ no |
| Connection-Label Element Crossing | 0 | ❌ no (container path) |

**10 of 26 fixtures carry at least one ungated defect.** Worst: `nested_boundary_characterization`
(12 overlaps), `multi_boundary_cross_parent_routes` (6 line-element crossings + 7 crossings + 5
overlaps), `content-delivery-just-in-time` (5 crossings, graded **A**, ✅ PASSED).

### Re-baselined after Phase 0–2 (INC-1…INC-7)

The numbers above were measured over `.mermaid` fixtures only. The checked-in baseline
(`test/fixtures/baselines/quality_baseline.json`, regenerate with `npm run baseline:quality`)
now covers all **36** fixtures — both `core/` and `refactor/`, `.mermaid` and `.puml` — through
the production `normalizeDiagramModel` path. The `.puml` files mirror their `.mermaid` twins
exactly, so the corpus totals are the table above, doubled:

| Defect class | Total (36 fixtures) | Ratcheted? |
| --- | ---: | --- |
| Element Overlap | 0 | ✅ |
| Connection-Line Element Crossing | 12 | ✅ |
| Connection-Label Element Crossing | 0 | ✅ |
| Connection-Line Overlap | 34 | ✅ |
| Connection-Line Crossing | 34 | ✅ |
| Label-Line Intersection | 2 | ✅ |
| Connection-Label Label Overlap *(new class)* | 0 | ✅ |

**70 known defects across 13/36 fixtures**, all declared in the baseline. Every class is now
ratcheted: no count may rise without failing the run, and any that falls must be re-baselined
in the diff. `npm test` no longer prints "🎉 All tests passed" over that corpus — it prints the
per-fixture defect list and states that 70 known defects remain.

Two measurements shifted from the original table once the font race was fixed (INC-2):
`library_context` and `label_crowding_parallel_rels` no longer carry a Connection-Label Element
Crossing. Both were artefacts of first-render fallback-font metrics, which is precisely the
"fixes don't stick because the target moves" failure mode in §1.4.

**The grade tautology:** inside `gradeMathematically`, `clarityScore` and `c4AlignmentScore` are
functions of only `overlapCount`/`intersectionCount`, both pinned at 10, leaving
`(10 + aspectRatioScore + 10)/3` with `aspectRatioScore ∈ {4,7,10}` → every diagram that reaches
the check scores A or B. The grade clause can never fail.

## Appendix B — the nine cost models (root cause #1)

| # | Cost model | Location | Shape |
| --- | --- | --- | --- |
| 1 | Grid router `WEIGHTS` | `grid_connection_line_router.js:18` | additive, 7 terms |
| 2 | Legacy `chooseBestRoute` | `connection_line_router.js:347` | lexicographic tuple |
| 3 | Label `createCandidateScorer` | `connection_label_placement.js:721` | additive, 8 terms |
| 4 | Label `rescueCost` | `connection_label_placement.js:537` | additive, 7 terms |
| 5 | Label `sameTargetScore` | `connection_label_placement.js:1017` | additive, 7 terms |
| 6 | `scoreContainerStep` | `optimizer.js:250` | additive, 10 terms |
| 7 | Canned-config search | `optimizer.js:500` | additive, 8 terms |
| 8 | `gradeMathematically` | `run_tests.js:68` | 3 sub-scores → letter |
| 9 | LLM grader rubric | `run_tests.js:103` | prose |

Models 3, 4, 5 sit in the same file and rank the same two defect classes differently. `c34100d`
fixed the burial-vs-overlap inversion in #4 and left it live in #3 and #5 — the predictable result
of a fix having no canonical home. INC-12/INC-13 collapse this.

### After INC-12 / INC-13 — **4 of 9 remain**

| # | Cost model | Status |
| --- | --- | --- |
| 1 | Grid router `WEIGHTS` | **live** — browser-side; retuning moves every route. Do with INC-15. |
| 2 | Legacy `chooseBestRoute` | **live** — dies with the legacy router (INC-20 measures the criterion) |
| 3 | Label `createCandidateScorer` | reconciled (INC-12) — no longer double-charges; ordering restored |
| 4 | Label `rescueCost` | reconciled (INC-12) |
| 5 | Label `sameTargetScore` | **live** — subsumed by Option C, deferred to INC-16 |
| 6 | `scoreContainerStep` | **collapsed** into `severity.js#scoreLayout` |
| 7 | Canned-config search | **collapsed** into `severity.js#scoreLayout` |
| 8 | `gradeMathematically` | **collapsed** — now derived from the declared ordering, advisory only |
| 9 | LLM grader rubric | prose; advisory, and only on the opt-in `enhance` path |

The single ordering now lives in `src/core/severity.js` and is pinned by
`test/unit/severity.test.js`.

## Appendix C — the browser seam is one function wide

DOM references counted per file across the whole renderer:

| Layer | Files | DOM refs |
| --- | --- | ---: |
| Routing (grid + legacy + visibility graph + helpers) | 6 | **0** |
| Label placement (`connection_label_placement.js`) | 1 | **0** |
| Container planning | 4 | **0** |
| ELK transform, layout policies | 2 | **0** |
| Shared geometry | 1 | **0** |
| Drawing (`svg/*`, `connection_label_rendering.js`) | 5 | 38 |
| Text measurement (`shared/text.js`) | 1 | 1 |

Chromium is required for exactly two things: emitting SVG nodes, and `measureTextWidth`. This is
why INC-9 is the highest structural leverage in the plan.

**Closed by INC-9.** `shared/text.js` is now 0 DOM refs — it measures against a baked glyph
table rather than a canvas. Chromium is required for exactly *one* thing: emitting SVG nodes.
That is INC-18, after which Playwright is a PNG-only optional dependency.

## Appendix D — connection-label placement option catalog

Folded from the label-crowding analysis; INC-9/INC-12/INC-15/INC-16 reference these by letter.

- **A — separate obstacle classes / restore severity ordering.** Element-only obstacles to the
  scorer. Fixes the double-charge. *Must not ship alone* — trades an element burial for a label
  overlap. → part of INC-12.
- **B — enrich the fallback candidate set.** Perpendicular offsets + denser fractions + a
  distance-from-own-route penalty. → part of INC-12.
- **C — one scored candidate pool, one argmin.** Collapse the seven-stage waterfall into
  generate-all → score-all → argmin; no unscored fallthrough. → **INC-12**.
- **D — global assignment across labels.** Top-k per label + min-conflicts local search. Fixes the
  declaration-order lottery. Under-specified until C's generators exist; only if C still shows
  conflicts.
- **E — give labels space at routing time.** Router lateral-clearance term. → **INC-15**.
- **F — repair the critic that already exists.** Rendered box (done `ae1e69c`), stop exempting
  endpoints (done), wire into the container gate. → **INC-4**.
- **G — make renders idempotent.** `document.fonts.load()` per spec. → **INC-2** (durably: INC-9).
- **H — change the label's geometry, not just its position.** Adaptive re-wrap, leader line /
  callout / numbered key for genuinely saturated corridors. → **INC-16**.
