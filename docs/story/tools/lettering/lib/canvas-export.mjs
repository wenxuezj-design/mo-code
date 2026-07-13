import { layoutText } from "./text-fit.mjs";

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
  ctx.fillStyle = "#101010";

  for (const item of layout.items) {
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

export async function renderPageBlob({ image, layout, format, quality = 0.92 }) {
  const canvas = document.createElement("canvas");
  canvas.width = layout.source.width;
  canvas.height = layout.source.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawLettering(ctx, layout);

  const mimeType = format === "png" ? "image/png" : "image/webp";
  return canvasBlob(canvas, mimeType, quality);
}
