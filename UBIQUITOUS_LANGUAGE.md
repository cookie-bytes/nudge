# Ubiquitous Language

## Diagram model

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Diagram Model** | The normalized in-memory representation of a Mermaid, YAML, or C4-PlantUML architecture diagram. | Graph, spec, input JSON |
| **Diagram Source** | The user-authored Mermaid, YAML, or C4-PlantUML content that Nudge parses into a **Diagram Model**. | File, raw diagram |
| **C4 Context Diagram** | A C4 diagram that shows people, software systems, and external systems. Its internal systems are wrapped in a **Synthetic Boundary** during normalization, so it renders through the **Container Layout Engine**. | Flat diagram, context graph |
| **C4 Container Diagram** | A C4 diagram that contains at least one system boundary and shows containers inside it. | Nested diagram, boundary diagram |
| **Boundary** | A C4 system boundary that groups child architecture elements belonging to one system. | Box, group, container boundary |
| **Synthetic Boundary** | The hidden boundary (`_synthetic: true`) that `normalizeDiagramModel` wraps around a context diagram's internal elements so it can reuse the container pipeline. Never drawn. | Fake boundary, invisible box |
| **In-Scope System** | The focal architecture element of a **C4 Context Diagram**, detected during normalization and made prominent by colour rather than by position. | Main system, central node, focus |
| **Supporting System** | A non-focal internal architecture element in a context diagram, styled to recede behind the **In-Scope System**. | Secondary system, background node |
| **Annotation Note** | Free text attached to an architecture element or relationship. A Nudge extension over C4 syntax; notes are annotations, never layout participants. | Comment, callout, label |
| **Architecture Element** | A diagram item representing a person, software unit, storage system, message bus, or external system. | Node, entity, box, component |
| **Person** | A human actor represented as an architecture element. | User, actor |
| **Container** | A runnable software unit inside or outside a boundary. | Service, app, component |
| **Database** | A persistent storage architecture element rendered with database-specific styling and routing behavior. | Store, DB, datastore |
| **Message Bus** | An asynchronous messaging architecture element rendered as a widened routing hub when highly connected. | Queue, event bus, broker |
| **External Element** | An architecture element outside the primary boundary that interacts with boundary children. | External node, external system, outside node |
| **Relationship** | A directed semantic connection in the source model from one architecture element to another with an optional label and technology note. | Rel, edge declaration, dependency |
| **Rule** | A source-level ordering constraint such as `%% Rule: Container above ContainerDb`. | Hint, layout comment |
| **Node** | An implementation-level graph object used by ELKjs and renderer internals for an **Architecture Element**. | Architecture Element, entity |
| **Edge** | An implementation-level graph object used by ELKjs and renderer internals for a **Relationship**. | Relationship, connection line |

## Layout engines

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Critic Loop** | The iterative flat-diagram process that renders, critiques, asks for an ELKjs patch, and rerenders. Reached only by diagrams that stay flat after normalization — no boundary, and no person/external split to wrap. | Optimization loop for all diagrams, feedback loop |
| **ELK Layout** | The ELKjs layered layout used for diagrams that take the flat path. | Automatic layout, standard layout |
| **Normalization** | The `normalizeDiagramModel` pass that infers the diagram type, detects the **In-Scope System**, and adds the **Synthetic Boundary**. Every entry point runs it before rendering. | Preprocessing, model prep |
| **Container Layout Engine** | Nudge's deterministic renderer for **C4 Container Diagrams**. | Custom layout, manual layout |
| **Kahn Layering** | The topological layering pass that orders boundary children into internal rows. | Topological sort, layer assignment |
| **Utility Row** | A dedicated internal row for databases or message buses that should not participate in normal service layering. | Special row, sink row |
| **External Zone** | A placement area outside the boundary: above, below, left, or right. | Side, lane, area |
| **Connectivity Sort** | The deterministic ordering of external elements by the internal layer or column they connect to. | Zone ordering, external sorting |
| **Layout Override** | A renderer input under `_layoutOverrides` that applies accepted visual hints. | Patch, hint payload |
| **Internal Order** | A layout override that replaces the left-to-right order of a boundary layer. | Top order, row order |
| **Port Hint** | A layout override requesting the source or target side used by a specific relationship. | Side hint, endpoint hint |
| **Route Hint** | A layout override requesting a route intent for a specific relationship. | Path hint, routing override |
| **Note Placement** | A layout override choosing the side (`over`, `below`, `left`, `right`) on which an **Annotation Note** sits. | Note side, annotation hint |

