# Implementation plan — Connection Label crowding

Status: **plan, revised twice** — no code changed
Date: 2026-07-21
Implements: [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) increments INC-2, INC-4, INC-12 (Options G, F, C — see Appendix D)
Revision: v3. v1 scored 3.5/10, v2 6.5/10 on independent review; §10 records what changed.

---

## 0. Ground rules

**Branch.** All work on `fix/connection-label-crowding`, cut from `main`.

```bash
git checkout -b fix/connection-label-crowding
```

One commit per stage. All stages land as **one PR** — no intermediate state is safe to ship,
because Stage B makes the defect *consistent* and Stage C makes it *loud* before Stage D fixes
it.

### The three test gates, and what each means during this work

| Command | Meaning | Expected |
| --- | --- | --- |
| `npm test` | unit + integration + render every fixture + boundary containment | Must pass at every stage boundary — **except between Stage C and Stage D**, see below |
| `npm run test:refactor -- --baseline-ref main` | **parity** rig: asserts byte-identical JSON+SVG (`refactor_test_rig.js:256-257`, exits 1 on any diff `:298-304`) | **Will fail by design** from Stage B onward. A change report, never a gate. Default ref is `HEAD` (`:14`) which drifts per commit — always pin `main` |
| `node scripts/capture_route_baseline.js --compare` | the label-metric acceptance gate (built in Stage E) | Must exit 0 at the end of Stage F |

> **The one sanctioned red window.** Stage C lands the *detection* for Connection-Label Element
> Crossings. Two fixtures already carry the defect (§1), so `npm test` goes red the moment
> detection works and stays red until Stage F fixes them. This is expected and enumerated. The
> assertion added in Stage E reads the **allowed** value per fixture from the target table, not
> hard-zero, which is what closes the window. Do not "fix" the red by weakening detection.

**Definition of done:**
1. `label_crowding_parallel_rels` and `library_context` render with 0 Connection-Label Element Crossings.
2. `npm test` passes.
3. `capture_route_baseline.js --compare --strict` exits 0 against the frozen target table (§4).
4. On a **freshly-navigated page**, `renderDiagram` call #1 produces byte-identical output to call #2.
5. Committed render artefacts under `docs/` regenerated (§9).

### Stage order

Stage E's tooling cannot be built before Stage C, because the metrics it captures **do not exist
yet** and the one that does is measured by a broken instrument. The order is therefore:

```
A  fixture + baseline path fix   (no behaviour change)
B  fonts — idempotent renders
C  repair the critic + add both counters to the report
D  ── freeze the target table ──
E  build the acceptance gate on top of C's counters
F  Option C — the placement fix
G  gate success
```

---

## 1. What is actually broken today — measured on the real corpus

v2 quoted numbers from `examples/`. **No harness renders `examples/`.** `run_tests.js:12,440`
scans `test/fixtures/diagrams/core`; `capture_route_baseline.js:20,33-39` and
`refactor_test_rig.js:118-128` scan `test/fixtures/diagrams`. The evidence must come from the
gate's own corpus. Re-measured there:

| Fixture | Label-Element Crossings | Label-Label overlaps |
| --- | --- | --- |
| `library_context` | **1** | 0 |
| `label_crowding_parallel_rels` (new) | **1** | 0 |
| other 10 `core/` fixtures | 0 | 0 |

**`library_context` carries this defect today and reports `Collisions: 0 🎉 Success!`.** It is a
second, independent instance of exactly the bug under repair — and a free extra regression test.
Nothing in `core/` currently has a Label-Label overlap, so the softer treatment of that metric in
Stage G rests on `examples/auction_context` only, which the gate never renders. Say so rather
than implying corpus evidence.

---

## 2. Stage A — Fixture and baseline path (no behaviour change)

### 2a. Move the fixture in

```bash
git mv docs/aims_crowded.mermaid test/fixtures/diagrams/core/label_crowding_parallel_rels.mermaid
```

`examples/aims_context.mermaid` with two edits that together produce the defect: `iam→aims`
label grown to 3 rendered lines, `mcm→aims` split into two parallel Relationships. Verified
minimal — reverting either edit renders clean. Auto-discovered by all three harnesses.

Every other `core/` fixture ships as a `.mermaid`/`.puml` pair. Add the `.puml` sibling, or state
in the commit why not.

### 2b. 🔴 Fix the baseline script's layout path

