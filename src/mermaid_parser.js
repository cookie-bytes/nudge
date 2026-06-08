// Parser to convert Mermaid C4Context strings into ELKjs-compatible JSON structures
export function parseMermaidC4(mermaidString) {
  const lines = mermaidString.split(/\r?\n/);
  
  const result = {
    title: "System Context Diagram",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "140",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.spacing.edgeNode": "80",
      "elk.spacing.edgeEdge": "20",
      "elk.padding": "[top=30,left=30,bottom=30,right=30]"
    },
    nodes: [],
    edges: [],
    rules: [] // Enforced ordering constraints
  };

  const activeBoundaries = [];
  const boundaryMap = new Map();

  // Regular expression patterns
  const titleRegex = /^\s*title\s+(.+)$/i;
  const boundaryRegex = /^\s*(?:(Enterprise|System|Container)_)?Boundary\((\w+),\s*"([^"]+)"\)\s*\{/i;
  const nodeRegex = /^\s*(Person|System|System_Ext|Container|ContainerDb|Container_Ext|ContainerQueue)\((\w+),\s*"([^"]+)"(?:,\s*"([^"]*)")?(?:,\s*"([^"]*)")?\)/i;
  const relRegex = /^\s*Rel\((\w+),\s*(\w+),\s*"([^"]+)"(?:,\s*"([^"]*)")?\)/i;
  const ruleRegex = /^\s*%%\s*Rule:\s*(\w+)\s+(above|below)\s+(\w+)/i;

  for (let line of lines) {
    line = line.trim();
    
    // Detect diagram type
    if (line.match(/^\s*(C4Context|C4Container)/i)) {
      result.diagramType = line.trim();
      continue;
    }

    // Ignore normal comments, but let "%% Rule: ..." pass through
    if (!line || (line.startsWith('%%') && !line.match(/Rule:/i))) {
      continue;
    }

    // 0. Match Layout Rule
    const ruleMatch = line.match(ruleRegex);
    if (ruleMatch) {
      const [_, source, relation, target] = ruleMatch;
      result.rules.push({
        source: normalizeTypeName(source),
        relation: relation.toLowerCase(),
        target: normalizeTypeName(target)
      });
      continue;
    }

    // 1. Title Match
    const titleMatch = line.match(titleRegex);
    if (titleMatch) {
      result.title = titleMatch[1].trim();
      continue;
    }

    // 2. Boundary Open Match
    const boundaryMatch = line.match(boundaryRegex);
    if (boundaryMatch) {
      const [_, boundaryType, id, label] = boundaryMatch;
      const boundaryNode = {
        id,
        label,
        type: 'boundary',
        description: '',
        children: []
      };
      
      boundaryMap.set(id, boundaryNode);

      if (activeBoundaries.length > 0) {
        const parentId = activeBoundaries[activeBoundaries.length - 1];
        const parentBoundary = boundaryMap.get(parentId);
        parentBoundary.children.push(boundaryNode);
      } else {
        result.nodes.push(boundaryNode);
      }

      activeBoundaries.push(id);
      continue;
    }

    // 3. Boundary Close Match
    if (line === '}') {
      activeBoundaries.pop();
      continue;
    }

    // 4. Node Match
    const nodeMatch = line.match(nodeRegex);
    if (nodeMatch) {
      const [_, type, id, label, descOrTech, descAfterTech] = nodeMatch;
      const typeLower = type.toLowerCase();
      let mappedType = 'container';
      if (typeLower === 'person') {
        mappedType = 'person';
      } else if (typeLower === 'system_ext' || typeLower === 'container_ext') {
        mappedType = 'external';
      } else if (typeLower === 'containerdb') {
        mappedType = 'database';
      } else if (typeLower === 'containerqueue') {
        mappedType = 'message_bus';
      }

      // Support optional technology parameter: if 4 arguments are provided, the 3rd is technology and 4th is description.
      // Otherwise, the 3rd is description.
      let tech = '';
      let description = '';
      if (descAfterTech !== undefined) {
        tech = descOrTech || '';
        description = descAfterTech || '';
      } else {
        description = descOrTech || '';
      }

      const componentNode = {
        id,
        label,
        type: mappedType,
        tech,
        description,
        width: 200,
        height: mappedType === 'person' ? 200 : (mappedType === 'database' || mappedType === 'container' || mappedType === 'external') ? 140 : 80
      };

      if (activeBoundaries.length > 0) {
        const parentId = activeBoundaries[activeBoundaries.length - 1];
        const parentBoundary = boundaryMap.get(parentId);
        parentBoundary.children.push(componentNode);
      } else {
        result.nodes.push(componentNode);
      }
      continue;
    }

    // 5. Relationship Match
    const relMatch = line.match(relRegex);
    if (relMatch) {
      const [_, from, to, label, tech] = relMatch;
      let edgeLabel = label;
      if (tech) {
        edgeLabel = `${label} [${tech}]`;
      }
      result.edges.push({
        from,
        to,
        label: edgeLabel
      });
      continue;
    }
  }

  return result;
}

// Map C4Context entities to internal representation names
function normalizeTypeName(name) {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'person') return 'person';
  if (lower === 'system' || lower === 'container') return 'container';
  if (lower === 'system_ext' || lower === 'container_ext') return 'external';
  if (lower === 'database' || lower === 'containerdb') return 'database';
  if (lower === 'message_bus' || lower === 'containerqueue' || lower === 'messagebus') return 'message_bus';
  return trimmed; // Preserve case for custom node IDs!
}
