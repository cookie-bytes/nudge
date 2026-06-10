window.NudgeRenderer.sharedText = (() => {
  // Rough text width estimation to supply ELKjs for label spacing
  function measureTextWidth(text, fontSize, isBold = false) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const weight = isBold ? "bold" : "normal";
    ctx.font = `${weight} ${fontSize}px Outfit, sans-serif`;
    let w = ctx.measureText(text).width;
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

  function createConnectionLabel(labelText) {
    const match = labelText.match(/^(.*?)\s*\[(.*?)\]$/);
    if (match) {
      const mainLines = wrapText(match[1].trim(), MAX_LABEL_WIDTH, 11);
      const techW = measureTextWidth(`[${match[2].trim()}]`, 11);
      const w = Math.max(...mainLines.map(l => measureTextWidth(l, 11)), techW);
      return { text: labelText, width: w, height: (mainLines.length + 1) * LINE_HEIGHT + 2 };
    }
    const lines = wrapText(labelText, MAX_LABEL_WIDTH, 11);
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