`capture_route_baseline.js:103-104` calls `parseMermaidC4` then `window.renderDiagram(model)`
**without `normalizeDiagramModel`**. Our fixture is a `C4Context` with `Person`/`System_Ext`, so
under the CLI it gets the synthetic boundary (`optimizer.js:149-162`) and takes the **container**
path, but under the baseline script it has no boundary and takes the **flat ELK** path — measuring
a layout the defect does not live in. Import and apply `normalizeDiagramModel` here and in
`route_ab_compare.js`.

This changes existing numbers for every context fixture. That churn is a **bug fix** and belongs
in its own commit, first.

```bash
npm test
```

**Commits:** `fix(baseline): normalize diagram model before capturing route metrics` /
`test: add parallel-relationship label crowding fixture`

---

## 3. Stage B — Option G: idempotent renders

### The diagnosis (v1 got this wrong; independently reproduced twice)

`render_engine.js:8` **already** awaits `document.fonts.ready`, added in `163ce46`. That await is
insufficient:

```
await document.fonts.ready   →  ready:true, status:'loaded', check('11px Outfit'): FALSE
render 1 { h: 1108 }   ← fresh page reproduces this
render 2 { h: 1092 }
render 3 { h: 1092 }   ← stable thereafter
```

`render.html:8` pulls Outfit from Google Fonts, whose `@font-face` rules carry `unicode-range`,
so faces are fetched **lazily on first use**. All 10 declared faces report `status: unloaded` when
`fonts.ready` resolves. Render 1 measures in the fallback font (183.031 px for the offending
label) and *itself* triggers the fetch — too late for its own measurement. Render 2 gets Outfit
(180.001 px). `optimizer.js` renders the same model twice (`:304` `step_0_initial`, `:333`
`step_1_label_hints` when `enhance` is off), so the two disagree.

### The fix

```js
await Promise.allSettled([
  document.fonts.load('11px Outfit'),
  document.fonts.load('500 13px Outfit'),
  document.fonts.load('600 13px Outfit'),
  document.fonts.load('700 16px Outfit'),
  /* …every weight/size in render.html's <style> */
]);
```

Three constraints, each load-bearing:

1. 🔴 **`allSettled`, never bare `Promise.all`.** Measured with `fonts.gstatic.com` blocked:
   `document.fonts.ready` resolves fine, but `load()` **rejects** with `NetworkError`. That
   rejection lands inside the `try {` at `render_engine.js:7` and turns a cosmetic font fallback
   into `{success:false}` → `optimizer.js:305` bails with **no diagram at all**. The repo already
   knows this network path is flaky — `56a0fd3` exists for restricted CI sandboxes.
2. 🔴 **Enumerate every weight/size from `render.html`'s `<style>`** — it uses 500 (`:111`),
   600 (`:42`), 700 (`:117`) among others. Loading only `11px Outfit` leaves
   `check('700 16px Outfit')` false and the bug intact for those runs.
3. 🟡 **`load()` only fetches the subset matching its test string** (default `'BESbswy'`). A
   diagram with non-Latin labels re-triggers the identical bug via a different `unicode-range`
   subset. Pass representative text, or accept the limitation explicitly in the commit message.

### 🔴 Self-hosting is now the right call — for a reason v2 missed

v2 dropped self-hosting on dependency cost. But Stage E makes `route_quality_baseline.json` an
**exit-non-zero acceptance gate**, and with fonts blocked `document.fonts.size === 0` → every
label measured in fallback → different widths → **different label metrics**. A CI runner without
egress to `fonts.googleapis.com` fails the gate spuriously, forever.

Either self-host Outfit (add `@fontsource/outfit`, extend the `postinstall` copy step that
already copies `elkjs` into `src/vendor/`, and license-check it), **or** state explicitly in the
plan and in CI config that the baseline is only valid with network access. Do not leave this
undecided — it silently determines whether the acceptance gate is reproducible.

### Verify — note the exact invariant

```bash
npm test
```

Add a test asserting: **on a freshly-navigated page, `renderDiagram` call #1 output equals call
#2 output** (width, height, and SVG).

> 🔴 Not "two consecutive calls are identical." Today calls 2, 3 and 4 already *are* identical —
> only call 1 differs. An agent that warms the page, or reuses one from another test, gets green
> on unfixed code. The fresh-page qualifier is the whole test.

