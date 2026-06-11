import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { parsePlantUMLC4 } from '../src/plantuml_parser.js';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT_DIR = path.join(WORKSPACE_ROOT, 'test_outputs', 'refactor_rig');
function parseArgs(argv) {
  const args = {
    baselineRef: 'HEAD',
    candidateDir: WORKSPACE_ROOT,
    fixturesDir: path.join(WORKSPACE_ROOT, 'test', 'fixtures', 'diagrams'),
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline-ref') args.baselineRef = argv[++i];
    else if (arg === '--candidate-dir') args.candidateDir = path.resolve(argv[++i]);
    else if (arg === '--fixtures-dir') args.fixturesDir = path.resolve(argv[++i]);
    else if (arg === '--output-dir') args.outputDir = path.resolve(argv[++i]);
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: npm run test:refactor -- [options]

Options:
  --baseline-ref <git-ref>    Git ref containing the legacy renderer. Default: HEAD
  --candidate-dir <path>      Working tree containing the candidate renderer. Default: repo root
  --fixtures-dir <path>       Directory containing .mermaid fixtures. Default: test/fixtures/diagrams/
  --output-dir <path>         Artifact directory. Default: test_outputs/refactor_rig/

The rig renders every fixture twice with Playwright: once through the baseline
render_engine.js from --baseline-ref, and once through the candidate renderer.
It writes JSON and SVG artifacts for both lanes and fails on any byte mismatch.`);
}

function readGitFile(ref, repoRoot, filePath) {
  return execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${filePath}`], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

function copyFileOrThrow(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Required file not found: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirRecursive(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const srcPath = path.join(source, entry.name);
    const dstPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function materializeRuntime({ lane, outputDir, baselineRef, candidateDir }) {
  const runtimeDir = path.join(outputDir, '_runtime', lane);
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(runtimeDir, 'vendor'), { recursive: true });

  if (lane === 'baseline') {
    fs.writeFileSync(path.join(runtimeDir, 'render.html'), readGitFile(baselineRef, WORKSPACE_ROOT, 'src/render.html'));
    fs.writeFileSync(path.join(runtimeDir, 'render_engine.js'), readGitFile(baselineRef, WORKSPACE_ROOT, 'src/render_engine.js'));
    try {
      const hasRenderer = execFileSync('git', ['-C', WORKSPACE_ROOT, 'ls-tree', '-d', '--name-only', baselineRef, 'src/renderer'], { encoding: 'utf8' }).trim();
      if (hasRenderer) {
        const tarPath = path.join(runtimeDir, 'renderer.tar');
        execFileSync('git', ['-C', WORKSPACE_ROOT, 'archive', '--format=tar', '-o', tarPath, baselineRef, 'src/renderer']);
        execFileSync('tar', ['-xf', tarPath, '-C', runtimeDir]);
        fs.rmSync(tarPath);
        fs.renameSync(path.join(runtimeDir, 'src', 'renderer'), path.join(runtimeDir, 'renderer'));
        fs.rmSync(path.join(runtimeDir, 'src'), { recursive: true, force: true });
      }
    } catch (e) {
      // Ignore errors if src/renderer does not exist in baselineRef
    }
  } else {
    copyFileOrThrow(path.join(candidateDir, 'src', 'render.html'), path.join(runtimeDir, 'render.html'));
    copyFileOrThrow(path.join(candidateDir, 'src', 'render_engine.js'), path.join(runtimeDir, 'render_engine.js'));
    copyDirRecursive(path.join(candidateDir, 'src', 'renderer'), path.join(runtimeDir, 'renderer'));
  }

  const vendorPath = path.join(candidateDir, 'src', 'vendor', 'elk.bundled.js');
  const nodeModuleVendorPath = path.join(candidateDir, 'node_modules', 'elkjs', 'lib', 'elk.bundled.js');
  if (fs.existsSync(vendorPath)) {
    copyFileOrThrow(vendorPath, path.join(runtimeDir, 'vendor', 'elk.bundled.js'));
  } else {
    copyFileOrThrow(nodeModuleVendorPath, path.join(runtimeDir, 'vendor', 'elk.bundled.js'));
  }

  return runtimeDir;
}

function listFixtureFiles(fixturesDir) {
  const files = [];
  for (const entry of fs.readdirSync(fixturesDir, { withFileTypes: true })) {
    const entryPath = path.join(fixturesDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFixtureFiles(entryPath));
    } else if (entry.isFile() && (entry.name.endsWith('.mermaid') || entry.name.endsWith('.puml'))) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortKeys(value[key]);
    return acc;
  }, {});
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function firstDiffIndex(a, b) {
  const max = Math.min(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  }
  return a.length === b.length ? -1 : max;
}

function diffSnippet(a, b) {
  const idx = firstDiffIndex(a, b);
  if (idx === -1) return 'No textual difference.';

  const start = Math.max(0, idx - 80);
  const end = idx + 160;
  return [
    `first difference at byte ${idx}`,
    `baseline: ${JSON.stringify(a.slice(start, end))}`,
    `candidate: ${JSON.stringify(b.slice(start, end))}`,
  ].join('\n');
}

async function createRendererPage(browser, runtimeDir, onBrowserMessage) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      onBrowserMessage(`[${path.basename(runtimeDir)}] ${msg.type().toUpperCase()}: ${msg.text()}`);
    }
  });
  page.on('pageerror', err => onBrowserMessage(`[${path.basename(runtimeDir)}] PAGEERROR: ${err.message}`));
  await page.goto(new URL('render.html', pathToFileURL(runtimeDir + path.sep)).href);
  return page;
}

