import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import { analyzeLayout } from './geometry.js';
import { scoreLayout, isClean } from './severity.js';
import { assertSupportedDiagram } from './validation.js';
import {
  getLLMOptimizationPatch,
  getLLMLabelPlacementHints
} from './llm_client.js';

// Generic words that carry no identifying signal in a C4 diagram title or a
// system label. They are stripped before scoring so that words like "Service"
// and "System" (which appear in almost every label) do not cause false or
// tied matches.
const SCOPE_STOPWORDS = new Set([
  'c4', 'context', 'diagram', 'system', 'systems', 'service', 'services',
  'the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'with',
  'platform', 'app', 'application', 'core', 'main', 'simplified'
]);

// Split a string into significant lowercase tokens: camelCase boundaries are
// broken (bankingSystem → banking, system), punctuation becomes whitespace,
// single characters and stopwords are dropped.
function scopeTokens(str) {
  return new Set(
    String(str || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !SCOPE_STOPWORDS.has(t))
  );
}

/**
 * Infer the single "system in scope" from a diagram title by scoring each
 * candidate's label + id token overlap against the normalized title. Returns
 * the winning candidate, or null when nothing clears the bar or two candidates
 * tie (fail-safe: no highlight rather than a wrong guess).
 *
 * @param {string} title
 * @param {Array<{id:string,label:string}>} candidates - internal `container` systems only
 */
export function matchInScopeByTitle(title, candidates) {
  const titleTokens = scopeTokens(title);
  if (titleTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const candidate of candidates || []) {
    const cTokens = scopeTokens(candidate.label);
    for (const t of scopeTokens(candidate.id)) cTokens.add(t);

    let score = 0;
    for (const t of titleTokens) if (cTokens.has(t)) score++;

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  return bestScore > 0 && !tied ? best : null;
}

/**
 * Identify the in-scope system in a C4Context diagram and mark it with
 * `inScope: true`; every other internal `container` system is marked
 * `supporting: true`. Recurses into boundaries so it works whether the model
 * uses a real boundary, the synthetic-context boundary, or a flat layout. An
 * explicit `%% Scope: <id>` override (`diagramModel.scopeId`) wins over the
 * title heuristic. When no confident match is found, nothing is flagged and
 * every internal system keeps its default colour (fail-safe).
 *
 * This flag is a shared contract also consumed by the central-prominence
 * colouring; detection lives here so it is implemented exactly once.
 *
 * @returns {object|null} the in-scope node, or null when none matched
 */
export function detectInScopeSystem(diagramModel) {
  const candidates = [];
  const collect = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'container') candidates.push(n);
      if (n.children) collect(n.children);
    }
  };
  collect(diagramModel.nodes);
  if (candidates.length === 0) return null;

  // Clear any stale flags from a prior normalization pass.
  for (const c of candidates) { delete c.inScope; delete c.supporting; }

  let winner = null;
  if (diagramModel.scopeId) {
    winner = candidates.find(c => c.id === diagramModel.scopeId) || null;
  }
  if (!winner) {
    winner = matchInScopeByTitle(diagramModel.title, candidates);
  }
  if (!winner) return null;

  for (const c of candidates) {
    if (c === winner) c.inScope = true;
    else c.supporting = true;
  }
  return winner;
}

/**
 * The full defect vector for one rendered layout — all six classes the critic
 * detects, plus the route-shape metrics. Every history entry carries the same
 * shape so the CLI table, the MCP JSON summary and the quality baselines all
 * report the same numbers rather than each projecting their own subset.
 */
export function defectVector(report) {
  const edge = report.edgeQuality || {};
  return {
    collisions: report.collisions.length,
    overlaps: report.overlapCount,
    crossings: report.intersectionCount,
    labelElementCrossings: report.labelElementCrossingCount || 0,
    labelOffCanvas: report.labelOffCanvasCount || 0,
    labelLabelOverlaps: report.labelLabelOverlapCount || 0,
    lineCrossings: edge.edgeCrossingCount || 0,
    lineOverlaps: edge.edgeOverlapCount || 0,
    labelLineIntersections: edge.labelEdgeIntersectionCount || 0,
    bends: edge.totalBends || 0,
    routeLength: edge.totalRouteLength || 0,
    aspectRatio: report.aspectRatio,
  };
}

/**
 * Normalise a parsed diagram model before rendering, shared by every entry
 * point (CLI, MCP). Infers the diagram type when the input format does not
 * declare one (YAML), and wraps a C4Context diagram's internal architecture
 * elements in a hidden synthetic boundary so context diagrams reuse the
 * container layout pipeline. Persons and external systems stay outside the
 * boundary, where the container plan places them in its external zones.
 */