**Expect output to get worse here.** The *second* render is the one that buries the label, and
the second render is the one with the correct font. Making render 1 match render 2 makes **both**
fail identically. Stage B converts an intermittent defect into a consistent one — necessary for
measurement, not progress.

**Commit:** `fix(render): explicitly load webfonts so renders are idempotent`

---

## 4. Stage C — Option F: repair the critic

Connection-Label Element Crossing is **already** detected — `geometry.js:515` emits
`type: 'edge_label_node_crossing'`, and `optimizer.js:551-556` / `:605-610` gate `success` on it
for the flat/ELK path. Three things stop it firing here.

**4a. It scores a phantom box.** `geometry.js:430-498` re-implements a simplified placement
waterfall; the label box is then built from its `midX`/`midY` at **`geometry.js:501-508`**.
Replace **430–508 as a unit** with a read of the rendered `label.x`/`label.y` that the renderer
writes at `connection_label_rendering.js:267-268`. `estimateLabelBox` (**`geometry.js:163`**)
already reads the rendered values for a different metric — follow that pattern.

- Editing only 430–497 leaves `midX`/`midY` undefined at `:504-505`.
- Also delete the now-orphaned local `checkLabelCollision` helper (~`:404-428`) and `nearbyComps`;
  nothing else uses them.

**4b. It exempts the endpoints.** `geometry.js:511`:
```js
if (comp.id === sourceId || comp.id === targetId) continue;
```
In this repro the label is buried in **MCM, its own source element**. Remove the exemption.

**Order matters: 4a before 4b.** Removing the exemption while still scoring a phantom box
produces false positives. Precise definition, so §8's abort criterion is testable: a false
positive is `edge_label_node_crossing` reported for a label whose **rendered** box does not
overlap the element. After 4a that is impossible by construction.

**4c. Add BOTH counters to the report.** 🔴 Neither exists today:

- `labelElementCrossingCount` — derivable from `report.collisions`, but only *meaningful* after
  4a/4b.
- `labelLabelOverlapCount` — **no implementation anywhere in `src/core/`**. `analyzeEdgeQuality`
  (`geometry.js:229-236`) has exactly six fields, none label-label. The only label-overlap
  counting in the repo is browser-side at `connection_label_placement.js:922`, never returned in
  the report. **This is new geometry in `geometry.js`, not plumbing.**

**4d. Surface them in all three entry points.**
- `optimizer.js:433`, `:546`, `:600` — the `history` entries
- 🔴 **`src/cli/index.js:93-101`** — `console.table` uses a hardcoded key projection
  (`Iter`, `Collisions`, `Overlaps`, `Crossings`, …). New history fields are **silently
  discarded** unless this projection is edited.
- 🔴 **`src/mcp/index.js`** — builds its own JSON summary from the same history. Decide and state
  whether the counters appear in the MCP tool response.

**4e. Do not gate `success` yet.** Report only; gating is Stage G.

### Verify

```bash
npm test    # expected: library_context and label_crowding_parallel_rels now REPORT the defect
```

Add a unit test in `test/unit/geometry.test.js` feeding a hand-built layout model with a label box
overlapping **its own source element**, asserting one `edge_label_node_crossing`. This pins 4b and
cannot be satisfied by the current code.

**Commit:** `fix(critic): score the rendered label box and stop exempting endpoint elements`

---

## 5. Stage D — Freeze the target table

Now that Stage C's counters exist and mean something, capture the truth **once** and freeze it.

```bash
node scripts/capture_route_baseline.js
```

Commit a table of every fixture × `labelElementCrossings`, `labelLabelOverlaps`,
`labelLineIntersections`, `connectionLineCrossings`, with two columns:

- **current** — falls out of the tool
- **required** — **`0` for every fixture. This is a stated hypothesis, and it is frozen.**

> 🔴 **The agent may not edit the required column.** v2 let the agent "update the target table
> with the reasons" when Stage F fell short. An acceptance gate the executor is authorised to
> rewrite on failure is not a gate — it just moves the subjectivity from "does this PNG look
> right" to "which non-zeros did the agent decide were acceptable". Any fixture that cannot reach
> 0 is a **hard stop that escalates to a human**, who makes the Option E / Option H call per §8.

Expected current values, from §1: `library_context` 1, `label_crowding_parallel_rels` 1, rest 0.
If Stage B or C moved anything else, that is information — record it, do not smooth it.

