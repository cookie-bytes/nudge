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
import yaml from 'js-yaml';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseMermaidC4 } from '../mermaid_parser.js';
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
        'Optimize a C4 architecture diagram using AI-driven layout analysis. ' +
        'Accepts Mermaid C4Context/C4Container syntax or YAML diagram content. ' +
        'Returns an optimized SVG string with zero node overlaps and clean edge routing.',
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

  const { content, format } = request.params.arguments;

  // Auto-detect format if not specified
  const trimmed = content.trimStart();
  const isMermaid =
    format === 'mermaid' ||
    (!format && (trimmed.startsWith('C4Context') || trimmed.startsWith('C4Container')));

  let diagramModel;
  try {
    diagramModel = isMermaid ? parseMermaidC4(content) : yaml.load(content);
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
    const { success, history, svgContent } = await optimizeDiagram({
      diagramModel,
      outputDir: tmpDir,
      onLog: (msg) => server.sendLoggingMessage({ level: 'info', data: msg }),
      signal: extra.signal,
      checkpointTimeout: 15000,
      optimizationTimeout: 20000,
    });

    const finalCollisions = history.at(-1)?.collisions ?? 0;
    const summary = success
      ? `Optimized in ${history.length} iteration(s) — zero collisions.`
      : `Best-effort result after ${history.length} iteration(s) — ${finalCollisions} collision(s) remain. SVG is still usable.`;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success, summary, iterations: history.length, finalCollisions }, null, 2),
        },
        {
          type: 'text',
          text: svgContent ?? 'No SVG produced — rendering failed before any layout could be captured.',
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
