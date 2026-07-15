import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PORTRAIT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9]\d*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireCropCoordinate(value, label, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function projectPath(projectRoot) {
  return path.resolve(requireString(projectRoot, "projectRoot"));
}

function validateCrop(value, label) {
  const crop = requireObject(value, label);
  requireCropCoordinate(crop.x, `${label}.x`, 0);
  requireCropCoordinate(crop.y, `${label}.y`, 0);
  requireCropCoordinate(crop.width, `${label}.width`, 1);
  requireCropCoordinate(crop.height, `${label}.height`, 1);
  return crop;
}

function validatePortrait(value, label) {
  const portrait = requireObject(value, label);
  requireString(portrait.label, `${label}.label`);
  requireString(portrait.character, `${label}.character`);
  requireString(portrait.expression, `${label}.expression`);
  requireString(portrait.file, `${label}.file`);
  validateCrop(portrait.crop, `${label}.crop`);
  return portrait;
}

function requireSafeRelativePath(value, label) {
  const file = requireString(value, label);
  if (
    path.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    file.includes("\\") ||
    file.includes(":") ||
    CONTROL_CHARACTER_PATTERN.test(file) ||
    file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return file;
}

function containedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function pathSafetyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolvePortraitLexicalPath({ projectRoot, portrait }) {
  const root = projectPath(projectRoot);
  const entry = requireObject(portrait, "portrait");
  const file = requireSafeRelativePath(entry.file, "portrait.file");
  const charactersRoot = path.resolve(root, "docs", "story", "assets", "characters");
  const imagePath = path.resolve(charactersRoot, file);
  if (!containedPath(charactersRoot, imagePath)) {
    throw new Error("portrait.file must resolve inside the character assets directory");
  }
  return { charactersRoot, imagePath };
}

export function resolvePortraitImagePath({ projectRoot, portrait }) {
  const { charactersRoot, imagePath } = resolvePortraitLexicalPath({ projectRoot, portrait });
  const resolvedRoot = realpathSync(charactersRoot);
  const resolvedImage = realpathSync(imagePath);
  if (!containedPath(resolvedRoot, resolvedImage)) {
    throw pathSafetyError(
      "PORTRAIT_PATH_OUTSIDE",
      "portrait.file resolves outside the character assets directory",
    );
  }
  if (!statSync(resolvedImage).isFile()) {
    throw pathSafetyError("PORTRAIT_IMAGE_NOT_FILE", "portrait.file must resolve to a file");
  }
  return resolvedImage;
}

export async function loadPortraitCatalog({ projectRoot }) {
  const root = projectPath(projectRoot);
  const catalogPath = path.join(root, "docs", "story", "assets", "characters", "portraits.json");
  const catalog = requireObject(JSON.parse(await readFile(catalogPath, "utf8")), "portrait catalog");
  const crops = new Set();

  for (const [id, rawPortrait] of Object.entries(catalog)) {
    if (!PORTRAIT_ID_PATTERN.test(id)) {
      throw new Error(`portrait catalog ID is invalid: ${id}`);
    }
    const portrait = validatePortrait(rawPortrait, `portrait catalog.${id}`);
    resolvePortraitLexicalPath({ projectRoot: root, portrait });
    const { file, crop } = portrait;
    const cropKey = `${file}\0${crop.x},${crop.y},${crop.width},${crop.height}`;
    if (crops.has(cropKey)) {
      throw new Error(`Duplicate crop in portrait catalog: ${id}`);
    }
    crops.add(cropKey);
  }

  return structuredClone(catalog);
}
