function normalizeText(text) {
  return String(text).replace(/\r\n?/g, "\n").trim();
}

function defaultMeasure(text, fontSize) {
  return [...text].length * fontSize;
}

const DEFAULT_VERTICAL_LETTER_SPACING = 0.06;

export function layoutHorizontalText({
  text,
  fontSize,
  width,
  height,
  padding = 0,
  lineHeight = 1.35,
  measure = defaultMeasure,
}) {
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  const lines = [];

  for (const paragraph of normalizeText(text).split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const character of paragraph) {
      const candidate = current + character;
      if (current && measure(candidate, fontSize) > innerWidth) {
        lines.push(current);
        current = character;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }

  const lineHeightPx = fontSize * lineHeight;
  const contentHeight = lines.length * lineHeightPx;
  const contentWidth = lines.reduce((maximum, line) => Math.max(maximum, measure(line, fontSize)), 0);
  return {
    lines,
    lineHeightPx,
    contentWidth,
    contentHeight,
    overflow: contentWidth > innerWidth + 0.01 || contentHeight > innerHeight + 0.01,
  };
}

export function layoutVerticalText({
  text,
  fontSize,
  width,
  height,
  padding = 0,
  lineHeight = 1.35,
  letterSpacing = DEFAULT_VERTICAL_LETTER_SPACING,
}) {
  const innerWidth = Math.max(0, width - padding * 2);
  const innerHeight = Math.max(0, height - padding * 2);
  const characterStep = fontSize * (1 + letterSpacing);
  const columnStep = fontSize * lineHeight;
  const charactersPerColumn = Math.max(1, Math.floor(innerHeight / characterStep));
  const columns = [];
  for (const explicitColumn of normalizeText(text).split("\n")) {
    const characters = [...explicitColumn];
    for (let index = 0; index < characters.length; index += charactersPerColumn) {
      columns.push(characters.slice(index, index + charactersPerColumn).join(""));
    }
  }
  const longestColumn = columns.reduce((maximum, column) => Math.max(maximum, [...column].length), 0);
  const contentWidth = columns.length * columnStep;
  const contentHeight = longestColumn * characterStep;
  return {
    columns,
    charactersPerColumn,
    characterStep,
    columnStep,
    contentWidth,
    contentHeight,
    overflow: contentWidth > innerWidth + 0.01 || contentHeight > innerHeight + 0.01,
  };
}

export function layoutText(options) {
  const result = options.direction === "vertical"
    ? layoutVerticalText(options)
    : layoutHorizontalText(options);
  const warning = options.direction === "vertical" && /[A-Za-z0-9_]/.test(options.text)
    ? "ASCII technical text should use horizontal layout"
    : null;
  return { ...result, fontSize: options.fontSize, warning };
}

export function fitText(options) {
  const minimum = Math.max(1, Math.floor(options.minFontSize));
  const starting = Math.max(minimum, Math.floor(options.fontSize));
  let result;
  let size = starting;
  for (; size >= minimum; size -= 1) {
    result = layoutText({ ...options, fontSize: size });
    if (!result.overflow) break;
  }
  if (size < minimum) size = minimum;
  const finalResult = result ?? layoutText({ ...options, fontSize: size });
  return { ...finalResult, fontSize: size };
}
