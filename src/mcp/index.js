#!/usr/bin/env node

// MCP stdio uses stdout exclusively for JSON protocol messages.
// Redirect all console output to stderr so nothing corrupts the transport.
console.log = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.info = console.log;
console.warn = console.log;
console.error = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');

import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';

const NUDGE_OUTPUT_DIR = process.env.NUDGE_OUTPUT_DIR || path.join(os.homedir(), '.nudge', 'output');
fs.mkdirSync(NUDGE_OUTPUT_DIR, { recursive: true });
import yaml from 'js-yaml';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseMermaidC4 } from '../mermaid_parser.js';
import { parsePlantUMLC4 } from '../plantuml_parser.js';
import { optimizeDiagram } from '../core/optimizer.js';

const server = new Server(
  { name: 'nudge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'optimize_diagram',
      description:
        'Optimize a C4 architecture diagram using geometric layout analysis. ' +
        'Accepts Mermaid C4Context/C4Container syntax or YAML diagram content. ' +
        'Returns a JSON summary with svgPath and pngPath pointing to files saved in ~/.nudge/output/.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The diagram source — either Mermaid C4Context/C4Container syntax or YAML diagram model.',
          },
          format: {
            type: 'string',
            enum: ['mermaid', 'yaml'],
            description: 'Input format. If omitted, auto-detected from content.',
          },
          enhance: {
            type: 'boolean',
            description: 'Enable optional LLM optimization / visual-hint enhancement pipeline (requires local LLM server). Defaults to false.',
          },
        },
        required: ['content'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== 'optimize_diagram') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const { content, format, enhance = false } = request.params.arguments;

  // Auto-detect format if not specified
  const trimmed = content.trimStart();
  const isMermaid =
    format === 'mermaid' ||
    (!format && (trimmed.startsWith('C4Context') || trimmed.startsWith('C4Container')));
  const isPlantUML =
    format === 'plantuml' ||
    format === 'puml' ||
    (!format && trimmed.startsWith('@startuml'));

  let diagramModel;
  try {
    if (isMermaid) {
      diagramModel = parseMermaidC4(content);
    } else if (isPlantUML) {
      diagramModel = parsePlantUMLC4(content);
    } else {
      diagramModel = yaml.load(content);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to parse diagram content: ${err.message}` }],
      isError: true,
    };
  }

  if (!diagramModel?.nodes || !diagramModel?.edges) {
    return {
      content: [{ type: 'text', text: 'Invalid diagram model — missing nodes or edges array.' }],
      isError: true,
    };
  }

  const tmpDir = path.join(os.tmpdir(), `nudge-${randomUUID()}`);

  try {
    const { success, history, svgContent, pngPath, notes = [], warnings = [] } = await optimizeDiagram({
      diagramModel,
      outputDir: tmpDir,
      onLog: (msg) => server.sendLoggingMessage({ level: 'info', data: msg }),
      signal: extra.signal,
      checkpointTimeout: 15000,
      optimizationTimeout: 20000,
      enhance,
    });

    const finalEntry = history.at(-1) || {};
    const finalCollisions = finalEntry.collisions ?? 0;
    // The full defect vector, not just the collision total — four of the six
    // classes were previously invisible to any MCP client.
    const quality = {
      elementOverlaps: finalEntry.overlaps ?? 0,
      lineElementCrossings: finalEntry.crossings ?? 0,
      labelElementCrossings: finalEntry.labelElementCrossings ?? 0,
      lineOverlaps: finalEntry.lineOverlaps ?? 0,
      lineCrossings: finalEntry.lineCrossings ?? 0,
      labelLineIntersections: finalEntry.labelLineIntersections ?? 0,
      labelLabelOverlaps: finalEntry.labelLabelOverlaps ?? 0,
    };
    const summary = success
      ? `Optimized in ${history.length} iteration(s) — zero collisions.`
      : `Best-effort result after ${history.length} iteration(s) — ${finalCollisions} collision(s) remain. SVG is still usable.`;

    const title = (diagramModel.title || 'diagram').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `${title}_${timestamp}`;

    let svgPath = null;
    if (svgContent) {
      svgPath = path.join(NUDGE_OUTPUT_DIR, `${baseName}.svg`);
      fs.writeFileSync(svgPath, svgContent);
    }

    let pngOutputPath = null;
    if (pngPath) {
      pngOutputPath = path.join(NUDGE_OUTPUT_DIR, `${baseName}.png`);
      fs.copyFileSync(pngPath, pngOutputPath);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success, summary, iterations: history.length, finalCollisions, quality, svgPath, pngPath: pngOutputPath, notes, warnings }, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Optimizer error: ${err.message}` }],
      isError: true,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
