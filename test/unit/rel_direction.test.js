import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import { parseMermaidC4 } from '../../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../../src/plantuml_parser.js';

// container_plan.js is a browser script that attaches itself to
// window.NudgeRenderer; it has no other dependencies, so load it in a sandbox.
function loadContainerPlan() {
  const sandbox = { window: { NudgeRenderer: {} } };
  const src = fs.readFileSync(new URL('../../src/renderer/container/container_plan.js', import.meta.url), 'utf8');
  vm.runInNewContext(src, sandbox);
  return sandbox.window.NudgeRenderer.containerPlan;
}

const RELS = `
Rel_U(a, x, "u")
Rel_Up(a, x, "up")
Rel_D(a, x, "d")
Rel_Down(a, x, "down")
Rel_L(a, x, "l")
Rel_Left(a, x, "left")
Rel_R(a, x, "r")
Rel_Right(a, x, "right")
BiRel_R(a, x, "bi")
Rel(a, x, "plain")
Rel_Back(a, x, "back")
Rel_Neighbor(a, x, "neighbor")
`;
const EXPECTED = ['up', 'up', 'down', 'down', 'left', 'left', 'right', 'right', 'right', undefined, undefined, undefined];

test('parseMermaidC4 records the side named by a Relationship direction suffix', () => {
  const model = parseMermaidC4(`C4Container\n${RELS}`);
  assert.deepEqual(model.edges.map(e => e.direction), EXPECTED);
});

test('parsePlantUMLC4 records the side named by a Relationship direction suffix', () => {
  const model = parsePlantUMLC4(`@startuml\n${RELS}\n@enduml`);
  assert.deepEqual(model.edges.map(e => e.direction), EXPECTED);
});

test('undirected Relationships carry no direction key, so their model is unchanged', () => {
  const [edge] = parseMermaidC4('C4Container\nRel(a, b, "Uses", "HTTPS")').edges;
  assert.deepEqual(edge, { from: 'a', to: 'b', label: 'Uses [HTTPS]' });
});

function zonesFor(rels) {
  const model = parseMermaidC4(`C4Container
System_Boundary(b, "B") {
  Container(api, "API")
  Container(worker, "Worker")
}
System_Ext(aims, "AIMS")
System_Ext(auth, "Auth")
Person(user, "User")
Rel(api, worker, "Queues")
${rels}`);
  const plan = loadContainerPlan().buildContainerZonePlan(model);
  const zoneOf = id => ['above', 'below', 'left', 'right'].find(z => plan[`${z}Nodes`].some(n => n.id === id));
  return { zoneOf, plan };
}

test('a directed Relationship puts an external target on the named side', () => {
  const { zoneOf, plan } = zonesFor(`
Rel_R(api, aims, "Updates")
Rel_L(api, auth, "Validates")
Rel_D(user, api, "Uses")`);
  assert.equal(zoneOf('aims'), 'right');
  assert.equal(zoneOf('auth'), 'left');
  // user is the external *source*: the API sits below it, so the user sits above.
  assert.equal(zoneOf('user'), 'above');
  assert.deepEqual([...plan.authoredZoneIds].sort(), ['aims', 'auth', 'user']);
});

test('an external source takes the side opposite the named direction', () => {
  const { zoneOf } = zonesFor('Rel_R(aims, api, "Pushes")');
  assert.equal(zoneOf('aims'), 'left');
});

test('undirected Relationships keep the connectivity classification', () => {
  const { zoneOf, plan } = zonesFor(`
Rel(api, aims, "Updates")
Rel(user, api, "Uses")`);
  assert.equal(zoneOf('user'), 'above');
  assert.notEqual(zoneOf('aims'), undefined);
  assert.equal(plan.authoredZoneIds.size, 0);
});

test('the first directed Relationship for an element wins', () => {
  const { zoneOf } = zonesFor(`
Rel_L(api, aims, "First")
Rel_R(worker, aims, "Second")`);
  assert.equal(zoneOf('aims'), 'left');
});
