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

  const titleRegex = /^\s*title\s+(.+)$/i;
  const ruleRegex = /^\s*%%\s*Rule:\s*(\w+)\s+(above|below)\s+(\w+)/i;

  const nodeTypes = new Set([
    'person', 'person_ext',
    'system', 'system_ext', 'systemdb', 'systemdb_ext', 'systemqueue', 'systemqueue_ext',
    'container', 'container_ext', 'containerdb', 'containerdb_ext', 'containerqueue', 'containerqueue_ext',
    'component', 'componentdb', 'componentqueue'
  ]);

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

    // 2. Boundary Close Match
    if (line === '}') {
      activeBoundaries.pop();
      continue;
    }

    // 3. Boundary Open or Node or Relationship
    const isBoundaryOpen = line.endsWith('{');
    let cleanLine = line;
    if (isBoundaryOpen) {
      cleanLine = line.slice(0, -1).trim();
    }

    const macroMatch = cleanLine.match(/^\s*(\w+)\((.*)\)\s*$/);
    if (macroMatch) {
      const macroName = macroMatch[1];
      const argsStr = macroMatch[2];
      const args = parseArgs(argsStr);
      const macroLower = macroName.toLowerCase();

      // Case A: Boundary Open
      if (macroLower.endsWith('boundary')) {
        const [id, label] = args;
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

      // Case B: Node Match
      if (nodeTypes.has(macroLower)) {
        const [id, label, descOrTech, descAfterTech] = args;
        let mappedType = 'container';
        if (macroLower === 'person' || macroLower === 'person_ext') {
          mappedType = macroLower === 'person' ? 'person' : 'external';
        } else if (
          macroLower === 'system_ext' ||
          macroLower === 'container_ext' ||
          macroLower === 'systemdb_ext' ||
          macroLower === 'containerdb_ext' ||
          macroLower === 'systemqueue_ext' ||
          macroLower === 'containerqueue_ext'
        ) {
          mappedType = 'external';
        } else if (macroLower === 'containerdb' || macroLower === 'systemdb' || macroLower === 'componentdb') {
          mappedType = 'database';
        } else if (macroLower === 'containerqueue' || macroLower === 'systemqueue' || macroLower === 'componentqueue') {
          mappedType = 'message_bus';
        } else if (macroLower === 'system' || macroLower === 'container' || macroLower === 'component') {
          mappedType = 'container';
        }

        let tech = '';
        let description = '';
        
        // Container and Component macro variants natively support a technology field.
        // Person and System macro variants do not.
        const supportsTech = macroLower.startsWith('container') || macroLower.startsWith('component');

        if (supportsTech) {
          if (descAfterTech !== undefined) {
            tech = descOrTech || '';
            description = descAfterTech || '';
          } else {
            tech = descOrTech || '';
            description = '';
          }
        } else {
          // Person and System variants do not support technology; the 3rd argument is the description
          description = descOrTech || '';
        }

        const componentNode = {
          id,
          label,
          type: mappedType,
          tech,
          description,
          width: 200,
          height: mappedType === 'person' ? 200 : (mappedType === 'database' || mappedType === 'container' || mappedType === 'external') ? 140 : mappedType === 'message_bus' ? 120 : 80
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

      // Case C: Relationship Match
      if (macroLower.endsWith('rel') || macroLower.includes('rel_')) {
        const [from, to, label, tech] = args;
        let edgeLabel = label || '';
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
  }

  return result;
}

// Map C4Context entities to internal representation names
function normalizeTypeName(name) {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'person') return 'person';
  if (lower === 'person_ext') return 'external';
  if (lower === 'system' || lower === 'container' || lower === 'component') return 'container';
  if (
    lower === 'system_ext' ||
    lower === 'container_ext' ||
    lower === 'systemdb_ext' ||
    lower === 'containerdb_ext' ||
    lower === 'systemqueue_ext' ||
    lower === 'containerqueue_ext'
  ) return 'external';
  if (lower === 'database' || lower === 'containerdb' || lower === 'systemdb' || lower === 'componentdb') return 'database';
  if (lower === 'message_bus' || lower === 'containerqueue' || lower === 'messagebus' || lower === 'systemqueue' || lower === 'componentqueue') return 'message_bus';
  return trimmed; // Preserve case for custom node IDs!
}

// Robust tokenizer to parse CSV-like macro arguments, respecting quotes and escaped quotes
function parseArgs(argsStr) {
  const args = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];
    if (char === '"') {
      if (i > 0 && argsStr[i - 1] === '\\') {
        current += char;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      args.push(current.trim());
      current = '';
    } else {
      if (char === '\\' && i + 1 < argsStr.length && argsStr[i + 1] === '"') {
        continue;
      }
      current += char;
    }
  }
  args.push(current.trim());
  
  return args.map(arg => {
    let clean = arg;
    if (clean.startsWith('"') && clean.endsWith('"')) {
      clean = clean.slice(1, -1);
    }
    return clean;
  });
}
