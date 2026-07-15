import { layoutText } from "./text-fit.mjs";

const INK = "#101010";
const PAPER = "#ffffff";
const LABEL_BACKGROUND = "#e8e8e8";
const TONE_LIGHT = "#f1f1f1";
const TONE_DOTS = "#fafafa";
const TONE_LINES = "#f8f8f8";
const TONE_DARK = "#d4d4d4";

const VERTICAL_GLYPHS = new Map([
  ["，", "︐"],
  ["、", "︑"],
  ["。", "︒"],
  ["：", "︓"],
  ["；", "︔"],
  ["！", "︕"],
  ["？", "︖"],
]);

export function verticalGlyph(character) {
  return VERTICAL_GLYPHS.get(character) ?? character;
}

function isVerticalDash(character) {
  return character === "—" || character === "―";
}

function drawVerticalDashRun(ctx, x, startY, rowIndex, runLength, item, fitted) {
  const firstCellTop = startY + rowIndex * fitted.characterStep;
  const lastCellTop = startY + (rowIndex + runLength - 1) * fitted.characterStep;
  const inset = item.fontSize * 0.12;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = Math.max(1.5, item.fontSize * 0.08);
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(x, firstCellTop + inset);
  ctx.lineTo(x, lastCellTop + item.fontSize - inset);
  ctx.stroke();
  ctx.restore();
}

function canvasBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(`Unable to encode ${mimeType}`)), mimeType, quality);
  });
}

function isPortraitItem(item) {
  return item?.type === "portrait";
}

function textColor(item) {
  return item.appearance === "code" || item.appearance === "inverted" ? PAPER : INK;
}

function roundedPath(ctx, item, radius) {
  ctx.beginPath();
  ctx.roundRect(item.x, item.y, item.width, item.height, radius);
}

function appearanceStyle(item) {
  const shortSide = Math.min(item.width, item.height);
  switch (item.appearance) {
    case "dialogue":
      return { fill: PAPER, stroke: INK, radius: shortSide * 0.28 };
    case "card":
      return { fill: PAPER, stroke: INK, radius: Math.min(10, shortSide * 0.1) };
    case "code":
    case "inverted":
      return { fill: INK, stroke: null, radius: Math.min(10, shortSide * 0.1) };
    case "label":
      return { fill: LABEL_BACKGROUND, stroke: null, radius: Math.min(8, shortSide * 0.08) };
    case "tone-light":
      return { fill: TONE_LIGHT, stroke: INK, radius: Math.min(10, shortSide * 0.1), pattern: null };
    case "tone-dots":
      return { fill: TONE_DOTS, stroke: INK, radius: Math.min(10, shortSide * 0.1), pattern: "dots" };
    case "tone-lines":
      return { fill: TONE_LINES, stroke: INK, radius: Math.min(10, shortSide * 0.1), pattern: "lines" };
    case "tone-dark":
      return { fill: TONE_DARK, stroke: INK, radius: Math.min(10, shortSide * 0.1), pattern: null };
    default:
      return null;
  }
}