## Routing and labels

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Connection Line** | The visible line that represents a relationship between two architecture elements. | Edge, line, connector |
| **Route** | The geometric path chosen for a connection line from source architecture element to target architecture element. | Line, edge path |
| **Connection Point** | The point on an architecture element's face where a connection line begins or ends. | Port, anchor, endpoint |
| **Grid Router** | The default pathfinding-based router that routes connection lines using A* search over a sparse orthogonal visibility graph. | Geometric router, A* router |
| **Visibility Graph** | A sparse orthogonal visibility graph generated at inflated element boundaries, centerlines, and channel midlines. | Search graph, uniform pixel grid |
| **Rip-Up-and-Reroute** | The optimization loop that repeatedly selects the worst-scoring routed lines, removes them, and re-routes them against the rest. | Rerouting, route retry |
| **Channel Nudging** | The post-routing phase that resolves overlapping line segments within shared channels by spreading them into separated lanes. | Spreading, route nudging |
| **Kink Straightening** | The post-routing phase that collapses short (<24px) Z-jogs left by discrete port slots, by sliding dock points along element faces. | Jog removal, smoothing |
| **Port Slot** | One of the discrete positions along an element face at which the grid router may dock a connection line. Reuse of a slot is priced by the router's weights. | Anchor slot, dock point |
| **Connection Label** | The rendered relationship text and optional technology note placed near a connection line. | Edge label, relationship label |
| **Technology Note** | The bracketed transport or implementation detail shown beneath a connection label. | Protocol, tech label |
| **Label Placement** | The collision-aware process that chooses where a connection label should appear. | Text placement, label routing |
| **Direct Database Drop** | A straight vertical route from a parent container to a column-aligned database (handled in legacy fallback). | DB drop, persistence line |
| **Gutter Route** | A detour that uses reserved side space inside or outside a boundary (handled in legacy fallback). | Perimeter route, side detour |
| **Route Candidate** | A possible route considered by the legacy router before scoring chooses one. | Option, path option |
| **Route Intent** | A high-level routing preference such as `LEFT_LANE`, `RIGHT_LANE`, or `ORTHOGONAL_NEAR_TARGET`. | Route style, path mode |
| **Lane Reservation** | The legacy local offsetting of interior route segments to reduce unavoidable shared corridors. | Lane routing, line spreading |
| **Second-Pass Rerouting** | The legacy bounded reroute attempt for the worst route-conflict offenders after initial routing. | Rerendering, route retry |

## Quality and scoring

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Geometric Critique** | The deterministic analysis of rendered geometry for layout defects and diagnostics. | Collision report, layout analysis |
| **Severity Ordering** | The single declared ranking over the defect classes, and the one cost function derived from it. Lives in `src/core/severity.js`. There is deliberately no second cost model. | Weights, scoring rules |
| **Collision** | A hard visual defect that destroys information and fails the **Absolute Gate**: **Element Overlap**, **Connection-Line Element Crossing**, **Connection-Label Element Crossing**. | Defect, issue, warning |
| **Absolute Gate** | The `isClean` check: the information-destroying classes must be exactly zero for a layout to be called successful. | Pass/fail, success check |
| **Quality Ratchet** | The per-fixture rule that no tracked defect count may *rise* against the checked-in baseline. Holds the readability classes flat where an absolute gate would be permanently red. | Regression gate, snapshot test |
| **Element Overlap** | A collision where two architecture element boxes intersect. | Node overlap, box collision |
| **Connection-Line Element Crossing** | A collision where a connection line intersects an architecture element that is not its source or target. | Edge-node crossing, line-node crossing |
| **Connection-Label Element Crossing** | A collision where a connection label overlaps an architecture element. | Edge-label-node crossing, label collision |
| **Label-Label Overlap** | A defect where two connection labels share pixels. Ranks with the information-destroying classes: both labels become unreadable. | Text collision, label clash |
| **Label Off-Canvas** | A defect where a connection label is clipped by or falls outside the canvas. Ranks with **Connection-Label Element Crossing** — an invisible label destroys information just as surely as a buried one. | Clipped label, lost label |
| **Tight Spacing** | A spacing warning where architecture elements are closer than the configured comfort threshold. | Near miss, spacing issue |
| **Connection-Line Crossing** | A readability metric where two connection lines cross each other away from shared endpoints. | Edge-edge crossing, line crossing |
| **Connection-Line Overlap** | A readability metric where two non-bundled connection lines share a long segment. | Edge overlap, shared corridor, stacked line |
| **Label-Line Intersection** | A readability metric where a rendered connection label intersects a connection line. | Label-edge intersection, label hit |
| **Note Overlap** | A defect where an **Annotation Note** occludes an architecture element or another note. Scored under the shared ordering so note placement does not invent its own. | Annotation collision |
| **Note-Line Crossing** | A defect where an **Annotation Note** sits across a connection line. | Note hit, annotation crossing |
| **Boundary Violation** | A ratcheted defect where a boundary child is placed outside its parent boundary's box. | Containment break, escape |
| **Orthogonality Violation** | A ratcheted defect where a connection-line segment is neither horizontal nor vertical. | Diagonal line, non-orthogonal |
| **Advisory Metric** | A shape/cost measure tracked to make route churn visible in the diff, but never pass/fail: overlap pixels, total bends, total route length. | Soft metric, warning metric |
| **Layout Score** | The output of `scoreLayout` — the one cost function over a critique report. Used by the visual-hint accept/reject loop, the canned-configuration search, and the test grader alike. | Geometry score, quality score, candidate score |
| **Math Grader** | The deterministic test grader used by default and as a fallback. | Fallback grader, built-in grader |
| **Visual Grader** | The optional LLM-based test grader enabled by `NUDGE_VISUAL_TEST=true`. | LLM grader, visual LLM critique |

