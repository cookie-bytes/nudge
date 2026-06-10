# Ubiquitous Language

## Diagram model

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Diagram Model** | The normalized in-memory representation of a Mermaid or YAML architecture diagram. | Graph, spec, input JSON |
| **Diagram Source** | The user-authored Mermaid or YAML content that Nudge parses into a **Diagram Model**. | File, raw diagram |
| **C4 Context Diagram** | A flat C4 diagram that shows people, software systems, and external systems without an enclosing boundary. | Flat diagram, context graph |
| **C4 Container Diagram** | A C4 diagram that contains at least one system boundary and shows containers inside it. | Nested diagram, boundary diagram |
| **Boundary** | A C4 system boundary that groups child architecture elements belonging to one system. | Box, group, container boundary |
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
| **Critic Loop** | The iterative flat-diagram process that renders, critiques, asks for an ELKjs patch, and rerenders. | Optimization loop for all diagrams, feedback loop |
| **ELK Layout** | The ELKjs layered layout used for **C4 Context Diagrams** and other flat diagrams. | Automatic layout, standard layout |
| **Container Layout Engine** | Nudge's deterministic renderer for **C4 Container Diagrams**. | Custom layout, manual layout |
| **Kahn Layering** | The topological layering pass that orders boundary children into internal rows. | Topological sort, layer assignment |
| **Utility Row** | A dedicated internal row for databases or message buses that should not participate in normal service layering. | Special row, sink row |
| **External Zone** | A placement area outside the boundary: above, below, left, or right. | Side, lane, area |
| **Connectivity Sort** | The deterministic ordering of external elements by the internal layer or column they connect to. | Zone ordering, external sorting |
| **Layout Override** | A renderer input under `_layoutOverrides` that applies accepted visual hints. | Patch, hint payload |
| **Internal Order** | A layout override that replaces the left-to-right order of a boundary layer. | Top order, row order |
| **Port Hint** | A layout override requesting the source or target side used by a specific relationship. | Side hint, endpoint hint |
| **Route Hint** | A layout override requesting a route intent for a specific relationship. | Path hint, routing override |

## Routing and labels

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Connection Line** | The visible line that represents a relationship between two architecture elements. | Edge, line, connector |
| **Route** | The geometric path chosen for a connection line from source architecture element to target architecture element. | Line, edge path |
| **Route Candidate** | A possible route considered by the router before scoring chooses one. | Option, path option |
| **Route Intent** | A high-level routing preference such as `LEFT_LANE`, `RIGHT_LANE`, or `ORTHOGONAL_NEAR_TARGET`. | Route style, path mode |
| **Lane Reservation** | The local offsetting of interior route segments to reduce unavoidable shared corridors. | Lane routing, line spreading |
| **Second-Pass Rerouting** | A bounded reroute attempt for the worst route-conflict offenders after initial routing. | Rerendering, route retry |
| **Connection Label** | The rendered relationship text and optional technology note placed near a connection line. | Edge label, relationship label |
| **Technology Note** | The bracketed transport or implementation detail shown beneath a connection label. | Protocol, tech label |
| **Label Placement** | The collision-aware process that chooses where a connection label should appear. | Text placement, label routing |
| **Direct Database Drop** | A straight vertical route from a parent container to a column-aligned database. | DB drop, persistence line |
| **Gutter Route** | A detour that uses reserved side space inside or outside a boundary. | Perimeter route, side detour |

## Quality and scoring

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Geometric Critique** | The deterministic analysis of rendered geometry for layout defects and diagnostics. | Collision report, layout analysis |
| **Collision** | A hard visual defect that counts against layout success. | Defect, issue, warning |
| **Element Overlap** | A collision where two architecture element boxes intersect. | Node overlap, box collision |
| **Connection-Line Element Crossing** | A collision where a connection line intersects an architecture element that is not its source or target. | Edge-node crossing, line-node crossing |
| **Connection-Label Element Crossing** | A collision where a connection label overlaps an architecture element. | Edge-label-node crossing, label collision |
| **Tight Spacing** | A spacing warning where architecture elements are closer than the configured comfort threshold. | Near miss, spacing issue |
| **Connection-Line Crossing** | An observational metric where two connection lines cross each other away from shared endpoints. | Edge-edge crossing, line crossing |
| **Connection-Line Overlap** | An observational metric where two non-bundled connection lines share a long segment. | Edge overlap, shared corridor, stacked line |
| **Label-Line Intersection** | An observational metric where a rendered connection label intersects a connection line. | Label-edge intersection, label hit |
| **Geometry Score** | The weighted score used to compare candidate container visual hints. | Quality score, candidate score |
| **Math Grader** | The deterministic test grader used by default and as a fallback. | Fallback grader, built-in grader |
| **Visual Grader** | The optional LLM-based test grader enabled by `NUDGE_VISUAL_TEST=true`. | LLM grader, visual LLM critique |