export function normalizeDiagramModel(diagramModel) {
  // NOTE: this function mutates and returns the *same* object on every path,
  // only ever reassigning `.nodes`. The top-level `notes` (annotations) and
  // `warnings` collections survive by identity and are intentionally passed
  // through untouched — do not spread this model into a fresh object here, or a
  // future refactor would silently drop them before rendering.

  // Enforce the single-Boundary contract before anything else, so an
  // unsupported diagram is refused rather than half-drawn. Deliberately ahead of
  // the synthetic context Boundary below: that one is ours, added to a diagram
  // that by definition had none.
  assertSupportedDiagram(diagramModel);

  const hasBoundary = (diagramModel.nodes || []).some(n => n.type === 'boundary');
  if (!diagramModel.diagramType) {
    diagramModel.diagramType = hasBoundary ? 'C4Container' : 'C4Context';
  }

  // In-scope detection is a shared foundation (colouring + centering). Run it
  // for every C4Context diagram — before the synthetic-boundary wrap below so
  // the flag rides along on the child node, and regardless of whether the
  // diagram already has a real boundary or takes the flat path.
  if (String(diagramModel.diagramType).startsWith('C4Context')) {
    detectInScopeSystem(diagramModel);
  }

  if (hasBoundary || diagramModel._contextBoundaryAdded) return diagramModel;
  if (!String(diagramModel.diagramType).startsWith('C4Context')) return diagramModel;

  // Central prominence (not isolation): all internal systems stay inside the
  // synthetic boundary; only people and true externals sit outside, where the
  // container plan's zone classifier arranges them around the interior cluster.
  // The focal system is made prominent by colour (via the `inScope` flag set in
  // detectInScopeSystem above), not by being geometrically alone in the centre.
  // See docs/c4-central-prominence-implementation-plan.md.
  const outsideTypes = new Set(['person', 'person_ext', 'external']);
  const insideNodes = (diagramModel.nodes || []).filter(n => !outsideTypes.has(n.type));
  const outsideNodes = (diagramModel.nodes || []).filter(n => outsideTypes.has(n.type));

  if (insideNodes.length === 0 || outsideNodes.length === 0) return diagramModel;

  diagramModel.nodes = [...outsideNodes, {
    id: '__context_boundary',
    label: 'System Context',
    type: 'boundary',
    children: insideNodes,
    _synthetic: true
  }];
  diagramModel._contextBoundaryAdded = true;
  return diagramModel;
}

/** The palettes the renderer can draw. */
export const THEMES = ['dark', 'light'];

/** Accepted values for the `theme` option. */
export const THEME_REQUESTS = ['auto', 'dark', 'light', 'both'];

/**
 * `theme` option -> what to render, and whether the SVG adapts to its viewer.
 *
 * `auto` is the default and only affects the SVG. A raster has to commit to one
 * palette, so the PNG is dark as it has always been; the SVG instead carries
 * both palettes and picks one from the viewer's `prefers-color-scheme`, falling
 * back to dark where that is unknown. Naming a palette explicitly pins both
 * outputs to it.
 */
export function resolveThemes(theme = 'auto') {
  if (theme === 'auto') return { themes: ['dark'], adaptive: true };
  if (theme === 'both') return { themes: ['dark', 'light'], adaptive: false };
  if (THEMES.includes(theme)) return { themes: [theme], adaptive: false };
  throw new TypeError(
    `optimizeDiagram: unknown theme ${JSON.stringify(theme)}. Expected one of ${THEME_REQUESTS.join(', ')}.`
  );
}

/**
 * Select a palette on the live page.
 *
 * Dark is what the bare `:root` block declares, so `data-theme="dark"` matches
 * no rule and is a deliberate no-op — set anyway so the attribute always states
 * which theme a render is, in the page and in the export alike.
 */
async function applyTheme(page, theme) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

export const LIGHT_THEME_SELECTOR = ':root[data-theme="light"]';

/**
 * Read the light palette's declarations straight out of the CSSOM.
 *
 * An adaptive export needs the light values under a second selector — one the
 * stylesheet cannot express, because a media query cannot be part of a selector
 * list. Rather than keep a second copy of the palette in render.html, where the
 * two could silently drift, the copy is generated at export time from the one
 * that renders. Read through the CSSOM rather than by parsing the stylesheet
 * text: the browser has already parsed it exactly, so there is no regex to be
 * wrong about a format change.
 */