## Optimization and tools

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Visual-Hint Pipeline** | The one-pass container optimization flow. It runs a single connection-label placement step on top of the deterministic baseline, then the **Note Placement Search**. | Checkpoint pipeline, LLM checkpoint |
| **Visual Hint** | A local-LLM suggestion derived from already rendered container geometry. | Checkpoint, recommendation |
| **Note Placement Search** | The deterministic loop that retries each overlapping **Annotation Note** on other sides, keeping the first non-overlapping placement and otherwise restoring the author's hint. | Note fixing, annotation retry |
| **Canned Configuration Search** | The deterministic flat-diagram fallback that tries a fixed list of ELKjs spacing configurations and keeps the best **Layout Score**. Used when LLM enhancement is off. | Brute force, config sweep |
| **Staged Snapshot** | A PNG captured for one container visual-hint stage. | Step image, intermediate render |
| **Accepted State** | The best non-worsening container render kept after evaluating visual hints. | Current state, final state |
| **ELK Patch** | A JSON update to ELKjs layout options suggested for a flat diagram. | Layout patch, parameter patch |
| **Legend** | The horizontal key drawn at the bottom-left of container and context diagrams, showing only the element kinds actually present. Icons reuse the real shape drawers. | Key, caption |
| **Baked Font Metrics** | The generated Outfit glyph-advance table that text measurement uses instead of a canvas call, so measurement is pure JS and unit-testable. | Font table, text metrics |
| **Self-Contained SVG** | The final SVG export with renderer styles embedded inside the SVG. | Optimized SVG, inline SVG |
| **MCP Tool** | The stdio-exposed `optimize_diagram` operation used by MCP clients. | Server command, external tool |
| **Cancellation Chain** | The signal path from MCP request cancellation through optimizer calls to fetch timeouts. | Abort path, timeout chain |
| **Deterministic Mode** | A run that uses Nudge's deterministic renderer and skips LLM enhancement calls. Enabled by default; AI polish is opted into with the CLI flag `--enhance` or MCP parameter `enhance: true`. | Offline mode, no-AI mode |

## Relationships

- A **Diagram Source** is parsed into exactly one **Diagram Model**.
- A **Diagram Model** contains zero or more **Architecture Elements**, zero or more **Relationships**, and zero or more **Rules**.
- A **C4 Container Diagram** contains one primary **Boundary** with child **Containers**, **Databases**, and **Message Buses**.
- A **Relationship** has exactly one source **Architecture Element** and exactly one target **Architecture Element**.
- A **Connection Line** renders exactly one **Relationship**.
- A **Route** is the geometry of exactly one **Connection Line**.
- A **Connection Line** has exactly two **Connection Points**: one on the source architecture element and one on the target architecture element.
- A **Port Hint** requests the side of an architecture element on which a **Connection Point** is placed.
- A **Connection Label** belongs to exactly one **Relationship**.
- **Normalization** gives a **C4 Context Diagram** a **Synthetic Boundary**, so it uses the **Container Layout Engine** — not the **Critic Loop**.
- The **Critic Loop** and **ELK Layout** apply only to diagrams that stay flat after normalization.
- A **C4 Context Diagram** has at most one **In-Scope System**; its other internal elements are **Supporting Systems**.
- A **C4 Container Diagram** uses the **Container Layout Engine** and may use the **Visual-Hint Pipeline**.
- A **Visual Hint** becomes a **Layout Override** only when its candidate render is accepted into the **Accepted State**.
- A **Geometric Critique** produces **Collisions**, spacing warnings, and readability metrics.
- A **Layout Score** ranks any two critiques; the **Severity Ordering** is the only place its weights are declared.
- An **Absolute Gate** failure is a **Collision**; every other tracked class is held flat by the **Quality Ratchet**.
- An **Annotation Note** is attached to an **Architecture Element** or a **Relationship** and never participates in layout.
- A **Self-Contained SVG** is exported from the final rendered state, even when **Collisions** remain.

