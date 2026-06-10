import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import path from 'path';

const MCP_PATH = path.resolve('src/mcp/index.js');

test('MCP server responds to initialize and advertises optimize_diagram tool', (t, done) => {
  const child = spawn('node', [MCP_PATH]);
  let outputBuffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    outputBuffer += data;
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || ''; // Keep the last partial line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        if (response.id === 0) {
          // Initialize response received. Now send tools/list request.
          const listRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {}
          };
          child.stdin.write(JSON.stringify(listRequest) + '\n');
        } else if (response.id === 1) {
          // tools/list response received. Verify optimize_diagram exists.
          const tools = response.result?.tools || [];
          const optimizeTool = tools.find(t => t.name === 'optimize_diagram');
          
          assert.ok(optimizeTool);
          assert.equal(optimizeTool.name, 'optimize_diagram');
          assert.match(optimizeTool.description, /Optimize a C4 architecture diagram/);
          
          // Cleanup
          child.kill();
          done();
        }
      } catch (err) {
        child.kill();
        done(err);
      }
    }
  });

  child.stderr.on('data', (data) => {
    // We can log stderr for debugging if needed, but it shouldn't interfere with stdout
  });

  child.on('error', (err) => {
    done(err);
  });

  // Start initialization handshake
  const initRequest = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  };
  child.stdin.write(JSON.stringify(initRequest) + '\n');
});
