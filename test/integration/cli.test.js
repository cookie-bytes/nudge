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

test('CLI colours a C4Context in three system tiers (focal / supporting / external)', (t, done) => {
  const fixture = path.resolve('test/fixtures/diagrams/core/three_tier_context.mermaid');
  const env = { ...process.env, NUDGE_NO_LLM: '1' };
  execFile('node', [CLI_PATH, fixture], { env }, (error, stdout, stderr) => {
    assert.equal(error, null, stderr);
    const svg = fs.readFileSync('.nudge/optimized.svg', 'utf8');
    // The in-scope (focal) system keeps node-container; internal supporting
    // systems get node-supporting; externals keep node-external.
    assert.ok(svg.includes('node node-container'), 'expected a focal node-container');
    assert.ok(svg.includes('node node-supporting'), 'expected a supporting node-supporting');
    assert.ok(svg.includes('node node-external'), 'expected an external node-external');
    // captureSvg embeds <head><style> inline, so the supporting fill must live
    // in the exported SVG for it to be self-contained.
    assert.match(svg, /\.node-supporting\s*\{[^}]*fill:\s*#2a3c66/);
    done();
  });
});
