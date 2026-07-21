// The public API — the semver surface.
//
// Until this existed the only way to use Nudge was to shell out to the CLI and
// scrape stdout, which meant nothing could be built on it: no editor extension,
// no CI action, no programmatic use at all (docs/IMPROVEMENT_PLAN.md INC-17).
//
// Everything else in `src/` is internal and may change in any release. Only the
// exports in this file carry a compatibility promise. Layout *output* is
// explicitly not covered — see the semver policy in CHANGELOG.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { parseMermaidC4 } from './mermaid_parser.js';
import { parsePlantUMLC4 } from './plantuml_parser.js';
import { optimizeDiagram, defectVector } from './core/optimizer.js';

/** Formats `parseDiagram` accepts. */
export const FORMATS = ['mermaid', 'plantuml', 'yaml'];

/**
 * Detect a diagram source's format. Exported because callers reading from
 * stdin or an editor buffer have no filename to go on.
 *
 * @param {string} source
 * @returns {'mermaid'|'plantuml'|'yaml'}
 */
export function detectFormat(source) {
  if (/^\s*@startuml/m.test(source)) return 'plantuml';
  if (/^\s*C4(Context|Container|Component|Dynamic|Deployment)\b/m.test(source)) return 'mermaid';
  return 'yaml';
}

/**
 * Parse diagram source into the internal diagram model.
 *
 * @param {string} source
 * @param {{ format?: 'mermaid'|'plantuml'|'yaml' }} [options]
 * @returns {object} the diagram model
 */
export function parseDiagram(source, { format } = {}) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new TypeError('parseDiagram: `source` must be a non-empty string.');
  }
  const resolved = format || detectFormat(source);
  if (!FORMATS.includes(resolved)) {
    throw new TypeError(`parseDiagram: unknown format ${JSON.stringify(resolved)}. Expected one of ${FORMATS.join(', ')}.`);
  }

  const model =
    resolved === 'mermaid' ? parseMermaidC4(source)
    : resolved === 'plantuml' ? parsePlantUMLC4(source)
    : yaml.load(source);

  if (!model || typeof model !== 'object') {
    throw new Error('parseDiagram: source parsed to an empty or invalid structure.');
  }
  if (!Array.isArray(model.nodes)) throw new Error("parseDiagram: model is missing a 'nodes' array.");
  if (!Array.isArray(model.edges)) throw new Error("parseDiagram: model is missing an 'edges' array.");
  return model;
}

/**
 * Render a C4 diagram to SVG.
 *
 * The one narrow, stable entry point. Deterministic by default: no network
 * calls, no LLM, same input → same output.
 *
 * @param {object} options
 * @param {string} options.source           Diagram source text.
 * @param {'mermaid'|'plantuml'|'yaml'} [options.format]  Auto-detected if omitted.
 * @param {boolean} [options.enhance=false] Opt in to the LLM polish pass. Requires network.
 * @param {string}  [options.outputDir]     Where PNG/SVG artefacts are written. Defaults to a temp dir.
 * @param {AbortSignal} [options.signal]    Cancels all in-flight work.
 * @param {(message: string) => void} [options.onLog]  Defaults to discarding logs.
 * @returns {Promise<{ svg: string|null, png: string|null, success: boolean, report: object }>}
 *   `report` is the defect vector: all six defect classes plus route shape.
 */
export async function renderDiagram({
  source,
  format,
  enhance = false,
  outputDir,
  signal,
  onLog = () => {},
} = {}) {
  const model = parseDiagram(source, { format });

  // A library must not scribble into the caller's working directory, which is
  // what the CLI's ./.nudge default would do.
  const dir = outputDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-'));
  fs.mkdirSync(dir, { recursive: true });

  const { success, history, svgContent, pngPath, notes = [], warnings = [] } = await optimizeDiagram({
    diagramModel: model,
    outputDir: dir,
    onLog,
    signal,
    enhance,
  });

  const final = history.at(-1) || {};
  return {
    svg: svgContent ?? null,
    png: pngPath ?? null,
    success,
    title: model.title ?? null,
    report: {
      elementOverlaps: final.overlaps ?? 0,
      lineElementCrossings: final.crossings ?? 0,
      labelElementCrossings: final.labelElementCrossings ?? 0,
      lineOverlaps: final.lineOverlaps ?? 0,
      lineCrossings: final.lineCrossings ?? 0,
      labelLineIntersections: final.labelLineIntersections ?? 0,
      labelLabelOverlaps: final.labelLabelOverlaps ?? 0,
      bends: final.bends ?? 0,
      routeLength: final.routeLength ?? 0,
      aspectRatio: final.aspectRatio ?? null,
    },
    notes,
    warnings,
  };
}

export { defectVector };
