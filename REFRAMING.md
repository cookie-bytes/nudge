# Reframing: Deterministic Core, Optional LLM Enhancement

> Status: proposal — parked until the big render-engine refactor lands.
> Origin: concept review session, 2026-06-10.

## The insight

Nudge is currently framed (README, package description) as an **"AI-driven layout
optimizer"**. But the output quality demonstrably comes from the **deterministic
pipeline** — Kahn layering, dedicated bus/database rows, zone classification,
hybrid route scoring, collision-aware connection-label placement. The LLM
visual-hint pass is a one-shot refinement that is only accepted when it does not
worsen the geometric score, i.e. it can only ever be marginal uplift on top of
the deterministic baseline.

Meanwhile, the **single biggest adoption friction** is the thing that contributes
least: requiring a local LLM server (LM Studio) before the tool produces anything.

**Reframe: the product is an opinionated C4 layout engine. The LLM critic loop is
an opt-in polish layer.**

## What changes

### 1. Invert the default

- Deterministic mode becomes the default. No env var, no LLM server, no network
  calls. `npx @cookie-bytes/nudge diagram.mermaid` works after
  `npx playwright install chromium` and nothing else.
- LLM enhancement becomes opt-in: a CLI flag (e.g. `--enhance`) and an MCP tool
  parameter (e.g. `enhance: true`) that run the visual-hint pipeline
  (top-row order → port hints → diagonal routes).
- `NUDGE_NO_LLM=1` becomes redundant in spirit — keep it for backwards
  compatibility or retire it once the flag exists.

### 2. Fix the flat-diagram gap

Container diagrams already have a strong no-LLM baseline. Flat C4Context
diagrams do **not** — the critic loop currently depends on the LLM for ELKjs
parameter patches. For the deterministic-default story to hold, flat diagrams
need a decent no-LLM path. Options:

- A well-tuned static ELKjs config as the baseline, **or**
- A small deterministic parameter search: render 3–4 canned ELKjs configs,
  score each with `analyzeLayout`, keep the best. This reuses the same
  accept-only-if-not-worse gate pattern the container pipeline already uses.

### 3. Reposition the messaging

- README headline: *"Deterministic C4 layout engine, with optional AI polish"*
  (or similar) instead of "AI-Driven Layout Optimizer".
- The opinionated layout rules (200px grid, message buses corner-anchored
  bottom-right, databases paired beneath their owner service) are a **feature**
  — C4 benefits from consistency the way subway maps do. Say so explicitly.
- Publish the LLM uplift honestly: "enhancement improved the geometric score on
  X of Y test diagrams" is a defensible AI claim; "AI-driven" invites people to
  test the AI part and find it marginal.

## Why this is worth doing

1. **Adoption** — friction drops from "install and run a local LLM server" to
   "install chromium once". MCP-first distribution only works if the tool runs
   out of the box.
2. **Honest positioning** — the before/after comparison alone defends the
   deterministic claim. No one can call the AI framing overstated if AI is
   explicitly the garnish.
3. **Clean quality story** — deterministic output is the guaranteed floor; the
   LLM pass is measured uplift on top, reported per diagram.

## Related opportunities noted in the same review (separate decisions)

- **Structurizr DSL ingestion** — much larger, more committed install base than
  Mermaid C4 (which is experimental/semi-abandoned upstream). The YAML schema is
  the better long-term front door; Structurizr DSL widens the funnel.
- **External validation corpus** — run ~20 real-world C4 diagrams *not authored
  in-house* and let the failures drive the heuristics roadmap. The current test
  corpus scores are graded by Nudge's own math scorer, which is circular as a
  quality claim (e.g. `content-delivery-just-in-time` gets an A with 26
  connection-line crossings).
- **D2/TALA comparison in the README** — if Nudge beats TALA on C4 specifically,
  show it with pictures; that is the positioning sentence.

## Checklist when picking this up post-refactor

- [ ] Deterministic mode is the default in CLI and MCP entry points
- [ ] `--enhance` CLI flag / `enhance` MCP param gates all LLM calls
- [ ] Flat C4Context diagrams have a no-LLM baseline (static config or canned-config search)
- [ ] README headline and Features section rewritten around the deterministic core
- [ ] LLM uplift measured and reported across the test corpus
- [ ] Decide separately: Structurizr DSL input, external validation corpus, D2 comparison
