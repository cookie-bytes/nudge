# External corpus

Real C4 diagrams **not authored in this project**.

Grading your own output with your own scorer over your own fixtures is circular:
the hand-authored corpus only contains shapes someone here chose to draw, and
those tend to be shapes the layout engine already handles. Diagrams written by
other people, for their own purposes, are the only non-circular check on whether
Nudge is actually good at C4 layout or merely good at its own test corpus
(docs/IMPROVEMENT_PLAN.md INC-14).

## Provenance

| File | Source |
| --- | --- |
| `bigbankplc_context.puml` | C4-PlantUML `samples/C4_Context Diagram Sample - bigbankplc.puml` |
| `bigbankplc_container.puml` | C4-PlantUML `samples/C4_Container Diagram Sample - bigbankplc.puml` |
| `bigbankplc_component.puml` | C4-PlantUML `samples/C4_Component Diagram Sample - bigbankplc.puml` |
| `bigbankplc_landscape.puml` | C4-PlantUML `samples/C4_Context Diagram Sample - bigbankplc-landscape.puml` |
| `enterprise_context.puml` | C4-PlantUML `samples/C4_Context Diagram Sample - enterprise.puml` |
| `techtribesjs_container.puml` | C4-PlantUML `samples/C4_Container Diagram Sample - techtribesjs.puml` |
| `message_bus_container.puml` | C4-PlantUML `samples/C4_Container Diagram Sample - message bus.puml` |

All from <https://github.com/plantuml-stdlib/C4-PlantUML>, **MIT licensed**,
which permits redistribution with the copyright notice retained. The upstream
notice:

> Copyright (c) 2018 C4-PlantUML contributors
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction...

Files are kept **as fetched**. Do not "fix" one to make it lay out better — that
would reintroduce exactly the circularity the folder exists to avoid. If a
diagram exposes a layout defect, that is the finding; record it in the baseline
and fix the engine.

## Adding more

Drop a `.puml`, `.mermaid` or `.yaml` file in this folder and run:

```bash
npm run baseline:quality
```

The visual suite discovers fixture folders rather than listing them, so new
diagrams are picked up by the quality ratchet and the router-coverage test with
no further wiring. Record the source and licence in the table above.
