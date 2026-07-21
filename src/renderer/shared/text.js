// Loaded both as a classic script in render.html and via side-effect import
// under `node --test`, hence the globalThis-safe namespace. Now that measurement
// no longer touches a canvas, this module is pure and testable in milliseconds
// without Playwright (docs/IMPROVEMENT_PLAN.md INC-9).
globalThis.NudgeRenderer = globalThis.NudgeRenderer || {};

globalThis.NudgeRenderer.sharedText = (() => {
  // Text width from baked Outfit glyph metrics — no canvas, no webfont fetch.
  //
  // This used to call canvas `measureText`, which was the single reason the
  // whole layout pipeline needed a browser (docs/IMPROVEMENT_PLAN.md INC-9,
  // Appendix C). It also measured whatever font had arrived over the network so
  // far, so the first render disagreed with every later one.
  //
  // Glyph advances are exact integers in font units; summing them with kern
  // deltas and scaling by fontSize/unitsPerEm reproduces the browser's own
  // number to well under a pixel. `scripts/generate_font_metrics.js` builds the
  // table into src/vendor/outfit_metrics.js at install time.
  function measureTextWidth(text, fontSize, isBold = false) {
    const metrics = globalThis.NudgeOutfitMetrics;
    if (!metrics) {
      throw new Error(
        'Outfit metrics table missing. Run: node scripts/generate_font_metrics.js'
      );
    }
    const face = metrics.weights[isBold ? 700 : 400];
    const { advances, kern, fallback } = face;

    let units = 0;
    let prev = null;
    // Iterate by code point, not by UTF-16 unit, so astral characters count once.
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      units += advances[cp] ?? fallback;
      if (prev !== null) units += kern[`${prev},${cp}`] || 0;
      prev = cp;
    }

    let w = units * fontSize / metrics.unitsPerEm;
    if (isBold) {
      w += text.length * fontSize * 0.025; // Account for letter-spacing: 0.025em
    }
    return Math.ceil(w);
  }

  const MAX_LABEL_WIDTH = 120;
  const LINE_HEIGHT = 13;
  const BOUNDARY_H_PAD = 80;

  function wrapText(text, maxWidth, fontSize) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (measureTextWidth(test, fontSize) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  // `maxWidth` is a parameter so placement can re-wrap a label *narrower* when a
  // corridor has no room for it at the default width — a narrower, taller box
  // fits where a wide one cannot. This is the adaptive-re-wrap half of the
  // UNSATISFIABLE fallback (docs/IMPROVEMENT_PLAN.md INC-16).
  function createConnectionLabel(labelText, maxWidth = MAX_LABEL_WIDTH) {
    const match = labelText.match(/^(.*?)\s*\[(.*?)\]$/);
    if (match) {
      const mainLines = wrapText(match[1].trim(), maxWidth, 11);
      const techW = measureTextWidth(`[${match[2].trim()}]`, 11);
      const w = Math.max(...mainLines.map(l => measureTextWidth(l, 11)), techW);
      return { text: labelText, width: w, height: (mainLines.length + 1) * LINE_HEIGHT + 2 };
    }
    const lines = wrapText(labelText, maxWidth, 11);
    return { text: labelText, width: Math.max(...lines.map(l => measureTextWidth(l, 11))), height: lines.length * LINE_HEIGHT + 2 };
  }

  return {
    measureTextWidth,
    wrapText,
    createConnectionLabel,
    MAX_LABEL_WIDTH,
    LINE_HEIGHT,
    BOUNDARY_H_PAD
  };
})();
