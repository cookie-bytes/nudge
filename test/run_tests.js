import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { parseMermaidC4 } from '../src/mermaid_parser.js';
import { analyzeLayout } from '../src/core/geometry.js';
import { getActiveModel, getHeaders } from '../src/core/llm_client.js';
import { fetchWithTimeout } from '../src/utils.js';
import { optimizeDiagram } from '../src/core/optimizer.js';

const LM_STUDIO_API = process.env.NUDGE_LLM_API || 'http://127.0.0.1:1234';
const TEST_DIR = path.resolve('test');
const OUTPUT_DIR = path.resolve('test_outputs');

// Math-based grading fallback if LLM is offline
function gradeMathematically(report) {
  let c4AlignmentScore = 10;
  let aspectRatioScore = 10;
  let clarityScore = 10;

  // Deduct for collisions (overlaps are critical, crossings are minor layout defects)
  clarityScore -= (report.overlapCount * 5 + report.intersectionCount * 3);
  if (clarityScore < 0) clarityScore = 0;

  const ratio = parseFloat(report.aspectRatio);
  if (ratio < 0.5 || ratio > 3.0) {
    aspectRatioScore = 4;
  } else if (ratio < 1.0 || ratio > 2.0) {
    aspectRatioScore = 7;
  }

  c4AlignmentScore = report.overlapCount > 0 ? 6 : 10;

  const average = (c4AlignmentScore + aspectRatioScore + clarityScore) / 3;
  let finalGrade = 'F';
  if (average >= 9.0) finalGrade = 'A';
  else if (average >= 8.0) finalGrade = 'B';
  else if (average >= 7.0) finalGrade = 'C';
  else if (average >= 5.0) finalGrade = 'D';

  return {
    c4AlignmentScore,
    aspectRatioScore,
    clarityScore,
    finalGrade,
    gradeExplanation: `Fallback math grader: ${report.overlapCount} overlaps, ${report.intersectionCount} crossings, aspect ratio ${report.aspectRatio}.`
  };
}