## Optimization and tools

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Visual-Hint Pipeline** | The one-pass container optimization flow that tries top-order, port, and diagonal-route hints. | Checkpoint pipeline, LLM checkpoint |
| **Visual Hint** | A local-LLM suggestion derived from already rendered container geometry. | Checkpoint, recommendation |
| **Staged Snapshot** | A PNG captured for one container visual-hint stage. | Step image, intermediate render |
| **Accepted State** | The best non-worsening container render kept after evaluating visual hints. | Current state, final state |
| **ELK Patch** | A JSON update to ELKjs layout options suggested for a flat diagram. | Layout patch, parameter patch |
| **Self-Contained SVG** | The final SVG export with renderer styles embedded inside the SVG. | Optimized SVG, inline SVG |
| **MCP Tool** | The stdio-exposed `optimize_diagram` operation used by MCP clients. | Server command, external tool |
| **Cancellation Chain** | The signal path from MCP request cancellation through optimizer calls to fetch timeouts. | Abort path, timeout chain |
| **Deterministic Mode** | A run with LLM calls disabled by `NUDGE_NO_LLM` or `skipLlm`. | Offline mode, no-AI mode |

## Relationships

- A **Diagram Source** is parsed into exactly one **Diagram Model**.
- A **Diagram Model** contains zero or more **Architecture Elements**, zero or more **Relationships**, and zero or more **Rules**.
- A **C4 Container Diagram** contains one primary **Boundary** with child **Containers**, **Databases**, and **Message Buses**.
- A **Relationship** has exactly one source **Architecture Element** and exactly one target **Architecture Element**.
- A **Connection Line** renders exactly one **Relationship**.
- A **Route** is the geometry of exactly one **Connection Line**.
- A **Connection Label** belongs to exactly one **Relationship**.
- A **C4 Context Diagram** uses the **Critic Loop** and **ELK Layout**.
- A **C4 Container Diagram** uses the **Container Layout Engine** and may use the **Visual-Hint Pipeline**.
- A **Visual Hint** becomes a **Layout Override** only when its candidate render is accepted into the **Accepted State**.
- A **Geometric Critique** produces **Collisions**, spacing warnings, and observational edge-quality metrics.
- A **Self-Contained SVG** is exported from the final rendered state, even when **Collisions** remain.

## Example dialogue

> **Dev:** "This **C4 Container Diagram** still has a long diagonal **Connection Line** from the API **Container** to the **Message Bus**. Should we change the **ELK Patch**?"
> **Domain expert:** "No. ELK patches are for flat diagrams. For a container diagram, ask the **Visual-Hint Pipeline** for a **Route Hint**."
> **Dev:** "If the route hint uses `RIGHT_LANE`, do we always keep that route?"
> **Domain expert:** "Only if the candidate improves or preserves the **Geometry Score**. Otherwise the previous **Accepted State** remains."
> **Dev:** "And if two connection lines cross each other but no architecture element is crossed, is that a failed layout?"
> **Domain expert:** "No. A **Connection-Line Crossing** is observational; **Element Overlap**, **Connection-Line Element Crossing**, and **Connection-Label Element Crossing** are the hard collision terms."

## Flagged ambiguities

- "Node" is an implementation term and "entity" is too broad; use **Architecture Element** for the domain concept and reserve **Node** for ELKjs or renderer internals.
- "Edge" is an implementation term from graph layout; use **Relationship** for source semantics and **Connection Line** for the rendered visual line.
- "Container" can mean a **Container** architecture element or a **C4 Container Diagram**; use **Container** for the element type and **C4 Container Diagram** for the diagram type.
- "Connection line crossing" has been used for both **Connection-Line Element Crossing** and **Connection-Line Crossing**; use the precise term because only **Connection-Line Element Crossing** is a hard collision.
- "Collision" has sometimes included warnings and observational metrics; reserve **Collision** for hard layout defects and call route metrics observational.
- "Checkpoint" describes older LLM zone/order experiments; use **Visual-Hint Pipeline** and **Visual Hint** for the active container flow.
- "Message bus" and "queue" both appear in Mermaid macros; use **Message Bus** as the canonical domain term and treat `ContainerQueue` as syntax.
- "External system" and "external node" overlap; use **External Element** for the normalized model element and C4 macro names only when discussing source syntax.
- "Optimization loop" should refer to the flat-diagram **Critic Loop**; container diagrams run a one-pass **Visual-Hint Pipeline** instead.
- "Render" can mean browser layout, SVG drawing, screenshot capture, or final export; prefer **Container Layout Engine**, **Label Placement**, **Staged Snapshot**, or **Self-Contained SVG** when precision matters.
