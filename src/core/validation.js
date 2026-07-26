// The single-Boundary contract, enforced.
//
// Nudge lays out exactly one Boundary. That is a deliberate product decision,
// not a gap: a C4 Container diagram zooms into *one* software system and a
// Component diagram into *one* container, so the Boundary is the thing you
// zoomed into. Showing two systems' internals at once is two diagrams in C4's
// own terms. All seven third-party diagrams in `test/fixtures/diagrams/external`
// declare exactly one Boundary and none nest.
//
// Why this file exists: the layout engine used to accept these diagrams and
// silently drop everything it could not place. `container_plan.js` plans the
// *first* Boundary's direct children, so a sibling Boundary or a nested leaf was
// never laid out and never drawn — while the relationships pointing at it were
// still routed, to coordinates that meant nothing. One corpus diagram rendered
// with 6 of 12 elements missing (including both databases and its event bus) and
// four labelled arrows dangling into the top-left corner, and reported success.
//
// "Unsupported" and "silently deletes your content" are different products, and
// only the first is defensible. So the contract is checked up front and refused
// loudly, naming what is unsupported and what to do instead.

/** Thrown when a diagram's structure is outside the single-Boundary contract. */
export class UnsupportedDiagramError extends Error {
  constructor(message, { reason, boundaries } = {}) {
    super(message);
    this.name = 'UnsupportedDiagramError';
    this.code = 'UNSUPPORTED_DIAGRAM';
    /** Machine-readable discriminator: 'multiple_boundaries' | 'nested_boundary'. */
    this.reason = reason;
    /** The Boundary ids involved, so callers can point at the source. */
    this.boundaries = boundaries || [];
  }
}

const label = (node) => (node.label ? `"${node.label}" (${node.id})` : node.id);

/**
 * Find the first structural violation of the single-Boundary contract, or null.
 *
 * Two shapes are refused:
 *  - more than one top-level Boundary (sibling Boundaries)
 *  - a Boundary nested inside another Boundary
 *
 * A single Boundary containing leaf elements is supported, whatever the source
 * keyword — `System_Boundary`, `Container_Boundary` and `Enterprise_Boundary` all
 * parse to one Boundary node, so an Enterprise_Boundary wrapping plain systems is
 * fine. It is only *nesting* and *siblings* that have no layout.
 */
export function findUnsupportedStructure(model) {
  const nodes = model?.nodes || [];
  const topLevel = nodes.filter(n => n.type === 'boundary');

  if (topLevel.length > 1) {
    return {
      reason: 'multiple_boundaries',
      boundaries: topLevel.map(n => n.id),
      message:
        `This diagram declares ${topLevel.length} top-level boundaries ` +
        `(${topLevel.map(label).join(', ')}). Nudge lays out one boundary per diagram.\n\n` +
        `In C4 a Container diagram shows the containers inside a single system in scope, ` +
        `with other systems outside it as external elements. To draw this, either split it ` +
        `into one diagram per system, or keep one boundary and declare the others as ` +
        `System_Ext(...) outside it.`
    };
  }

  // Nested boundaries, at any depth beneath a top-level boundary.
  const findNested = (node, ancestors) => {
    for (const child of node.children || []) {
      if (child.type === 'boundary') {
        return {
          reason: 'nested_boundary',
          boundaries: [...ancestors.map(a => a.id), child.id],
          message:
            `Boundary ${label(child)} is nested inside boundary ${label(node)}. ` +
            `Nudge does not lay out nested boundaries.\n\n` +
            `Flatten the diagram so one boundary directly contains its elements, ` +
            `or split each nested boundary into its own diagram — which is how C4 ` +
            `models a level of zoom.`
        };
      }
      const deeper = findNested(child, [...ancestors, node]);
      if (deeper) return deeper;
    }
    return null;
  };

  for (const boundary of topLevel) {
    const nested = findNested(boundary, [boundary]);
    if (nested) return nested;
  }

  return null;
}

/**
 * Throw `UnsupportedDiagramError` if the model breaks the single-Boundary
 * contract. Called from `normalizeDiagramModel`, so every entry point — CLI, MCP
 * and the public API — refuses the same diagrams with the same message.
 */
export function assertSupportedDiagram(model) {
  const problem = findUnsupportedStructure(model);
  if (!problem) return;
  throw new UnsupportedDiagramError(problem.message, {
    reason: problem.reason,
    boundaries: problem.boundaries
  });
}
