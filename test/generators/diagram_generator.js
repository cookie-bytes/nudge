// Seeded generator of C4 container diagrams, for property-based testing.
//
// The corpus is 26 hand-authored diagrams, which means an edge case is only
// discovered when somebody happens to draw it — that is the *input* to the
// tail-chasing described in docs/IMPROVEMENT_PLAN.md §1. A generator turns that
// around: invariants are asserted over diagrams nobody thought to draw.
//
// Seeded on purpose. A failure reproduces exactly from its seed, and shrinks to
// a minimal fixture you can promote into the corpus.

/** Deterministic PRNG (mulberry32). Same seed, same diagram, forever. */
export function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ELEMENT_TYPES = ['container', 'container', 'container', 'database', 'message_bus'];
const TECHNOLOGIES = ['REST', 'gRPC', 'AMQP', 'JDBC', 'HTTPS', 'GraphQL', 'Kafka'];
const VERBS = ['Reads from', 'Writes to', 'Publishes events to', 'Queries', 'Notifies',
  'Delivers cached content to', 'Authenticates against', 'Streams updates to'];
const NOUNS = ['Gateway', 'Service', 'Store', 'Worker', 'Index', 'Cache', 'Ledger',
  'Scheduler', 'Registry', 'Projection'];

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

/**
 * One generated diagram model, in the same shape the parsers emit.
 *
 * The knobs are the ones that actually produce distinct layout pressure:
 * element count, relationship density, label length, parallel relationships
 * (two elements connected more than once), self-relationships, and how many
 * elements sit outside the boundary as persons/external systems.
 */
export function generateDiagram(seed) {
  const random = createRandom(seed);

  const internalCount = 2 + Math.floor(random() * 6);   // 2–7 inside the boundary
  const externalCount = Math.floor(random() * 3);        // 0–2 persons/externals
  const density = 0.2 + random() * 0.5;                  // relationship probability
  const longLabels = random() < 0.35;

  const internal = [];
  for (let i = 0; i < internalCount; i++) {
    internal.push({
      id: `svc${i}`,
      label: `${pick(random, NOUNS)} ${i}`,
      type: pick(random, ELEMENT_TYPES),
      technology: pick(random, TECHNOLOGIES),
      description: 'Generated element',
    });
  }

  const externals = [];
  for (let i = 0; i < externalCount; i++) {
    externals.push({
      id: `ext${i}`,
      label: `${random() < 0.5 ? 'Operator' : 'Partner'} ${i}`,
      type: random() < 0.5 ? 'person' : 'external_system',
      description: 'Generated external',
    });
  }

  const nodes = [
    {
      id: 'boundary',
      label: 'Generated System',
      type: 'boundary',
      children: internal,
    },
    ...externals,
  ];

  const all = [...internal, ...externals];
  const edges = [];
  let n = 0;
  for (const a of all) {
    // Self-relationship: an element related to itself. Rare in real diagrams and
    // therefore rare in a hand-authored corpus, which is exactly why it belongs
    // in a generator — it is the shape most likely to have no routing case.
    if (random() < 0.08) {
      edges.push({ id: `edge_${n++}`, source: a.id, target: a.id, label: `Reconciles itself [${pick(random, TECHNOLOGIES)}]` });
    }
    for (const b of all) {
      if (a.id === b.id) continue;
      if (random() > density) continue;
      const verb = pick(random, VERBS);
      const text = longLabels
        ? `${verb} the downstream ${pick(random, NOUNS).toLowerCase()} [${pick(random, TECHNOLOGIES)}]`
        : `${verb} [${pick(random, TECHNOLOGIES)}]`;
      edges.push({ id: `edge_${n++}`, source: a.id, target: b.id, label: text });
      // Parallel relationships: the same ordered pair connected twice. This is
      // the shape that crowds labels into one corridor.
      if (random() < 0.15) {
        edges.push({ id: `edge_${n++}`, source: a.id, target: b.id, label: `Also ${verb.toLowerCase()}` });
      }
    }
  }

  return {
    title: `Generated ${seed}`,
    diagramType: 'C4Container',
    layoutOptions: {},
    nodes,
    edges,
    rules: [],
    notes: [],
    warnings: [],
    _seed: seed,
  };
}