async function readLightDeclarations(page) {
  return page.evaluate((selector) => {
    // Specifically the inline stylesheet — the same element `exportStyles`
    // reads. Walking `document.styleSheets` instead would reach the
    // cross-origin webfont link, whose `cssRules` throws SecurityError.
    const sheet = document.querySelector('head style')?.sheet;
    for (const rule of sheet?.cssRules ?? []) {
      if (rule.selectorText === selector) return rule.style.cssText;
    }
    return '';
  }, LIGHT_THEME_SELECTOR);
}

async function captureSvg(page, width, height, { theme = 'dark', adaptive = false } = {}) {
  const [svgMarkup, styles, lightDeclarations] = await Promise.all([
    page.locator('#svg-root').innerHTML(),
    page.evaluate(() => document.querySelector('head style')?.textContent ?? ''),
    adaptive ? readLightDeclarations(page) : Promise.resolve(''),
  ]);
  // The export is served and parsed as image/svg+xml, where a style element's
  // content is XML text — so a literal angle bracket anywhere in it ends the
  // document. CSS itself has no reason to contain one here, but prose comments
  // do (the theme token block documents which elements `:root` matches), and a
  // single stray bracket makes the whole file unopenable rather than merely
  // mis-styled. Stripping comments removes the entire failure mode instead of
  // relying on everyone who edits render.html remembering the rule; it also
  // trims a few KB off every exported diagram.
  const exportStyles = styles
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.trimEnd())
    .join('\n');
  // The HTML serialiser writes a non-breaking space as `&nbsp;`, which XML does
  // not predefine — so one blank note line, or one U+00A0 anywhere in a label,
  // makes the whole exported file refuse to open. `&#160;` is the same
  // character and is valid in both grammars. Of the entities the serialiser can
  // emit (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&nbsp;`) this is the only one XML
  // does not already know, so handling it here covers every source.
  const xmlSafeMarkup = svgMarkup.replace(/&nbsp;/g, '&#160;');

  // Both palettes ride along in the inlined stylesheet, and `:root` resolves to
  // the svg element itself in a standalone SVG. Which one applies is decided
  // here, in one of two ways.
  //
  // Pinned: `data-theme` names the palette. The attribute selector outranks the
  // bare `:root` block on specificity, and specificity is unaffected by media
  // queries, so a pinned theme beats the adaptive rule in both directions.
  //
  // Adaptive: no attribute, and an appended media query supplies the light
  // values when the viewer asks for light. `:not([data-theme])` keeps it off
  // any document that pinned a palette.
  //
  // Note `prefers-color-scheme: light` matches a viewer reporting *no*
  // preference as well as one asking for light — that is what the spec says,
  // not an accident here. So the split is: explicit dark stays dark, explicit
  // light and no-preference go light, and a renderer too old to know the
  // feature matches nothing and gets dark, exactly as every export did before
  // this existed. Anyone who needs a guarantee either way pins the theme.
  // Loud, not silent: an adaptive export that quietly lost its light palette
  // looks like a perfectly good dark-only SVG, and would sail past every check
  // that does not open it under a light preference.
  if (adaptive && !lightDeclarations) {
    throw new Error(
      `captureSvg: no declarations found for "${LIGHT_THEME_SELECTOR}" in render.html, ` +
      'so an adaptive SVG would silently export as dark-only.'
    );
  }
  const adaptiveRule = adaptive
    ? `\n@media (prefers-color-scheme: light){:root:not([data-theme]){${lightDeclarations}}}`
    : '';
  const themeAttr = adaptive ? '' : ` data-theme="${theme}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg"${themeAttr} viewBox="0 0 ${width} ${height}"><style>${exportStyles}${adaptiveRule}</style>${xmlSafeMarkup}</svg>`;
}

/**
 * Write the final PNG and SVG for each requested theme.
 *
 * Themes differ only in the stylesheet and the root attribute — the geometry is
 * identical — so every extra theme costs one screenshot and one serialisation,
 * not another layout pass. The primary theme keeps the plain `optimized.*`
 * names so existing callers are unaffected; extras are suffixed.
 *
 * The caller must leave the page showing the layout it wants captured.
 */
