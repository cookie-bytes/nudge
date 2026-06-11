import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';

const CLI_PATH = path.resolve('src/cli/index.js');
const FIXTURE_PATH = path.resolve('test/fixtures/diagrams/core/messaging_system.mermaid');

test('CLI fails with code 1 on missing input file', (t, done) => {
  execFile('node', [CLI_PATH, 'nonexistent_file.mermaid'], (error, stdout, stderr) => {
    assert.equal(error?.code, 1);
    assert.match(stderr, /Failed to read\/parse input file:/);
    done();
  });
});

test('CLI renders a valid diagram successfully and exits with code 0', (t, done) => {
  // We use messaging_system.mermaid since it is small and fast to render.
  execFile('node', [CLI_PATH, FIXTURE_PATH], (error, stdout, stderr) => {
    assert.equal(error, null);
    assert.match(stdout, /=== Nudge: Deterministic C4 Layout Engine ===/);
    assert.match(stdout, /Success! Optimized assets exported/);
    
    // Verify output files exist in .nudge/
    assert.ok(fs.existsSync('.nudge/optimized.svg'));
    assert.ok(fs.existsSync('.nudge/optimized.png'));
    
    done();
  });
});

test('CLI renders a valid PlantUML diagram successfully and exits with code 0', (t, done) => {
  const pumlFixturePath = FIXTURE_PATH.replace(/\.mermaid$/, '.puml');
  execFile('node', [CLI_PATH, pumlFixturePath], (error, stdout, stderr) => {
    assert.equal(error, null);
    assert.match(stdout, /=== Nudge: Deterministic C4 Layout Engine ===/);
    assert.match(stdout, /Input identified as PlantUML/);
    assert.match(stdout, /Success! Optimized assets exported/);
    
    // Verify output files exist in .nudge/
    assert.ok(fs.existsSync('.nudge/optimized.svg'));
    assert.ok(fs.existsSync('.nudge/optimized.png'));
    
    done();
  });
});