function drawTonePattern(ctx, item, style) {
  if (style.pattern === null || style.pattern === undefined) return;
  ctx.save();
  roundedPath(ctx, item, style.radius);
  ctx.clip();
  if (style.pattern === "dots") {
    ctx.fillStyle = "#b8b8b8";
    let row = 0;
    for (let y = item.y + 6; y < item.y + item.height; y += 12) {
      const offset = row % 2 === 0 ? 0 : 6;
      for (let x = item.x + 6 + offset; x < item.x + item.width; x += 12) {
        ctx.fillRect(x, y, 2, 2);
      }
      row += 1;
    }
  } else if (style.pattern === "lines") {
    ctx.strokeStyle = "#c6c6c6";
    ctx.lineWidth = 1;
    for (let x = item.x - item.height; x < item.x + item.width; x += 14) {
      ctx.beginPath();
      ctx.moveTo(x, item.y + item.height);
      ctx.lineTo(x + item.height, item.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawAppearance(ctx, item) {
  const style = appearanceStyle(item);
  if (style === null) return;
  ctx.save();
  roundedPath(ctx, item, style.radius);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.restore();
  drawTonePattern(ctx, item, style);
  if (style.stroke !== null) {
    ctx.save();
    roundedPath(ctx, item, style.radius);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function portraitPath(ctx, item) {
  ctx.beginPath();
  if (item.shape === "circle") {
    ctx.arc(
      item.x + item.width / 2,
      item.y + item.height / 2,
      Math.min(item.width, item.height) / 2,
      0,
      Math.PI * 2,
    );
    return;
  }
  ctx.roundRect(
    item.x,
    item.y,
    item.width,
    item.height,
    Math.min(24, Math.min(item.width, item.height) * 0.14),
  );
}

function portraitData(portraits, portraitId) {
  const portrait = portraits instanceof Map
    ? portraits.get(portraitId)
    : portraits !== null && typeof portraits === "object" && Object.hasOwn(portraits, portraitId)
      ? portraits[portraitId]
      : undefined;
  if (portrait === undefined) throw new Error(`Unknown portrait ID: ${portraitId}`);
  return portrait;
}

function drawPortrait(ctx, item, portraits) {
  const { image, crop } = portraitData(portraits, item.portraitId);
  ctx.save();
  portraitPath(ctx, item);
  ctx.clip();
  ctx.filter = item.grayscale ? "grayscale(1)" : "none";
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    item.x,
    item.y,
    item.width,
    item.height,
  );
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  portraitPath(ctx, item);
  ctx.stroke();
  ctx.restore();
}

function drawHorizontal(ctx, item, fitted) {
  const innerHeight = item.height - item.padding * 2;
  const textHeight = fitted.lines.length * fitted.lineHeightPx;
  const startY = item.y + item.padding + (innerHeight - textHeight) / 2 + fitted.lineHeightPx / 2;
  const x = item.align === "left"
    ? item.x + item.padding
    : item.align === "right"
      ? item.x + item.width - item.padding
      : item.x + item.width / 2;
  ctx.textAlign = item.align;
  ctx.textBaseline = "middle";
  fitted.lines.forEach((line, index) => ctx.fillText(line, x, startY + index * fitted.lineHeightPx));
}

function drawVertical(ctx, item, fitted) {
  const innerWidth = item.width - item.padding * 2;
  const startX = item.x + item.padding + (innerWidth + fitted.contentWidth) / 2 - fitted.columnStep / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  fitted.columns.forEach((column, columnIndex) => {
    const x = startX - columnIndex * fitted.columnStep;
    const characters = [...column];
    const columnHeight = characters.length * fitted.characterStep;
    const startY = item.y + item.padding + (item.height - item.padding * 2 - columnHeight) / 2;
    for (let rowIndex = 0; rowIndex < characters.length;) {
      const character = characters[rowIndex];
      if (isVerticalDash(character)) {
        let runLength = 1;
        while (rowIndex + runLength < characters.length && isVerticalDash(characters[rowIndex + runLength])) {
          runLength += 1;
        }
        drawVerticalDashRun(ctx, x, startY, rowIndex, runLength, item, fitted);
        rowIndex += runLength;
        continue;
      }
      const y = startY + rowIndex * fitted.characterStep;
      ctx.fillText(verticalGlyph(character), x, y);
      rowIndex += 1;
    }
  });
}

export function drawLettering(ctx, layout) {
  ctx.fillStyle = INK;

  for (const item of layout.items) {
    if (isPortraitItem(item)) continue;
    ctx.fillStyle = textColor(item);
    ctx.font = `${item.fontWeight} ${item.fontSize}px "${item.fontFamily}", sans-serif`;
    const fitted = layoutText({
      ...item,
      measure: (text, fontSize) => {
        ctx.font = `${item.fontWeight} ${fontSize}px "${item.fontFamily}", sans-serif`;
        return ctx.measureText(text).width;
      },
    });
    ctx.font = `${item.fontWeight} ${item.fontSize}px "${item.fontFamily}", sans-serif`;
    if (item.direction === "vertical") drawVertical(ctx, item, fitted);
    else drawHorizontal(ctx, item, fitted);
  }
}

export function drawPage(ctx, { image, layout, portraits = {} }) {
  if (layout.source.kind === "generated") {
    ctx.fillStyle = layout.source.background;
    ctx.fillRect(0, 0, layout.source.width, layout.source.height);
  } else {
    ctx.drawImage(image, 0, 0, layout.source.width, layout.source.height);
  }

  for (const item of layout.items) {
    if (isPortraitItem(item)) drawPortrait(ctx, item, portraits);
  }
  for (const item of layout.items) {
    if (!isPortraitItem(item)) drawAppearance(ctx, item);
  }
  drawLettering(ctx, layout);
}

export async function renderPageBlob({ image, layout, portraits = {}, format, quality = 0.92 }) {
  const canvas = document.createElement("canvas");
  canvas.width = layout.source.width;
  canvas.height = layout.source.height;
  const ctx = canvas.getContext("2d");
  drawPage(ctx, { image, layout, portraits });

  const mimeType = format === "png" ? "image/png" : "image/webp";
  return canvasBlob(canvas, mimeType, quality);
}