## Example dialogue

> **Dev:** "This **C4 Container Diagram** still has a long diagonal **Connection Line** from the API **Container** to the **Message Bus**. Should we change the **ELK Patch**?"
> **Domain expert:** "No. ELK patches are for flat diagrams. For a container diagram, ask the **Visual-Hint Pipeline** for a **Route Hint**."
> **Dev:** "If the route hint uses `RIGHT_LANE`, do we always keep that route?"
> **Domain expert:** "Only if the candidate improves or preserves the **Geometry Score**. Otherwise the previous **Accepted State** remains."
> **Dev:** "And if two connection lines cross each other but no architecture element is crossed, is that a failed layout?"
> **Domain expert:** "No. A **Connection-Line Crossing** is a readability metric; **Element Overlap**, **Connection-Line Element Crossing**, and **Connection-Label Element Crossing** are the hard collision terms behind the **Absolute Gate**."
> **Dev:** "It went from three crossings to two, but added an overlap. Net defects are down. Ship it?"
> **Domain expert:** "No — the **Quality Ratchet** fails on any count that rises, precisely so a change cannot trade one class for another and call it progress."

## Flagged ambiguities

- "Node" is an implementation term and "entity" is too broad; use **Architecture Element** for the domain concept and reserve **Node** for ELKjs or renderer internals.
- "Edge" is an implementation term from graph layout; use **Relationship** for source semantics and **Connection Line** for the rendered visual line.
- "Port" is an ELKjs implementation term; use **Connection Point** for the domain concept and reserve **Port** for ELKjs port constraints and renderer internals (a **Port Hint** keeps its established name).
- "Container" can mean a **Container** architecture element or a **C4 Container Diagram**; use **Container** for the element type and **C4 Container Diagram** for the diagram type.
- "Connection line crossing" has been used for both **Connection-Line Element Crossing** and **Connection-Line Crossing**; use the precise term because only **Connection-Line Element Crossing** is a hard collision.
- "Collision" has sometimes included warnings and readability metrics; reserve **Collision** for the three information-destroying classes behind the **Absolute Gate**, and call the rest readability metrics.
- "Observational" was previously used for **Connection-Line Crossing**, **Connection-Line Overlap**, and **Label-Line Intersection**. It understated them — they are ratcheted, not merely observed. Use **readability metric** for these, and **Advisory Metric** only for the genuinely non-gating shape costs (bends, route length, overlap pixels).
- "Context diagram" no longer implies the flat **ELK Layout** path; since context diagrams gained the **Synthetic Boundary** they render through the **Container Layout Engine**. Say **flat path** when you mean ELK.
- "Note" is overloaded in the codebase: `diagramModel.notes` means **Annotation Notes**, but `_notes` on the model carries normalization diagnostics. Use **Annotation Note** for the domain concept and "diagnostic" for the other.
- "Score" has meant several different weightings historically; there is now exactly one, the **Layout Score**. Do not introduce a second cost model — extend the **Severity Ordering** instead.
- "Checkpoint" describes older LLM zone/order experiments; use **Visual-Hint Pipeline** and **Visual Hint** for the active container flow.
- "Message bus" and "queue" both appear in Mermaid macros; use **Message Bus** as the canonical domain term and treat `ContainerQueue` as syntax.
- "External system" and "external node" overlap; use **External Element** for the normalized model element and C4 macro names only when discussing source syntax.
- "Optimization loop" should refer to the flat-diagram **Critic Loop**; container diagrams run a one-pass **Visual-Hint Pipeline** instead.
- "Render" can mean browser layout, SVG drawing, screenshot capture, or final export; prefer **Container Layout Engine**, **Label Placement**, **Staged Snapshot**, or **Self-Contained SVG** when precision matters.
