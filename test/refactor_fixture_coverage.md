# Refactor Test Rig Fixture Coverage

The refactor rig uses the existing `test/*.mermaid` files plus focused characterization cases under `test/refactor_fixtures/*.mermaid`. The original fixtures are a useful baseline because they cover both flat context diagrams and container diagrams, including boundaries, databases, queues/message buses, external architecture elements, bidirectional/back/down relationships, labels with punctuation, and explicit `%% Rule:` ordering constraints.

The added refactor fixtures cover the main renderer behaviours that are easy to break during modularisation:

- `dense_context_crossings.mermaid` covers larger flat context layout, ELK pressure, and crossing-prone relationship sets.
- `message_bus_sizing_and_lanes.mermaid` covers multiple message buses, high bus connectivity, and shared route corridors.
- `label_wrapping_and_endpoint_pressure.mermaid` covers long architecture element names, long connection labels, local technology tags, and endpoint-adjacent label placement.
- `external_zone_classification.mermaid` covers diagrams dominated by external people, systems, and data stores.
- `minimal_element_types.mermaid` covers sparse render defaults for each supported architecture element shape.

Diagrams outside the single-Boundary contract (sibling or nested Boundaries) are **not** rig fixtures. They are refused before layout by `src/core/validation.js`, so there is no render to characterise; they live in `test/fixtures/rejected/` and are asserted by `test/integration/unsupported_diagrams.test.js`.

Remaining gaps worth adding if the refactor touches those areas:

- A diagram with several databases under different parents plus direct parent-to-database relationships, if database utility-row placement changes.
- A diagram with explicit parallel duplicate relationships between the same two architecture elements, if relationship identity or lane reservation changes.

Use `npm run test:refactor` before and after renderer changes. By default it compares the working tree candidate against `HEAD`; pass `--baseline-ref <ref>` when the legacy renderer lives on another branch or tag.