**Commit:** `test: freeze per-fixture label-quality target table`

---

## 6. Stage E — Build the acceptance gate

Tooling only, no behaviour change. This is where v2 put Stage 0; it cannot come earlier because
until Stage C the metrics either don't exist or are measured by the broken critic.

**6a. Add the label metrics to the baseline.** `capture_route_baseline.js:122` already records
`labelLineIntersections: report.edgeQuality.labelEdgeIntersectionCount` (note: the report field is
`labelEdgeIntersectionCount`; `labelLineIntersections` is the baseline's own name for it). Add
`labelElementCrossings` and `labelLabelOverlaps` from Stage C's counters. Mirror both in the
`keys` array at `route_ab_compare.js:117`.

**6b. 🔴 Implement `--compare` — it does not exist.** `parseArgs` (`:23-30`) accepts **only**
`--output`; `--compare` exits `Unknown argument: --compare`. There is no comparison mode at all.
Build one: read the committed baseline, re-render every fixture, emit a per-fixture delta table,
**exit non-zero** on any regression in the four label/line metrics. Add `--strict`, which reads
the frozen target table and fails unless every fixture meets its **required** value.

**6c. Add label assertions to `npm test`.** `run_tests.js` already calls `optimizeDiagram`
(`:249`, `:304`, `:350`, `:397`) and asserts boundary containment (`:504-506`). Extend that
mechanism to fail on Connection-Label Element Crossings — reading each fixture's **allowed**
value from the target table, not hard-zero. This is what closes the sanctioned red window from
§0: between Stage C and Stage F the two known-bad fixtures are allowed their current 1; Stage F
drives them to 0 and the allowance drops with them.

```bash
npm test && node scripts/capture_route_baseline.js --compare
```

**Commit:** `test: add label-quality metrics and --compare acceptance gate`

---

## 7. Stage F — Option C: one candidate pool, one argmin

The substantive change. Confined to
`src/renderer/labels/connection_label_placement.js` (954 lines) and its caller
`connection_label_rendering.js`. **Routing, layout, the container plan, the ELK path, SVG drawing
and the parser are untouched.**

### Complete classification of the file (952 of 954 lines)

| Current | Lines | Fate |
| --- | --- | --- |
| `boxesOverlap`, `lineSegmentIntersectsBox`, `labelBoxAt`, `checkLabelCollision`, `labelEdgeHitCount`, `createLineSampler`, `classifyMessageBusLabel`, `sharedTargetDatabaseLabelPressure` | 162 | **untouched** |
| `scoreCandidate` (`:602-646`) | 44 | kept, reweighted |
| `createAnchorCandidate`, `findSourceSideRouteBandPlacement`, `findClearMidpointPlacement`, `findMiddleGutterPlacement`, `rescueLabelFromConnectionLineHits`, `spreadSameTargetDatabaseLabel`, `nudgeLabelVertically` | 332 | become **generators** — point-producing geometry survives, per-stage accept/sort tails deleted |
| `chooseInitialLabelPlacement`, `adjustFinalLabelPlacement`, `createPlacementAdapters`, `tryAnchorPlacement`, `findRelaxedSourceAnchorPlacement`, `createCandidateScorer` | 319 | **deleted**, replaced by ~40 lines of generate-all → score-all → argmin |
| `prepareLabelContext` (`:51`), `createCollisionAccessors` (`:123`) | 81 | **kept, trimmed** — drop accessors the deleted stages needed |
| `getAnchorOrder` (`:109`) | 6 | **deleted** — encodes ordering, which 7d abolishes; intent becomes a score bias |
| `createLabelObstacles` (`:119`) | 4 | **deleted** — merging `placedLabels` into the element list *is* the bug in 7a |
| `createElementObstacles` (`:115`) | 4 | **kept** — becomes the sole obstacle builder |

Net deletion. The seven stages are not seven algorithms — they are one algorithm with six escape
hatches, each carrying an unweighted policy decision in an accept gate such as
`tryAnchorPlacement:688`:

```js
if (candidate.nodeCollision > 0 || candidate.edgeHits > 0 || candidate.labelHits > 0) return false;
```

### Sub-steps — commit boundaries are load-bearing

**7a. Fix the priority inversion.** `connection_label_rendering.js:75` builds
`obstacles = createLabelObstacles(allComponents, boundaryBorderObstacles, placedLabels)` and passes
it to `createCandidateScorer` (`:79`), where it feeds `nodeCollision`
(`connection_label_placement.js:621`) — while `labelHits` is computed *independently* from
`placedLabels` at `:623`. A label-overlapping candidate is charged both terms (150 000); one
buried in an element costs 100 000 (`:636-638`). Pass element-only obstacles; weight element
burial 100 000, label 40 000, line 9 000.

> **Never commit 7a alone.** Simulated on the repro, element-only obstacles flip the gutter winner
> to `(1228, 325)`, which has `labelHits = 1`, and `nudgeLabelVertically` fails all six `±y`
> offsets from there — converting the element burial into a label overlap.

**7b. Enrich the candidate set.** `findMiddleGutterPlacement:798-858` samples only
`[0.25, 0.5, 0.75]` (`:814`) on the polyline — for the repro's three-segment route (18 px stub,
180 px drop, 18 px stub) that is nine candidates, every one colliding. `(1301.5, 325)` is clear of
every element and every placed label and is never generated. Add perpendicular offsets (reuse the
generator at `rescueLabelFromConnectionLineHits:483-489`), denser fractions, and a
**distance-from-own-route penalty** so labels don't drift off their line.

