window.NudgeRenderer.elkLayoutPolicies = {
  create(findNodeById) {
    return {
      C4Context: {
        getDefaultRank(type) {
          if (type === "person") return 0;
          if (type === "container" || type === "system") return 1;
          if (type === "external" || type === "database" || type === "message_bus") return 2;
          return 0;
        },
        applyLayerConstraints(node, rankVal) {
          if (node.type === "person") {
            node.layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST";
          } else if (node.type === "external" && rankVal >= 2) {
            node.layoutOptions["elk.layered.layering.layerConstraint"] = "LAST";
          }
        },
        applySensibleDefaults(nodes, edges, ranks) {
          if (!edges) return;
          for (const edge of edges) {
            const srcNode = findNodeById(edge.from);
            const tgtNode = findNodeById(edge.to);
            if (srcNode && tgtNode) {
              if (srcNode.type === "external" && ranks[tgtNode.id] === 0) {
                ranks[srcNode.id] = 0;
              }
            }
          }
        }
      },

      C4Container: {
        getDefaultRank(type) {
          if (type === "person") return 0;
          if (type === "container" || type === "system") return 1;
          if (type === "database" || type === "message_bus") return 2;
          if (type === "external") return 3;
          return 0;
        },
        applyLayerConstraints(node, rankVal) {
          if (node.type === "person") {
            // node.layoutOptions["elk.layered.layering.layerConstraint"] = "FIRST";
          } else if (node.type === "external" && rankVal >= 3) {
            node.layoutOptions["elk.layered.layering.layerConstraint"] = "LAST";
          }
        },
        applySensibleDefaults(nodes, edges, ranks) {
          if (!edges) return;
          for (const edge of edges) {
            const srcNode = findNodeById(edge.from);
            const tgtNode = findNodeById(edge.to);
            if (srcNode && tgtNode) {
              if (srcNode.type === "external" && ranks[tgtNode.id] === 0) {
                ranks[srcNode.id] = 0;
              }
            }
          }
        }
      }
    };
  }
};
