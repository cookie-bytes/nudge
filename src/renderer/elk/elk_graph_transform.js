window.NudgeRenderer.elkGraphTransform = {
  createRootGraph(options) {
    return {
      id: "root",
      layoutOptions: {
        "elk.algorithm": options["elk.algorithm"] || "layered",
        "elk.direction": options["elk.direction"] || "DOWN",
        "elk.hierarchyHandling": "INCLUDE_CHILDREN",
        "elk.spacing.nodeNode": String(options["elk.spacing.nodeNode"] || 80),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80),
        "elk.spacing.edgeNode": String(options["elk.spacing.edgeNode"] || 40),
        "elk.spacing.edgeEdge": String(options["elk.spacing.edgeEdge"] || 30),
        "elk.padding": options["elk.padding"] || "[top=30,left=30,bottom=30,right=30]",
        "elk.edgeRouting": "ORTHOGONAL",
        "org.eclipse.elk.edgeRouting": "ORTHOGONAL",
        // Enforce model order constraints on the layout engine
        "elk.layered.crossingMinimization.semiInteractive": "true",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
        // Align nodes to favor straight edges
        "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        "elk.layered.nodePlacement.favorStraightEdges": "true",
        "elk.portConstraints": "FREE",
        "elk.layered.allowNonFlowPortsToSwitchSides": "true"
      },
      children: [],
      edges: []
    };
  },

  findNodesMatching(nodes, selector) {
    const matches = [];
    function traverse(nodeList) {
      for (const n of nodeList) {
        if (n.id === selector || n.type === selector) {
          matches.push(n);
        }
        if (n.children) traverse(n.children);
      }
    }
    traverse(nodes || []);
    return matches;
  },

  findNodeById(nodes, id) {
    const matches = window.NudgeRenderer.elkGraphTransform.findNodesMatching(nodes, id);
    return matches.length > 0 ? matches[0] : null;
  },

  initRanks(nodeList, ranks, policy) {
    for (const n of nodeList) {
      ranks[n.id] = policy.getDefaultRank(n.type);
      if (n.children) window.NudgeRenderer.elkGraphTransform.initRanks(n.children, ranks, policy);
    }
  },

  applyOrderingRules(rules, ranks, findNodesMatching) {
    if (rules.length > 0) {
      // resolve custom ordering rules via Bellman-Ford relaxation
      for (let iter = 0; iter < 5; iter++) {
        for (const rule of rules) {
          const sources = findNodesMatching(rule.source);
          const targets = findNodesMatching(rule.target);

          for (const srcNode of sources) {
            for (const tgtNode of targets) {
              const srcVal = ranks[srcNode.id] !== undefined ? ranks[srcNode.id] : 0;
              const tgtVal = ranks[tgtNode.id] !== undefined ? ranks[tgtNode.id] : 0;

              if (rule.relation === 'above') {
                if (srcVal >= tgtVal) {
                  ranks[tgtNode.id] = srcVal + 1;
                }
              } else if (rule.relation === 'below') {
                if (srcVal <= tgtVal) {
                  ranks[srcNode.id] = tgtVal + 1;
                }
              }
            }
          }
        }
      }
    }
  },

  getAncestors(nodeMap, id) {
    const path = [];
    let current = nodeMap.get(id);
    while (current) {
      path.push(current.node.id);
      if (current.parentId) {
        current = nodeMap.get(current.parentId);
      } else {
        break;
      }
    }
    path.push("root");
    return path;
  },

  findClosestCommonAncestor(nodeMap, idA, idB) {
    const pathA = window.NudgeRenderer.elkGraphTransform.getAncestors(nodeMap, idA);
    const pathB = window.NudgeRenderer.elkGraphTransform.getAncestors(nodeMap, idB);

    for (const parentA of pathA) {
      if (pathB.includes(parentA)) {
        return parentA;
      }
    }
    return "root";
  },

  addPortToNode(node, portId, side) {
    if (!node.ports) {
      node.ports = [];
    }
    if (!node.ports.find(p => p.id === portId)) {
      node.ports.push({
        id: portId,
        width: 1,
        height: 1,
        properties: {
          "port.side": side,
          "org.eclipse.elk.port.side": side
        },
        layoutOptions: {
          "port.side": side,
          "org.eclipse.elk.port.side": side
        }
      });
    }
    node.layoutOptions["elk.portConstraints"] = "FIXED_SIDE";
    node.layoutOptions["portConstraints"] = "FIXED_SIDE";
    node.layoutOptions["org.eclipse.elk.portConstraints"] = "FIXED_SIDE";
  },

  assembleHierarchy(graph, nodeMap) {
    for (const [id, record] of nodeMap.entries()) {
      if (record.parentId) {
        const parentRecord = nodeMap.get(record.parentId);
        parentRecord.node.children.push(record.node);
      } else {
        graph.children.push(record.node);
      }
    }
  },

  collectCrossHierarchyNodes(edges, nodeMap) {
    const crossHierarchyNodes = new Set();
    if (edges) {
      edges.forEach(e => {
        const srcRecord = nodeMap.get(e.from);
        const tgtRecord = nodeMap.get(e.to);
        if (srcRecord && tgtRecord && srcRecord.parentId !== tgtRecord.parentId) {
          crossHierarchyNodes.add(e.from);
          crossHierarchyNodes.add(e.to);
        }
      });
    }
    return crossHierarchyNodes;
  },

  createElkEdge(e, idx, createConnectionLabel) {
    return {
      id: `edge_${idx}`,
      sources: [e.from],
      targets: [e.to],
      labels: e.label ? [createConnectionLabel(e.label)] : [],
      layoutOptions: {
        "elk.edgeRouting": "ORTHOGONAL",
        "org.eclipse.elk.edgeRouting": "ORTHOGONAL"
      }
    };
  },

  applyRelationshipPriority(edge, srcNode, tgtNode) {
    if (srcNode && tgtNode) {
      // Sensible default: keep the primary user -> core container connection aligned
      if (srcNode.type === "person" && tgtNode.type === "container") {
        edge.layoutOptions["elk.layered.priority.straightness"] = "100";
      }
    }
  },

  attachEdgeToAncestor(edge, ancestorId, graph, nodeMap) {
    if (ancestorId === "root") {
      graph.edges.push(edge);
    } else {
      const ancestorRecord = nodeMap.get(ancestorId);
      if (ancestorRecord) {
        ancestorRecord.node.edges.push(edge);
      } else {
        graph.edges.push(edge);
      }
    }
  },

  applyPortRouting({
    e,
    idx,
    edge,
    nodeMap,
    options,
    ranks,
    diagramData,
    crossHierarchyNodes,
    addPortToNode
  }) {
    // Setup FIXED_SIDE ports based on layout direction and relative position rules
    // Only apply port-based routing when both nodes are at the same hierarchy level,
    // since cross-hierarchy edges with port references cause ELK resolution errors.
    const srcRecord = nodeMap.get(e.from);
    const tgtRecord = nodeMap.get(e.to);
    const direction = options["elk.direction"] || "DOWN";
    const sameParent = srcRecord && tgtRecord && srcRecord.parentId === tgtRecord.parentId;

    if (srcRecord && tgtRecord && direction === "DOWN") {
      const rankSrc = ranks[e.from] !== undefined ? ranks[e.from] : 0;
      const rankTgt = ranks[e.to] !== undefined ? ranks[e.to] : 0;
      const xSrc = srcRecord.node.x || 0;
      const xTgt = tgtRecord.node.x || 0;

      const isUpward = rankSrc > rankTgt;
      const isBypassing = Math.abs(rankSrc - rankTgt) > 1;

      const sourcePortId = `${e.from}_port_out_${idx}`;
      const targetPortId = `${e.to}_port_in_${idx}`;

      let srcSide = "SOUTH";
      let tgtSide = "NORTH";

      if (isUpward) {
        srcSide = "NORTH";
        if (xSrc > xTgt) {
          tgtSide = "EAST";
        } else if (xSrc < xTgt) {
          tgtSide = "WEST";
        } else {
          tgtSide = "SOUTH";
        }
      } else if (rankSrc === rankTgt) {
        srcSide = xSrc < xTgt ? "EAST" : "WEST";
        tgtSide = xSrc < xTgt ? "WEST" : "EAST";
      }

      // Override sides for message_bus symbols to support horizontal flow (left-in, right-out)
      if (tgtRecord.node.type === "message_bus") {
        tgtSide = "WEST";
      }
      if (srcRecord.node.type === "message_bus") {
        srcSide = "EAST";
      }

      const hasBoundaries = diagramData.nodes.some(n => n.type === 'boundary');
      const useSrcPort = sameParent && !crossHierarchyNodes.has(e.from) && !hasBoundaries;
      const useTgtPort = sameParent && !crossHierarchyNodes.has(e.to) && !hasBoundaries;

      if (useSrcPort) {
        addPortToNode(srcRecord.node, sourcePortId, srcSide);
        edge.sources = [sourcePortId];
      } else {
        edge.sources = [e.from];
      }

      if (useTgtPort) {
        addPortToNode(tgtRecord.node, targetPortId, tgtSide);
        edge.targets = [targetPortId];
      } else {
        edge.targets = [e.to];
      }
    }
  },

  createElkNode(rawNode) {
    return {
      id: rawNode.id,
      width: rawNode.width || 150,
      height: rawNode.height || 80,
      type: rawNode.type || "container",
      typeLabel: rawNode.typeLabel,
      label: rawNode.label || rawNode.id,
      tech: rawNode.tech || "",
      description: rawNode.description || "",
      layoutOptions: {},
      edges: []
    };
  },

  configureBoundaryNode({ node, rawNode, options, measureTextWidth, BOUNDARY_H_PAD }) {
    node.children = [];
    delete node.width;
    delete node.height;

    // Measure label width so boundary is always wide enough to display it fully.
    // CSS applies text-transform:uppercase and letter-spacing:0.05em — replicate both.
    const labelUpper = (rawNode.label || '').toUpperCase();
    const labelW = measureTextWidth(labelUpper, 14, false)
                   + labelUpper.length * (14 * 0.05);

    // Find the widest direct child so we can derive symmetric left/right padding.
    // minW is driven by whichever constraint is larger: label or content+padding.
    const maxChildW = (rawNode.children || []).reduce((mx, ch) => Math.max(mx, ch.width || 200), 0) || 200;
    const minWFromLabel   = Math.ceil(labelW + 2 * BOUNDARY_H_PAD);
    const minWFromContent = maxChildW + 2 * BOUNDARY_H_PAD;
    const minW = Math.max(minWFromLabel, minWFromContent);

    // Derive equal left/right padding so children are always centred inside the boundary.
    const hPad = Math.max(BOUNDARY_H_PAD, Math.round((minW - maxChildW) / 2));

    node.layoutOptions["elk.algorithm"] = "layered";
    // bottom = 50px clearance from last child + 14px font height + 20px below title
    node.layoutOptions["elk.padding"] = `[top=${BOUNDARY_H_PAD},left=${hPad},bottom=84,right=${hPad}]`;
    node.layoutOptions["elk.direction"] = options["elk.direction"] || "DOWN";
    node.layoutOptions["elk.layered.spacing.nodeNodeBetweenLayers"] = String(options["elk.layered.spacing.nodeNodeBetweenLayers"] || 80);
    node.layoutOptions["elk.spacing.nodeNode"] = String(options["elk.spacing.nodeNode"] || 80);
    node.layoutOptions["elk.nodeSize.constraints"] = "MINIMUM_SIZE";
    node.layoutOptions["elk.nodeSize.minimum"] = `(${minW}, 100)`;
  },

  sortNodesByRank(nodeList, ranks) {
    return [...nodeList].sort((a, b) => {
      const rankA = ranks[a.id] !== undefined ? ranks[a.id] : 0;
      const rankB = ranks[b.id] !== undefined ? ranks[b.id] : 0;
      return rankA - rankB;
    });
  },

  consumeRankOffset(rankCounts, rankVal) {
    if (rankCounts[rankVal] === undefined) {
      rankCounts[rankVal] = 0;
    }
    const offsetIndex = rankCounts[rankVal];
    rankCounts[rankVal]++;
    return offsetIndex;
  },

  registerNode(nodeMap, rawNode, node, parentNode) {
    nodeMap.set(rawNode.id, { node, parentId: parentNode ? parentNode.id : null });
  },

  prepareNodeLayerPlacement({ node, ranks, policy, rankCounts }) {
    const rankVal = ranks[node.id] !== undefined ? ranks[node.id] : 0;

    // Set layer constraints
    policy.applyLayerConstraints(node, rankVal);

    // Track the number of nodes in the same rank to offset them
    const offsetIndex = window.NudgeRenderer.elkGraphTransform.consumeRankOffset(rankCounts, rankVal);
    return { rankVal, offsetIndex };
  },

  processNodes({
    nodeList,
    parentNode = null,
    nodeMap,
    ranks,
    policy,
    options,
    measureTextWidth,
    BOUNDARY_H_PAD
  }) {
    // Sort nodeList using the resolved constraint ranks
    const sortedNodeList = window.NudgeRenderer.elkGraphTransform.sortNodesByRank(nodeList, ranks);

    const rankCounts = {};

    for (const rawNode of sortedNodeList) {
      const node = window.NudgeRenderer.elkGraphTransform.createElkNode(rawNode);

      // Apply Layout Placement Hints
      const direction = options["elk.direction"] || "DOWN";
      const { rankVal, offsetIndex } = window.NudgeRenderer.elkGraphTransform.prepareNodeLayerPlacement({
        node,
        ranks,
        policy,
        rankCounts
      });

      // Hint coordinates for semi-interactive layout
      /*
      if (direction === "DOWN") {
        node.x = offsetIndex * 180; // Separate horizontally within the same row/layer
        node.y = rankVal * 200;
      } else {
        node.x = rankVal * 200;
        node.y = offsetIndex * 150; // Separate vertically within the same column/layer
      }
      */

      // If it's a boundary node, it's a container box for nested components
      if (rawNode.type === "boundary") {
        window.NudgeRenderer.elkGraphTransform.configureBoundaryNode({
          node,
          rawNode,
          options,
          measureTextWidth,
          BOUNDARY_H_PAD
        });
      }

      window.NudgeRenderer.elkGraphTransform.registerNode(nodeMap, rawNode, node, parentNode);

      if (rawNode.children && rawNode.children.length > 0) {
        window.NudgeRenderer.elkGraphTransform.processNodes({
          nodeList: rawNode.children,
          parentNode: node,
          nodeMap,
          ranks,
          policy,
          options,
          measureTextWidth,
          BOUNDARY_H_PAD
        });
      }
    }
  },

  addEdgesToGraph({
    diagramData,
    graph,
    nodeMap,
    options,
    ranks,
    crossHierarchyNodes,
    createConnectionLabel,
    addPortToNode,
    findNodeById,
    findClosestCommonAncestor
  }) {
    if (diagramData.edges) {
      diagramData.edges.forEach((e, idx) => {
        const edge = window.NudgeRenderer.elkGraphTransform.createElkEdge(e, idx, createConnectionLabel);

        window.NudgeRenderer.elkGraphTransform.applyPortRouting({
          e,
          idx,
          edge,
          nodeMap,
          options,
          ranks,
          diagramData,
          crossHierarchyNodes,
          addPortToNode
        });

        // Find nodes to check types for edge priority
        const srcNode = findNodeById(e.from);
        const tgtNode = findNodeById(e.to);
        window.NudgeRenderer.elkGraphTransform.applyRelationshipPriority(edge, srcNode, tgtNode);

        const ancestorId = findClosestCommonAncestor(e.from, e.to);
        window.NudgeRenderer.elkGraphTransform.attachEdgeToAncestor(edge, ancestorId, graph, nodeMap);
      });
    }
  },

  transformToElkGraph({ diagramData, measureTextWidth, createConnectionLabel, BOUNDARY_H_PAD }) {
    const options = diagramData.layoutOptions || {};

    const graph = window.NudgeRenderer.elkGraphTransform.createRootGraph(options);
    // Helper map to quickly find parent nodes
    const nodeMap = new Map();

    // --- LAYOUT CONSTRAINTS SOLVER ---
    const rules = diagramData.rules || [];
    let ranks = {};

    // --- DIAGRAM-SPECIFIC LAYOUT POLICIES ---
    const DIAGRAM_LAYOUT_POLICIES = window.NudgeRenderer.elkLayoutPolicies.create(findNodeById);

    const policyType = diagramData.diagramType || "C4Context";
    const policy = DIAGRAM_LAYOUT_POLICIES[policyType] || DIAGRAM_LAYOUT_POLICIES["C4Context"];

    // Helper to find nodes by ID or Type
    function findNodesMatching(selector) {
      return window.NudgeRenderer.elkGraphTransform.findNodesMatching(diagramData.nodes, selector);
    }

    // Helper to find a specific node by ID
    function findNodeById(id) {
      return window.NudgeRenderer.elkGraphTransform.findNodeById(diagramData.nodes, id);
    }

    window.NudgeRenderer.elkGraphTransform.initRanks(diagramData.nodes || [], ranks, policy);

    // Apply symmetrical flow adjustments for external nodes that point directly to people
    policy.applySensibleDefaults(diagramData.nodes, diagramData.edges, ranks);

    // 2. Resolve custom rules using Bellman-Ford style relaxation
    window.NudgeRenderer.elkGraphTransform.applyOrderingRules(rules, ranks, findNodesMatching);

    // First pass: Process and register all nodes
    window.NudgeRenderer.elkGraphTransform.processNodes({
      nodeList: diagramData.nodes || [],
      nodeMap,
      ranks,
      policy,
      options,
      measureTextWidth,
      BOUNDARY_H_PAD
    });

    // Assemble hierarchy based on node parent relationships
    window.NudgeRenderer.elkGraphTransform.assembleHierarchy(graph, nodeMap);

    // Find closest common ancestor node or graph object
    function findClosestCommonAncestor(idA, idB) {
      return window.NudgeRenderer.elkGraphTransform.findClosestCommonAncestor(nodeMap, idA, idB);
    }

    function addPortToNode(node, portId, side) {
      window.NudgeRenderer.elkGraphTransform.addPortToNode(node, portId, side);
    }

    // Identify nodes involved in cross-hierarchy edges
    const crossHierarchyNodes = window.NudgeRenderer.elkGraphTransform.collectCrossHierarchyNodes(diagramData.edges, nodeMap);

    // Add Edges at their closest common ancestor
    window.NudgeRenderer.elkGraphTransform.addEdgesToGraph({
      diagramData,
      graph,
      nodeMap,
      options,
      ranks,
      crossHierarchyNodes,
      createConnectionLabel,
      addPortToNode,
      findNodeById,
      findClosestCommonAncestor
    });

    return { graph, ranks };
  }
};