**7c. Give `nudgeLabelVertically` a horizontal axis** (`:860-888`). It *does* fire here and fails
all six offsets purely because it only varies `y` and can never reach `x ≈ 1301`.

**7d + 7e — atomic, one commit.** Collapse every generator into one scored pool with a single
argmin, and simultaneously convert ordering preferences into score biases. These cannot be
separated: deleting the waterfall removes the mechanism that currently expresses the preferences.
Preferences to preserve as biases: try-midpoint-first, source-side for message-bus labels,
target-anchor before source-anchor. `preferSourceSideLabel` / `sourceDistanceBias` (`:628-630`)
shows the pattern.

**Canary assertions for 7e — required.** "Message-bus labels drift to the wrong end of their line"
is only visually obvious *to a human*. Add golden assertions on `messaging_system.mermaid` and
`search_service_container.mermaid`: each message-bus Connection Label's centre must lie in the
source half of its own polyline.

### Verify — objective only

```bash
npm test
node scripts/capture_route_baseline.js --compare --strict     # must exit 0 against the frozen table
npm run test:refactor -- --baseline-ref main                   # change report for the HUMAN reviewer
```

> The `test:refactor` SVG diffs are for the human reviewing the PR, not a gate the agent can
> evaluate. The agent runs it and attaches the output; it does not judge it.

**Commits:** `fix(labels): score elements and placed labels independently` (7a+7b+7c) then
`refactor(labels): single scored candidate pool for Connection Label placement` (7d+7e)

---

## 8. Stage G — Gate success, then abort criteria

Only once `--compare --strict` exits 0. Add `labelElementCrossingCount` to the container/context
success criterion at `optimizer.js:440`
(`success = report.overlapCount === 0 && report.intersectionCount === 0`), alongside the flat
path's existing `hardCollisions` treatment.

Whether `labelLabelOverlapCount` gates or merely warns is a **judgement call for the human**. The
only evidence either way is `examples/auction_context` (one overlap, 4379 px²), which the gate
corpus never renders. Present it; do not decide it autonomously.

**Commit:** `feat(critic): gate success on Connection-Label Element Crossings`

### Abort criteria — all testable, all escalate

- **Stage B:** on a fresh page, render #1 still differs from render #2 after the explicit font
  load. Something else leaks state; find it before Stage F, because every Stage F measurement
  depends on idempotent renders.
- **Stage C:** any `edge_label_node_crossing` reported for a label whose **rendered** box does not
  overlap the element ⇒ 4a did not actually switch to the rendered box.
- **Stage F:** `--compare --strict` cannot reach the frozen table. **Stop and escalate to a
  human.** Do not edit the table, and do not tune weights until the number moves. This is the
  signal that a corridor is genuinely saturated and the answer is Option E (router
  lateral-clearance term) or Option H (leader line / adaptive re-wrap) — a scope decision that is
  not the executor's to make.

---

## 9. The LLM-enhanced path, and artefacts

