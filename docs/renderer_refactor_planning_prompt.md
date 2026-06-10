# Architectural Refactor Blueprint Prompt: Nudge Renderer

Role: Principal Software Architect and Refactoring Engineer.

## Context

You are working in the Nudge codebase. The renderer lives in `src/render_engine.js`, a roughly 3,000-line browser-side rendering engine. It is difficult to maintain and we want to refactor it into clearer modules using Rule Objects and the Specification Pattern where they naturally fit.

## Primary Goal

Refactor `src/render_engine.js` incrementally while preserving exact behavioral parity.

## Hard Constraint

The renderer output must remain byte-for-byte equivalent according to the existing Golden Master test rig. This is a behavior-preserving refactor, not a redesign.

## Golden Master Protocol

Before changing renderer code, run:

```bash
npm run test:refactor
```

After every small refactor slice, run:

```bash
npm run test:refactor
```

The refactor is acceptable only when every fixture reports:

```text
json=same svg=same
```

The rig renders Mermaid fixtures from `test/` and `test/refactor_fixtures/` using:

1. baseline renderer from the configured git ref, default `HEAD`
2. candidate renderer from the current working tree

It compares normalized render JSON and SVG output byte-for-byte. It must not call LLM APIs, optimizer loops, screenshots, or stochastic paths.

If the legacy renderer is not `HEAD`, use:

```bash
npm run test:refactor -- --baseline-ref <legacy-ref>
```

Do not modify fixtures, relax comparisons, or change the test rig to make failures pass unless explicitly instructed.

If a mismatch occurs, inspect:

```text
test_outputs/refactor_rig/refactor_test_results.json
```

Then fix the candidate renderer until exact parity is restored.

## Domain Language

Use `UBIQUITOUS_LANGUAGE.md` and `AGENTS.md` as the canonical language for domain-level concepts.

Important distinction:

- Prefer Ubiquitous Language for new module names, extracted rule/specification names, documentation, and architecture descriptions.
- Preserve existing implementation-level identifiers where they describe graph, ELK, SVG, browser, or data-shape mechanics, such as `nodes`, `edges`, `children`, `sections`, `ports`, `x`, `y`, `width`, `height`, and ELK option names.
- Do not rename public data model fields or renderer return shapes unless explicitly required and covered by the rig.

## Objective

Before implementation, create an Architectural Refactor Blueprint and Implementation Guide for safely decomposing `src/render_engine.js`.

The guide should be practical enough that another Codex agent can execute it slice by slice while keeping the refactor rig green.

## Required Sections

### 1. Current-State Analysis

- Identify the major responsibilities currently mixed inside `src/render_engine.js`.
- Separate domain-level responsibilities from implementation-level graph/SVG/ELK concerns.
- Identify the riskiest areas for parity regressions.

### 2. Ubiquitous Language Mapping

- Provide a glossary mapping legacy or generic concepts to Nudge domain terms.
- Clearly mark which terms should be used in new domain-facing modules.
- Clearly mark which existing implementation identifiers should remain unchanged for parity and compatibility.

### 3. Target Architecture

- Propose a module structure for decomposing the renderer.
- Explain where Rule Objects are appropriate.
- Explain where the Specification Pattern is appropriate.
- Avoid pattern-for-pattern's-sake abstractions. Use these patterns only where they reduce branching, isolate decisions, or make future rules easier to add.

### 4. Rule and Specification Design

- Define proposed interfaces or object shapes.
- Show how rules/specifications receive input and return decisions without mutating unrelated state.
- Explain how deterministic ordering will be preserved.

### 5. Incremental Refactor Plan

- Break the work into small phases.
- Each phase must be independently testable with `npm run test:refactor`.
- Prefer extraction without behavior changes before any internal cleanup.
- For each phase, list:
  - files/modules to create
  - code to move
  - expected risk
  - validation command
  - rollback strategy if parity fails

### 6. Test Rig Usage During Refactor

- Explain exactly when to run the rig.
- Explain how to interpret failures.
- Explain why fixtures and rig comparisons must not be weakened.

### 7. Future Extension Guidelines

- Explain how a developer should add a new rendering rule without modifying the core orchestration unnecessarily.
- Explain naming conventions using Ubiquitous Language while respecting implementation-level graph/SVG terms.

## Output Format

Produce a professional Markdown document titled:

```text
Architectural Refactor Blueprint & Implementation Guide: Nudge Renderer
```

Use Mermaid diagrams only where they clarify orchestration or module relationships.

Do not implement code yet. Produce the plan first.