// LLM layout grader
async function gradeWithLLM(model, result, report) {
  const prompt = `You are a C4 Architecture Diagram Quality Assurance Agent.
Evaluate the visual layout coordinates of this diagram according to the C4 Model standard and visual aesthetic principles.

Diagram Title: "${model.title}"
Diagram Type: "${model.diagramType || 'C4Context'}"

Nodes (absolute coordinates):
${JSON.stringify(result.nodes.map(n => ({ id: n.id, label: n.label, type: n.type, x: n.x, y: n.y, w: n.width, h: n.height })), null, 2)}

Edges (absolute coordinates and routing):
${JSON.stringify(result.edges.map(e => ({ id: e.id, label: e.labels[0]?.text, from: e.sources[0], to: e.targets[0] })), null, 2)}

Geometric Collision Report:
- Overlaps: ${report.overlapCount}
- Crossings: ${report.intersectionCount}
- Aspect Ratio: ${report.aspectRatio}

Evaluate the layout based on:
1. **C4 Actor/System Vertical Alignment (0-10):** In top-down C4 flow, Actors (person) must be at the top, systems/containers in the middle, and externals/databases at the bottom.
2. **Aspect Ratio & Balance (0-10):** Ideal landscape ratio is 1.2 to 1.8. It should look balanced.
3. **Clarity & Path Overlaps (0-10):** Overlaps and crossings reduce clarity.

Respond with a JSON object strictly in this format:
{
  "c4AlignmentScore": <number>,
  "aspectRatioScore": <number>,
  "clarityScore": <number>,
  "finalGrade": "<A/B/C/D/F>",
  "gradeExplanation": "<concise sentence explaining the grade>"
}
Remember: output ONLY the JSON object.`;

  try {
    const activeModel = await getActiveModel(LM_STUDIO_API);
    const response = await fetchWithTimeout(`${LM_STUDIO_API}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: activeModel,
        messages: [
          { role: "system", content: "You are a visual design QA bot." },
          { role: "user", content: prompt }
        ],
        temperature: 0.1
      }),
      headers: getHeaders(),
      timeout: 3000 // 3s timeout to fail fast
    });

    const data = await response.json();
    const rawContent = data.choices[0].message.content.trim();
    // Parse JSON
    const match = rawContent.match(/\{[\s\S]*?\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("Invalid LLM response format");
  } catch (err) {
    // Return mathematical fallback if LLM is offline/times out
    return gradeMathematically(report);
  }
}

async function runIntegrationTest() {
  console.log("\n=== Running Offline Deterministic Integration Test ===");
  
  const mockOutputDir = path.resolve('test_outputs/integration_test');
  if (fs.existsSync(mockOutputDir)) {
    fs.rmSync(mockOutputDir, { recursive: true, force: true });
  }

  // Sample C4Context diagram with potential tight spacing
  const mermaidDiagram = `
    C4Context
      title Sample Context Diagram
      Person(user, "User", "A user of the system")
      System(system, "Software System", "The software system under test")
      Rel(user, system, "Uses", "HTTPS")
  `;
  const model = parseMermaidC4(mermaidDiagram);
  // Force a small spacing initially to cause a layout warning / critic trigger
  model.layoutOptions["elk.spacing.nodeNode"] = "10";
  model.layoutOptions["elk.layered.spacing.nodeNodeBetweenLayers"] = "10";

  // Mock global fetch
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;

  globalThis.fetch = async (url, options) => {
    fetchCallCount++;
    const body = JSON.parse(options.body || '{}');
    
    // Determine which API call this is
    if (url.endsWith('/v1/models')) {
      return {
        ok: true,
        json: async () => ({
          data: [{ id: "mock-model" }]
        })
      };
    }

    if (url.endsWith('/v1/chat/completions')) {
      const messages = body.messages || [];
      const systemMessage = messages.find(m => m.role === 'system')?.content || '';

      if (systemMessage.includes("expert AI visual layout optimizer")) {
        // Optimization patch request
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  "elk.spacing.nodeNode": "150",
                  "elk.layered.spacing.nodeNodeBetweenLayers": "120"
                })
              }
            }]
          })
        };
      }
      
      if (systemMessage.includes("zone verification")) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  zoneOverrides: {},
                  swapCommands: [],
                  rationale: "Assignments correct."
                })
              }
            }]
          })
        };
      }

      if (systemMessage.includes("routing verification")) {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  swapCommands: [],
                  rationale: "Ordering is optimal."
                })
              }
            }]
          })
        };
      }
    }

    // Default fallback
    return {
      ok: true,
      json: async () => ({})
    };
  };

  try {
    const result = await optimizeDiagram({
      diagramModel: model,
      outputDir: mockOutputDir,
      apiUrl: 'http://mock-api.local',
      maxIterations: 3,
      onLog: (msg) => console.log(`  [Integration Log] ${msg.trim()}`),
    });

    console.log("Integration test finished. Success:", result.success);
    console.log("Iterations run:", result.history.length);
    console.log("Fetch call count:", fetchCallCount);

    if (!result.success) {
      throw new Error("Integration test failed: optimization did not succeed.");
    }
    if (result.history.length < 2) {
      throw new Error("Integration test failed: optimizer did not iterate to apply mock patch.");
    }
    if (!fs.existsSync(path.join(mockOutputDir, 'optimized.svg'))) {
      throw new Error("Integration test failed: optimized.svg was not created.");
    }
    if (!fs.existsSync(path.join(mockOutputDir, 'optimized.png'))) {
      throw new Error("Integration test failed: optimized.png was not created.");
    }

    console.log("✅ Integration test PASSED successfully!");
    return true;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runTests() {
  console.log("=== Nudge Diagram Layout Test Suite ===");
  
  // Run integration test first
  try {
    await runIntegrationTest();
  } catch (err) {
    console.error("❌ Integration test failed:", err.message);
    process.exit(1);
  }

  const useVisualLLM = process.env.NUDGE_VISUAL_TEST === 'true';
  console.log(`Mode: ${useVisualLLM ? 'Visual LLM-based critique' : 'Deterministic mathematical validation'}`);
  
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const testFiles = fs.readdirSync(TEST_DIR).filter(file => file.endsWith('.mermaid'));
  if (testFiles.length === 0) {
    console.error("No test mermaid files found in test/ folder.");
    process.exit(1);
  }

  console.log(`Found ${testFiles.length} test diagram(s). Initializing Playwright...`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const templatePath = new URL('../src/render.html', import.meta.url).href;
  await page.goto(templatePath);
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`  PAGE ${msg.type().toUpperCase()}:`, msg.text());
    }
  });

  const summary = [];
  let allTestsPassed = true;

  for (const file of testFiles) {
    const baseName = path.basename(file, '.mermaid');
    console.log(`\nRendering: ${file}...`);
    
    const content = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    const model = parseMermaidC4(content);

    // Call window.renderDiagram in the browser context
    const result = await page.evaluate(async (data) => {
      return await window.renderDiagram(data);
    }, model);

    if (!result.success) {
      console.error(`  [FAIL] Failed to render diagram: ${result.error}`);
      allTestsPassed = false;
      summary.push({ file, grade: 'F', explanation: `Rendering error: ${result.error}`, collisions: 'N/A' });
      continue;
    }

    // Take screenshot and SVG source
    const screenshotPath = path.join(OUTPUT_DIR, `${baseName}.png`);
    const svgPath = path.join(OUTPUT_DIR, `${baseName}.svg`);

    const svgElement = await page.$('#svg-root');
    await page.setViewportSize({
      width: Math.ceil(result.width) + 100,
      height: Math.ceil(result.height) + 100
    });
    await svgElement.screenshot({ path: screenshotPath });

    const svgMarkup = await page.locator('#svg-root').innerHTML();
    fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${result.width} ${result.height}">${svgMarkup}</svg>`);

    // Geometric critique
    const report = analyzeLayout(result);
    const totalCollisions = report.overlapCount + report.intersectionCount;

    // Grade
    const useVisualLLM = process.env.NUDGE_VISUAL_TEST === 'true';
    const gradeResult = useVisualLLM
      ? await gradeWithLLM(model, result, report)
      : gradeMathematically(report);
    const isPass = totalCollisions === 0 && (gradeResult.finalGrade === 'A' || gradeResult.finalGrade === 'B');

    summary.push({
      file,
      c4Align: gradeResult.c4AlignmentScore,
      aspect: gradeResult.aspectRatioScore,
      clarity: gradeResult.clarityScore,
      grade: gradeResult.finalGrade,
      explanation: gradeResult.gradeExplanation,
      collisions: totalCollisions,
      status: isPass ? "PASSED" : "FAILED"
    });

    if (!isPass) {
      allTestsPassed = false;
    }
  }

  await browser.close();

  // Print results summary
  console.log("\n=======================================================");
  console.log("                    TEST RUN SUMMARY                    ");
  console.log("=======================================================");
  console.table(summary.map(s => ({
    File: s.file,
    'C4 Align': s.c4Align,
    Aspect: s.aspect,
    Clarity: s.clarity,
    Grade: s.grade,
    Collisions: s.collisions,
    Status: s.status
  })));

  // Write markdown report
  let mdReport = `# Nudge Layout Test Run Results\n\n`;
  mdReport += `Generated on: ${new Date().toISOString()}\n\n`;
  mdReport += `| File | C4 Align Score | Aspect Score | Clarity Score | Grade | Collisions | Status | Explanation |\n`;
  mdReport += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |\n`;
  for (const s of summary) {
    mdReport += `| [${s.file}](file://${path.join(TEST_DIR, s.file)}) | ${s.c4Align} | ${s.aspect} | ${s.clarity} | **${s.grade}** | ${s.collisions} | ${s.status === 'PASSED' ? '✅ PASSED' : '❌ FAILED'} | ${s.explanation} |\n`;
  }
  mdReport += `\n*Visual snapshot assets saved in [test_outputs/](file://${OUTPUT_DIR}) directory.*\n`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'test_results.md'), mdReport);
  console.log(`\nMarkdown test results summary saved to: ${path.join(OUTPUT_DIR, 'test_results.md')}`);

  if (allTestsPassed) {
    console.log("\n🎉 All tests passed successfully with 0 collisions and acceptable visual grading!");
    process.exit(0);
  } else {
    console.log("\n⚠️ Some test diagrams failed layout checks (collisions detected or poor design grade). Check the snapshots.");
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Fatal error running test suite:", err);
  process.exit(1);
});