Everything above runs with `enhance` off — the **default**: `cli/index.js:40` reads
`const enhance = hasEnhance && !process.env.NUDGE_NO_LLM;`, so `NUDGE_NO_LLM` is belt-and-braces
and the real gate is the absent `--enhance` flag.

But Stage F changes `scoreCandidate`, and the enhance block (`optimizer.js:308-331`) accepts or
rejects LLM label hints via `renderAndMaybeAccept` (`:286-291`) using `scoreContainerStep`
(`:244`) — two cost models that must not disagree. **Required:** run at least one fixture through
`--enhance` after Stage F and confirm hints are still accepted/rejected sensibly. If the LLM is
unavailable, say so in the PR rather than claiming it was checked.

**Stale artefacts.** Stage F moves labels in every diagram, so committed renders go stale:
`docs/search_service_container.svg`/`.png`, `docs/core-banking-single-boundary.svg`/`.png`,
`docs/example_output.png`. Regenerate in the final commit.

Commit messages follow the recent Conventional Commits style visible in `git log`
(`feat(cli):`, `chore:`); note the log is mixed and the convention is not enforced.

---

## 10. Revision history

**v2 → v3** (review scored v2 6.5/10, verdict "not yet safe to hand to an agent"):

| Issue | Fix |
| --- | --- |
| 🔴 Stage 0 was circular — `labelLabelOverlaps` has **no implementation in `src/core/`** (`geometry.js:229-236` has six fields, none label-label), and `labelElementCrossings` only existed via the broken critic | Split: fixture + baseline path first (Stage A), tooling moved **after** the critic repair (Stage E). Adding `labelLabelOverlapCount` is now correctly scoped as new geometry, not plumbing |
| 🔴 `npm test` required to pass while Stage 2 made it fail — v1's impossible gate recreated on a different command | §0 declares one sanctioned red window (Stage C→F) and Stage E's assertion reads per-fixture **allowed** values from the frozen table |
| 🔴 Target table's "required" column was agent-editable on failure | Frozen at `0` for all; any shortfall is a **hard stop escalating to a human**, plus `--compare --strict` |
| 🔴 Stage 1 regression test passed on broken code — calls 2/3/4 are already identical, only call 1 differs | Invariant restated as **fresh-page call #1 vs call #2** |
| 🔴 `document.fonts.load()` **rejects** where `fonts.ready` doesn't (measured: `NetworkError` with gstatic blocked), inside the `try` at `render_engine.js:7` ⇒ total render failure | `Promise.allSettled`; noted against `56a0fd3`'s CI-sandbox precedent |
| 🔴 Dropping self-hosting contradicted the new gate — with fonts blocked `document.fonts.size === 0`, every metric shifts, so the acceptance baseline is network-dependent | Reopened as an explicit decision that must be made, not defaulted |
| 🟡 Only `11px Outfit` loaded; `render.html` uses weights 500/600/700 (`:111`, `:42`, `:117`), and `load()` only fetches the subset matching its test string | Enumerate every spec; non-Latin limitation stated |
| 🟡 No baseline recapture after the critic repair ⇒ stale table entering Stage F | Capture happens once, in Stage D, *after* Stage C |
| 🟡 Evidence came from `examples/`, which **no harness renders** | Re-measured on `test/fixtures/diagrams/core` — surfacing `library_context` as a second live instance (§1) |
| 🟡 Ref drift: `optimizer.js:303→304`, `:336→333`, `:308-333` straddled the `else`; orphaned `checkLabelCollision`; `createElementObstacles` fate unstated | All corrected |

**v1 → v2** (v1 scored 3.5/10): Stage 1 was a no-op (`render_engine.js:8` already had
`fonts.ready`, from `163ce46`) — re-diagnosed as lazy `unicode-range` loading; `test:refactor`
demoted from an unpassable gate to a change report; `--compare` identified as non-existent;
`cli/index.js:93-101`'s hardcoded projection added; `geometry.js` ranges corrected to 430–508,
`:163`, `:605-610`; Stage 3 classification completed; 7d+7e made atomic; self-hosting dropped
(later reopened); `capture_route_baseline.js` missing `normalizeDiagramModel` found.

---

## 11. Out of scope

Options D (global assignment across labels), E (router lateral clearance) and H (leader lines,
adaptive re-wrap, layout-time corridor widening). D is under-specified until F's generators exist;
E and H are justified only if `--compare --strict` shows unsatisfiable conflicts — a human
decision per §8.