async function captureThemedOutputs({ page, width, height, outputDir, themes, adaptive = false, onLog }) {
  const [primary] = themes;
  await page.setViewportSize({
    width: Math.ceil(width) + 100,
    height: Math.ceil(height) + 100,
  });
  const svgElement = await page.$('#svg-root');

  const outputs = {};
  for (const theme of themes) {
    await applyTheme(page, theme);
    const suffix = theme === primary ? '' : `.${theme}`;
    const pngPath = path.join(outputDir, `optimized${suffix}.png`);
    await svgElement.screenshot({ path: pngPath });
    // Only the primary export adapts: an `optimized.light.svg` that could
    // render dark would defeat the point of asking for it by name.
    const svg = await captureSvg(page, width, height, {
      theme,
      adaptive: adaptive && theme === primary,
    });
    const svgPath = path.join(outputDir, `optimized${suffix}.svg`);
    fs.writeFileSync(svgPath, svg);
    outputs[theme] = { svg, svgPath, pngPath };
    onLog(`[Snapshot] Saved ${theme} theme to: ${pngPath}`);
  }

  if (themes.length > 1) await applyTheme(page, primary);
  return outputs;
}

/**
 * @param {object}   opts
 * @param {object}   opts.diagramModel
 * @param {string}   opts.outputDir       - absolute path for iteration PNGs and final outputs
 * @param {string}   [opts.apiUrl]
 * @param {number}   [opts.maxIterations]
 * @param {function} [opts.onLog]         - (msg: string) => void
 * @returns {Promise<{ success: boolean, history: object[], svgContent: string|null, pngPath: string|null }>}
 */
