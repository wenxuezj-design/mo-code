const DIRECTIONS = new Set(["horizontal", "vertical"]);
const TEXT_TYPES = new Set(["speech", "narration", "technical"]);
const APPEARANCES = new Set([
  "plain", "dialogue", "card", "code", "title", "inverted", "label",
  "tone-light", "tone-dots", "tone-lines", "tone-dark",
]);
const PORTRAIT_SHAPES = new Set(["circle", "rounded"]);
const ALIGNS = new Set(["left", "center", "right"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTextItem(item) {
  return isObject(item) && TEXT_TYPES.has(item.type);
}

export function isPortraitItem(item) {
  return isObject(item) && item.type === "portrait";
}

export function isGeneratedSource(source) {
  return isObject(source) && source.kind === "generated";
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label, { nonEmpty = true } = {}) {
  if (typeof value !== "string" || (nonEmpty && value.trim().length === 0)) {
    throw new Error(`${label} must be ${nonEmpty ? "non-empty" : "a string"}`);
  }
  return value;
}

function requireNumber(value, label, { min = -Infinity } = {}) {
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${label} must be a finite number >= ${min}`);
  }
  return value;
}

function requireInteger(value, label, options) {
  requireNumber(value, label, options);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function requireItemRegion(item, id) {
  return {
    x: requireNumber(item.x, `${id}.x`, { min: 0 }),
    y: requireNumber(item.y, `${id}.y`, { min: 0 }),
    width: requireNumber(item.width, `${id}.width`, { min: 1 }),
    height: requireNumber(item.height, `${id}.height`, { min: 1 }),
  };
}

export function validatePageLayout(value) {
  const input = requireObject(value, "layout");
  if (input.version !== 1) throw new Error("layout.version must be 1");
  requireString(input.chapter, "layout.chapter");
  requireString(input.page, "layout.page");

  const source = requireObject(input.source, "layout.source");
  if (source.kind !== undefined && !isGeneratedSource(source)) {
    throw new Error("layout.source.kind is invalid");
  }
  if (isGeneratedSource(source)) {
    requireString(source.background, "layout.source.background");
    if (!/^#[0-9a-fA-F]{6}$/.test(source.background)) {
      throw new Error("layout.source.background must be a six-digit hex color");
    }
  } else {
    requireString(source.file, "layout.source.file");
  }
  const sourceWidth = requireInteger(source.width, "layout.source.width", { min: 1 });
  const sourceHeight = requireInteger(source.height, "layout.source.height", { min: 1 });
  if (!Array.isArray(input.items)) throw new Error("layout.items must be an array");

  const ids = new Set();
  for (const [index, rawItem] of input.items.entries()) {
    const item = requireObject(rawItem, `layout.items[${index}]`);
    const id = requireString(item.id, `layout.items[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate item id: ${id}`);
    ids.add(id);
    let region;
    if (isPortraitItem(item)) {
      requireString(item.portraitId, `${id}.portraitId`);
      region = requireItemRegion(item, id);
      if (!PORTRAIT_SHAPES.has(item.shape)) throw new Error(`${id}.shape is invalid`);
      if (typeof item.grayscale !== "boolean") throw new Error(`${id}.grayscale must be a boolean`);
    } else {
      if (!isTextItem(item)) throw new Error(`${id}.type is invalid`);
      if (item.speaker !== null && item.speaker !== undefined) requireString(item.speaker, `${id}.speaker`);
      requireString(item.text, `${id}.text`);
      if (!DIRECTIONS.has(item.direction)) throw new Error(`${id}.direction is invalid`);
      region = requireItemRegion(item, id);
      requireNumber(item.padding, `${id}.padding`, { min: 0 });
      requireString(item.fontFamily, `${id}.fontFamily`);
      const fontSize = requireNumber(item.fontSize, `${id}.fontSize`, { min: 1 });
      const minFontSize = requireNumber(item.minFontSize, `${id}.minFontSize`, { min: 1 });
      if (minFontSize > fontSize) throw new Error(`${id}.minFontSize cannot exceed fontSize`);
      requireNumber(item.fontWeight, `${id}.fontWeight`, { min: 100 });
      requireNumber(item.lineHeight, `${id}.lineHeight`, { min: 0.5 });
      if (!ALIGNS.has(item.align)) throw new Error(`${id}.align is invalid`);
      if (item.appearance !== undefined && !APPEARANCES.has(item.appearance)) {
        throw new Error(`${id}.appearance is invalid`);
      }
    }
    const { x, y, width, height } = region;
    if (x + width > sourceWidth || y + height > sourceHeight) {
      throw new Error(`${id} is outside source bounds`);
    }
  }

  return structuredClone(input);
}