async function renderFixture(page, fixturePath) {
  const content = fs.readFileSync(fixturePath, 'utf8');
  const diagramModel = fixturePath.endsWith('.puml') ? parsePlantUMLC4(content) : parseMermaidC4(content);
  const result = await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);
  const svgMarkup = await page.locator('#svg-root').innerHTML();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.width} ${result.height}">${svgMarkup}</svg>\n`;
  return {
    resultJson: stableJson(result),
    svg,
  };
}

function writeArtifact(outputDir, lane, fixturePath, extension, content) {
  const relativeName = path.relative(WORKSPACE_ROOT, fixturePath)
    .replace(/\.(mermaid|puml)$/, '')
    .replaceAll(path.sep, '__');
  const baseName = relativeName.replace(/^test__/, '');
  const filePath = path.join(outputDir, lane, `${baseName}.${extension}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const fixtureFiles = listFixtureFiles(args.fixturesDir);
  if (fixtureFiles.length === 0) {
    throw new Error(`No .mermaid or .puml fixtures found in ${args.fixturesDir}`);
  }

  fs.rmSync(args.outputDir, { recursive: true, force: true });
  fs.mkdirSync(args.outputDir, { recursive: true });

  const baselineRuntime = materializeRuntime({
    lane: 'baseline',
    outputDir: args.outputDir,
    baselineRef: args.baselineRef,
    candidateDir: args.candidateDir,
  });
  const candidateRuntime = materializeRuntime({
    lane: 'candidate',
    outputDir: args.outputDir,
    baselineRef: args.baselineRef,
    candidateDir: args.candidateDir,
  });

  console.log('=== Nudge Refactor Test Rig ===');
  console.log(`Baseline ref:  ${args.baselineRef}`);
  console.log(`Candidate dir: ${args.candidateDir}`);
  console.log(`Fixtures:      ${fixtureFiles.length} Mermaid files from ${args.fixturesDir}`);
  console.log(`Artifacts:     ${args.outputDir}`);

  const browserMessages = [];
  const browser = await chromium.launch({ headless: true });
  const baselinePage = await createRendererPage(browser, baselineRuntime, msg => browserMessages.push(msg));
  const candidatePage = await createRendererPage(browser, candidateRuntime, msg => browserMessages.push(msg));

  const summary = [];
  let failed = false;

  try {
    for (const fixturePath of fixtureFiles) {
      const fixtureName = path.basename(fixturePath);
      const baseline = await renderFixture(baselinePage, fixturePath);
      const candidate = await renderFixture(candidatePage, fixturePath);

      const baselineJsonPath = writeArtifact(args.outputDir, 'baseline', fixturePath, 'json', baseline.resultJson);
      const candidateJsonPath = writeArtifact(args.outputDir, 'candidate', fixturePath, 'json', candidate.resultJson);
      const baselineSvgPath = writeArtifact(args.outputDir, 'baseline', fixturePath, 'svg', baseline.svg);
      const candidateSvgPath = writeArtifact(args.outputDir, 'candidate', fixturePath, 'svg', candidate.svg);

      const jsonMatch = baseline.resultJson === candidate.resultJson;
      const svgMatch = baseline.svg === candidate.svg;
      const passed = jsonMatch && svgMatch;
      failed ||= !passed;

      summary.push({
        fixture: fixtureName,
        status: passed ? 'PASSED' : 'FAILED',
        jsonMatch,
        svgMatch,
        baselineJsonHash: sha256(baseline.resultJson),
        candidateJsonHash: sha256(candidate.resultJson),
        baselineSvgHash: sha256(baseline.svg),
        candidateSvgHash: sha256(candidate.svg),
        baselineJsonPath,
        candidateJsonPath,
        baselineSvgPath,
        candidateSvgPath,
        jsonDiff: jsonMatch ? '' : diffSnippet(baseline.resultJson, candidate.resultJson),
        svgDiff: svgMatch ? '' : diffSnippet(baseline.svg, candidate.svg),
      });

      console.log(`${passed ? 'PASS' : 'FAIL'} ${fixtureName} json=${jsonMatch ? 'same' : 'diff'} svg=${svgMatch ? 'same' : 'diff'}`);
    }
  } finally {
    await browser.close();
  }

  const reportPath = path.join(args.outputDir, 'refactor_test_results.json');
  fs.writeFileSync(reportPath, stableJson({
    baselineRef: args.baselineRef,
    candidateDir: args.candidateDir,
    fixturesDir: args.fixturesDir,
    browserMessages,
    summary,
  }));

  if (browserMessages.length) {
    console.log('\nBrowser warnings/errors:');
    for (const message of browserMessages) console.log(`  ${message}`);
  }

  if (failed) {
    const firstFailure = summary.find(item => item.status === 'FAILED');
    console.error(`\nRefactor parity failed. Full report: ${reportPath}`);
    console.error(`First failure: ${firstFailure.fixture}`);
    if (firstFailure.jsonDiff) console.error(`\nJSON diff:\n${firstFailure.jsonDiff}`);
    if (firstFailure.svgDiff) console.error(`\nSVG diff:\n${firstFailure.svgDiff}`);
    process.exit(1);
  }

  console.log(`\nAll refactor parity checks passed. Full report: ${reportPath}`);
}

run().catch(err => {
  console.error(`Refactor test rig failed: ${err.stack || err.message}`);
  process.exit(1);
});