export async function optimizeDiagram({
  diagramModel,
  outputDir,
  apiUrl = process.env.NUDGE_LLM_API || 'http://127.0.0.1:1234',
  maxIterations = 4,
  onLog = (msg) => process.stderr.write(msg + '\n'),
  signal = null,
  checkpointTimeout = 30000,
  optimizationTimeout = 120000,
  enhance = false,
  theme = 'dark',
}) {
  const { themes, adaptive } = resolveThemes(theme);
  const primaryTheme = themes[0];

  fs.mkdirSync(outputDir, { recursive: true });

  normalizeDiagramModel(diagramModel);

  // Diagnostics recorded during normalization. Surface them to the caller's
  // log and thread them into the returned result.
  const notes = diagramModel._notes || [];
  for (const note of notes) onLog(`[Optimizer] ${note}`);

  // Annotation-note diagnostics use a dedicated `warnings` channel (distinct
  // from the centering `notes` above, which now means annotations elsewhere):
  // unresolved anchors (from the render pass) and notes that could not be
  // placed without overlap (from the auto-placement loop below).
  const warnings = [];
  const addWarnings = (list) => {
    for (const w of list || []) if (!warnings.includes(w)) warnings.push(w);
  };

  // Container connection lines default to the grid router (A* over the
  // orthogonal visibility graph, docs/nudge_next_generation_design.md §3).
  // NUDGE_ROUTER=legacy restores the old candidate router.
  if (process.env.NUDGE_ROUTER) {
    diagramModel._router = process.env.NUDGE_ROUTER;
    onLog(`[Optimizer] Connection-line router override: ${process.env.NUDGE_ROUTER} (NUDGE_ROUTER).`);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    page.on('console', msg => onLog(`[Browser] ${msg.type().toUpperCase()}: ${msg.text()}`));
    page.on('pageerror', err => onLog(`[Browser PageError]: ${err.message}`));

    const templateUrl = new URL('../render.html', import.meta.url).href;
    await page.goto(templateUrl);
    // Before any render: the intermediate step PNGs should be in the same
    // theme as the final output, not the default one.
    await applyTheme(page, primaryTheme);
    if (themes.length > 1) onLog(`[Optimizer] Rendering themes: ${themes.join(', ')}.`);

    if (signal?.aborted) {
      onLog('[Optimizer] Optimization cancelled prior to start.');
      return { success: false, history: [], svgContent: null, pngPath: null };
    }

    const hasBoundary = (diagramModel.nodes || []).some(n => n.type === 'boundary');
    if (hasBoundary) {
      let overrides = { ...(diagramModel._layoutOverrides || {}) };
      const visualHints = {};

      // One shared cost function (src/core/severity.js), not a private copy.
      const scoreContainerStep = (result) => {
        const report = analyzeLayout(result);
        return { report, score: scoreLayout(report) };
      };

      const renderContainerStep = async (stepName, overridesForStep = overrides) => {
        const result = await page.evaluate(async (data) => window.renderDiagram(data), {
          ...diagramModel,
          _layoutOverrides: overridesForStep
        });
        if (!result?.success) {
          onLog(`[Render] ${stepName} failed: ${result?.error || 'unknown render error'}`);
          return null;
        }
        await page.setViewportSize({
          width: Math.ceil(result.width) + 100,
          height: Math.ceil(result.height) + 100,
        });
        const screenshotPath = path.join(outputDir, `${stepName}.png`);
        const svgElement = await page.$('#svg-root');
        await svgElement.screenshot({ path: screenshotPath });
        onLog(`[Snapshot] Saved ${stepName} visual state to: ${screenshotPath}`);
        return { result, screenshotPath };
      };

      const renderAndMaybeAccept = async (stepName, candidateOverrides, currentStep, description) => {
        const candidateStep = await renderContainerStep(stepName, candidateOverrides);
        if (!candidateStep) return { accepted: false, step: null, overrides };

        const currentScore = scoreContainerStep(currentStep.result).score;
        const candidateScore = scoreContainerStep(candidateStep.result).score;
        if (candidateScore <= currentScore) {
          overrides = candidateOverrides;
          onLog(`[Visual Hint] Accepted ${description}: ${Math.round(currentScore * 10) / 10} -> ${Math.round(candidateScore * 10) / 10}`);
          return { accepted: true, step: candidateStep, overrides };
        }

        onLog(`[Visual Hint] Rejected ${description}: ${Math.round(currentScore * 10) / 10} -> ${Math.round(candidateScore * 10) / 10}`);
        return { accepted: false, step: currentStep, overrides };
      };

      onLog('[Visual Hint] Container diagram — running label placement optimizer...');

      const initialStep = await renderContainerStep('step_0_initial');
      if (!initialStep) return { success: false, history: [], svgContent: null, pngPath: null };
      let acceptedStep = initialStep;

      if (enhance && !signal?.aborted) {
        const labelResult = await getLLMLabelPlacementHints(apiUrl, diagramModel, initialStep.result, { signal, timeout: checkpointTimeout });
        if (labelResult) visualHints.labelPlacement = labelResult;
        const labelHints = {};
        for (const suggestion of labelResult?.suggestions || []) {
          if (suggestion.edgeId && suggestion.placement) {
            labelHints[suggestion.edgeId] = suggestion.placement;
          }
        }
        if (Object.keys(labelHints).length > 0) {
          const candidateOverrides = {
            ...overrides,
            labelHints: {
              ...(overrides.labelHints || {}),
              ...labelHints
            }
          };
          const accepted = await renderAndMaybeAccept('step_1_label_hints', candidateOverrides, acceptedStep, `label hints: ${Object.entries(labelHints).map(([id, val]) => `${id}->${val}`).join(', ')}`);
          acceptedStep = accepted.step || acceptedStep;
        } else {
          const labelHintsStep = await renderContainerStep('step_1_label_hints');
          if (!labelHintsStep) return { success: false, history: [], svgContent: null, pngPath: null };
          acceptedStep = labelHintsStep;
        }
      } else {
        const labelHintsStep = await renderContainerStep('step_1_label_hints');
        if (!labelHintsStep) return { success: false, history: [], svgContent: null, pngPath: null };
        acceptedStep = labelHintsStep;
      }

      if (!fs.existsSync(path.join(outputDir, 'step_1_label_hints.png'))) {
        const labelHintsStep = await renderContainerStep('step_1_label_hints');
        if (!labelHintsStep) return { success: false, history: [], svgContent: null, pngPath: null };
      }

      // ── Note auto-placement ────────────────────────────────────────────
      // Annotation notes are positioned post-layout (render_engine.js) from
      // the author's directional hint. When that hinted side occludes a
      // neighbour or a connection line, try alternative sides in preference
      // order — the author's hint is honoured first, so we only move a note if
      // its hinted side actually collides. Each candidate re-renders and is
      // accepted only if it does not worsen the overall geometry score (the
      // same accept-if-not-worse contract the label loop uses). A note with no
      // clean placement is left at its hint and reported via `warnings`.
      const annotationNotes = diagramModel.notes || [];
      if (annotationNotes.length > 0) {
        const overlappingNoteIds = (result) => {
          const found = new Set();
          for (const c of analyzeLayout(result).collisions) {
            if (c.type !== 'note_overlap' && c.type !== 'note_edge_crossing') continue;
            if (c.note) found.add(c.note);
            for (const el of c.elements || []) if (String(el).startsWith('note_')) found.add(el);
          }
          return found;
        };

        for (const note of annotationNotes) {
          // Floating notes are pinned to a canvas corner in the margin; the
          // anchor-relative side search does not apply to them.
          if (!(note.refs && note.refs.length)) continue;
          if (!overlappingNoteIds(acceptedStep.result).has(note.id)) continue;
          onLog(`[Notes] Note ${note.id} occluded at hinted placement '${note.position}' — searching for a clear side...`);

          // Snapshot so an unplaceable note can be restored to the author's
          // hint: the accept-if-not-worse rule accepts equal-score lateral
          // moves, so without this the note could drift to an arbitrary side.
          const overridesBeforeSearch = overrides;
          const stepBeforeSearch = acceptedStep;

          let resolved = false;
          let bestCandidate = null;

          for (const side of [note.position, 'right', 'left', 'over', 'below']) {
            // Skip the side already in effect (re-rendering it is a no-op).
            const effectiveSide = (overrides.notePlacements || {})[note.id] || note.position;
            if (side === effectiveSide) continue;

            const candidateOverrides = {
              ...overrides,
              notePlacements: { ...(overrides.notePlacements || {}), [note.id]: side }
            };
            const accepted = await renderAndMaybeAccept(
              `step_note_${note.id}_${side}`,
              candidateOverrides,
              acceptedStep,
              `note ${note.id} -> ${side}`
            );
            acceptedStep = accepted.step || acceptedStep;

            if (accepted.step && accepted.step.result) {
              const report = analyzeLayout(accepted.step.result);
              const noteOverlaps = report.collisions.filter(
                c => c.type === 'note_overlap' && (c.elements?.includes(note.id) || c.note === note.id)
              ).length;
              const isClean = !overlappingNoteIds(accepted.step.result).has(note.id);

              if (
                !bestCandidate ||
                noteOverlaps < bestCandidate.noteOverlaps ||
                (noteOverlaps === bestCandidate.noteOverlaps && accepted.score < bestCandidate.score)
              ) {
                bestCandidate = {
                  step: accepted.step,
                  overrides: candidateOverrides,
                  side,
                  noteOverlaps,
                  score: accepted.score,
                  isClean
                };
              }

              if (accepted.accepted && isClean) {
                resolved = true;
                break;
              }
            }
          }

          if (!resolved) {
            // Check if initial hinted placement had an element overlap
            const initialReport = analyzeLayout(stepBeforeSearch.result);
            const initialNoteOverlaps = initialReport.collisions.filter(
              c => c.type === 'note_overlap' && (c.elements?.includes(note.id) || c.note === note.id)
            ).length;

            if (bestCandidate && bestCandidate.noteOverlaps < initialNoteOverlaps) {
              overrides = bestCandidate.overrides;
              acceptedStep = bestCandidate.step;
              warnings.push(`Note ${note.id} could not be placed completely clear; relocated from '${note.position}' to '${bestCandidate.side}' to avoid element overlap.`);
            } else {
              // No side cleared or improved the note: leave it at the author's hint and warn.
              overrides = overridesBeforeSearch;
              acceptedStep = stepBeforeSearch;
              warnings.push(`Note ${note.id} could not be placed without overlap; left at author's hint ('${note.position}').`);
            }
          }
        }
      }

      const finalStep = acceptedStep;
      // Unresolved-anchor warnings are produced by the render pass itself.
      addWarnings(finalStep.result.warnings);

      diagramModel._layoutOverrides = overrides;
      if (Object.keys(visualHints).length > 0) {
        fs.writeFileSync(path.join(outputDir, 'visual_hints.json'), JSON.stringify(visualHints, null, 2));
      }

      onLog('[Critique] Running geometric collision analysis...');
      const report = analyzeLayout(finalStep.result);
      onLog(`[Critique] Aspect Ratio: ${report.aspectRatio}`);
      onLog(`[Critique] Collisions: ${report.collisions.length} (${report.overlapCount} overlaps, ${report.intersectionCount} edge crossings)`);

      // Re-render the accepted overrides before capturing.
      //
      // The note-placement search above restores `overrides` and `acceptedStep`
      // when no side clears a note, but it never re-renders — so the DOM can
      // still hold the last *rejected* candidate. The PNG was copied from the
      // accepted step's file and was therefore right, while the SVG is read
      // live and would show the rejected layout: two outputs of one run
      // disagreeing. Re-rendering makes them agree by construction, and gives
      // the theme capture below a page that is definitely the final layout.
      await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);

      const themeOutputs = await captureThemedOutputs({
        page,
        width: finalStep.result.width,
        height: finalStep.result.height,
        outputDir,
        themes,
        adaptive,
        onLog,
      });
      const svg = themeOutputs[primaryTheme].svg;
      const finalPngPath = themeOutputs[primaryTheme].pngPath;

      const history = [{
        iteration: 1,
        options: { ...diagramModel.layoutOptions },
        ...defectVector(report),
        screenshot: finalStep.screenshotPath,
      }];

      for (const w of warnings) onLog(`[Notes] ${w}`);

      // The container/context gate used to check 2 of 6 defect classes, so the
      // primary product had a weaker gate than the little-used flat/ELK path.
      // Connection-Label Element Crossing now gates: it is 0 across the whole
      // corpus, so the class is clean and the gate can hold it there. The three
      // remaining classes are held by the ratchet in test/quality_baseline.js
      // rather than an absolute gate — the corpus legitimately carries them,
      // and a gate nothing can satisfy is a gate that gets switched off.
      const labelElementCrossings = report.labelElementCrossingCount || 0;
      if (labelElementCrossings > 0) {
        onLog(`[Critique] ${labelElementCrossings} Connection-Label Element Crossing(s) — labels buried in elements.`);
      }
      const success = isClean(report);
      return { success, history, svgContent: svg, pngPath: finalPngPath, themes: themeOutputs, notes, warnings };
    }

    let currentOptions = { ...diagramModel.layoutOptions };
    const history = [];
    let svgContent = null;
    let pngPath = null;
    let themeOutputs = null;
    let success = false;
    let lastRenderResult = null;

    if (!enhance) {
      onLog('[Optimizer] LLM is disabled (deterministic-only mode). Running canned ELKjs configuration search...');
      const cannedConfigs = [
        { ...currentOptions },
        {
          ...currentOptions,
          "elk.spacing.nodeNode": "160",
          "elk.layered.spacing.nodeNodeBetweenLayers": "130",
          "elk.spacing.edgeNode": "90",
          "elk.spacing.edgeEdge": "25"
        },
        {
          ...currentOptions,
          "elk.spacing.nodeNode": "200",
          "elk.layered.spacing.nodeNodeBetweenLayers": "160",
          "elk.spacing.edgeNode": "100",
          "elk.spacing.edgeEdge": "30"
        },
        {
          ...currentOptions,
          "elk.spacing.nodeNode": "120",
          "elk.layered.spacing.nodeNodeBetweenLayers": "100",
          "elk.spacing.edgeNode": "70",
          "elk.spacing.edgeEdge": "15"
        }
      ];

      let bestScore = Infinity;
      let bestOptions = null;
      let bestRenderResult = null;
      let bestReport = null;

      for (let i = 0; i < cannedConfigs.length; i++) {
        if (signal?.aborted) {
          onLog('[Optimizer] Optimization cancelled during canned config search.');
          break;
        }
        const config = cannedConfigs[i];
        diagramModel.layoutOptions = { ...config };

        onLog(`[Optimizer] Trying canned config ${i + 1}/${cannedConfigs.length}: nodeNode=${config["elk.spacing.nodeNode"] || 'unset'}, layerSpacing=${config["elk.layered.spacing.nodeNodeBetweenLayers"] || 'unset'}...`);
        const result = await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);
        if (!result.success) {
          onLog(`[Render] Canned config ${i + 1} failed: ${result.error}`);
          continue;
        }

        const report = analyzeLayout(result);
        // Same shared cost function as the container path. This copy previously
        // omitted both label classes entirely, so the configuration search was
        // blind to the defects the container scorer cared most about.
        const score = scoreLayout(report);

        onLog(`[Optimizer] Config ${i + 1} score: ${Math.round(score * 10) / 10} (overlaps: ${report.overlapCount}, crossings: ${report.intersectionCount}, tight spacing: ${report.collisions.filter(c => c.type === 'tight_spacing').length})`);

        if (score < bestScore) {
          bestScore = score;
          bestOptions = config;
          bestRenderResult = result;
          bestReport = report;
        }
      }

      if (bestRenderResult) {
        onLog(`[Optimizer] Selected best config with score ${bestScore}.`);
        addWarnings(bestRenderResult.warnings);
        diagramModel.layoutOptions = { ...bestOptions };

        // The search left the *last* config in the DOM, which is not
        // necessarily the best-scoring one; re-render the winner before capture.
        await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);

        themeOutputs = await captureThemedOutputs({
          page,
          width: bestRenderResult.width,
          height: bestRenderResult.height,
          outputDir,
          themes,
          adaptive,
          onLog,
        });
        svgContent = themeOutputs[primaryTheme].svg;
        pngPath = themeOutputs[primaryTheme].pngPath;
        const screenshotPath = pngPath;

        history.push({
          iteration: 1,
          options: { ...bestOptions },
          ...defectVector(bestReport),
          screenshot: screenshotPath,
        });

        const hardCollisions = bestReport.collisions.filter(c =>
          c.type === 'node_overlap' ||
          c.type === 'edge_node_crossing' ||
          c.type === 'edge_label_node_crossing'
        );
        success = (hardCollisions.length === 0);
      }
    } else {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (signal?.aborted) {
          onLog(`[Optimizer] Optimization cancelled at iteration ${iteration}.`);
          break;
        }

        onLog(`\n--- Iteration ${iteration}/${maxIterations} ---`);
        diagramModel.layoutOptions = { ...currentOptions };

        onLog('[Render] Running layout calculations with ELKjs...');
        const result = await page.evaluate(async (data) => window.renderDiagram(data), diagramModel);

        if (!result.success) {
          onLog(`[Render] Rendering failed: ${result.error}`);
          break;
        }
        lastRenderResult = result;
        addWarnings(result.warnings);

        onLog(`[Render] Viewport bounds computed: ${result.width}x${result.height}`);

        await page.setViewportSize({
          width: Math.ceil(result.width) + 100,
          height: Math.ceil(result.height) + 100,
        });

        const screenshotPath = path.join(outputDir, `iteration_${iteration}.png`);
        const svgElement = await page.$('#svg-root');
        await svgElement.screenshot({ path: screenshotPath });
        onLog(`[Snapshot] Saved visual state to: ${screenshotPath}`);

        onLog('[Critique] Running geometric collision analysis...');
        const report = analyzeLayout(result);
        onLog(`[Critique] Aspect Ratio: ${report.aspectRatio}`);
        onLog(`[Critique] Collisions: ${report.collisions.length} (${report.overlapCount} overlaps, ${report.intersectionCount} edge crossings)`);

        history.push({
          iteration,
          options: { ...currentOptions },
          ...defectVector(report),
          screenshot: screenshotPath,
        });

        const hardCollisions = report.collisions.filter(c =>
          c.type === 'node_overlap' ||
          c.type === 'edge_node_crossing' ||
          c.type === 'edge_label_node_crossing'
        );

        if (!success && hardCollisions.length === 0) {
          onLog('[Critique] No node overlaps or edge crossings detected. Layout is visually clean.');
          // The page still shows this iteration, so it needs no re-render.
          themeOutputs = await captureThemedOutputs({
            page,
            width: result.width,
            height: result.height,
            outputDir,
            themes,
            adaptive,
            onLog,
          });
          svgContent = themeOutputs[primaryTheme].svg;
          pngPath = themeOutputs[primaryTheme].pngPath;
          success = true;
        }

        if (report.collisions.length > 0) {
          report.collisions.forEach((c, i) => onLog(`  ${i + 1}. [${c.type}] ${c.details}`));
        } else {
          onLog('[Critique] Visual layout is pristine! Zero collisions or warnings detected.');
          break;
        }

        if (iteration === maxIterations) {
          onLog('[Optimization] Maximum iterations reached.');
          break;
        }

        if (signal?.aborted) {
          onLog(`[Optimizer] Optimization cancelled before LLM optimization call at iteration ${iteration}.`);
          break;
        }

        onLog('[Optimization] Requesting layout parameter patch from AI...');
        const patch = await getLLMOptimizationPatch(apiUrl, currentOptions, report, { signal, timeout: optimizationTimeout });

        if (signal?.aborted) {
          onLog(`[Optimizer] Optimization cancelled after LLM optimization call at iteration ${iteration}.`);
          break;
        }

        if (!patch || Object.keys(patch).length === 0) {
          onLog('[Optimization] AI did not suggest any changes. Retaining parameters.');
          break;
        } else {
          onLog(`[Optimization] AI suggested patch: ${JSON.stringify(patch, null, 2)}`);
          for (const [key, val] of Object.entries(patch)) currentOptions[key] = String(val);
          fs.writeFileSync(path.join(outputDir, 'layout.cache.json'), JSON.stringify(currentOptions, null, 2));
        }
      }

      // Best-effort export when no iteration came out clean: the page still
      // holds the last one rendered, which is what `lastRenderResult` describes.
      if (!success && lastRenderResult) {
        themeOutputs = await captureThemedOutputs({
          page,
          width: lastRenderResult.width,
          height: lastRenderResult.height,
          outputDir,
          themes,
          adaptive,
          onLog,
        });
        svgContent = themeOutputs[primaryTheme].svg;
        pngPath = themeOutputs[primaryTheme].pngPath;
      }
    }

    for (const w of warnings) onLog(`[Notes] ${w}`);

    return { success, history, svgContent, pngPath, themes: themeOutputs, notes, warnings };
  } finally {
    await browser.close();
  }
}
