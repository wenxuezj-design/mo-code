import { readFile } from "node:fs/promises";
import path from "node:path";

const CHAPTER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGE_PATTERN = /^\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireChapter(value, label = "chapter") {
  if (typeof value !== "string" || !CHAPTER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid: ${String(value)}`);
  }
  return value;
}

function requirePage(value, label = "page") {
  if (typeof value !== "string" || !PAGE_PATTERN.test(value)) {
    throw new Error(`${label} is invalid: ${String(value)}`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireRemotePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("%") ||
    URI_SCHEME_PATTERN.test(value) ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

function requireCacheFile(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(`${label} must be a file name without path separators`);
  }
  return value;
}

function validateAsset(value, label) {
  const asset = requireObject(value, label);
  requireRemotePath(asset.remotePath, `${label}.remotePath`);
  requireCacheFile(asset.cacheFile, `${label}.cacheFile`);
  if (typeof asset.sha256 !== "string" || !SHA256_PATTERN.test(asset.sha256)) {
    throw new Error(`${label}.sha256 must be 64 lowercase hexadecimal characters`);
  }
  requirePositiveInteger(asset.bytes, `${label}.bytes`);
  requirePositiveInteger(asset.width, `${label}.width`);
  requirePositiveInteger(asset.height, `${label}.height`);
  return asset;
}

export function validateAssetManifest(value) {
  const manifest = requireObject(value, "manifest");
  if (manifest.version !== 1) throw new Error("manifest.version must be 1");
  requireChapter(manifest.chapter, "manifest.chapter");

  const pages = requireObject(manifest.pages, "manifest.pages");
  for (const [page, rawPageAssets] of Object.entries(pages)) {
    requirePage(page, "manifest page");
    const pageAssets = requireObject(rawPageAssets, `manifest.pages[${page}]`);
    if (!Object.hasOwn(pageAssets, "base")) {
      throw new Error(`manifest.pages[${page}] must have its own base asset`);
    }
    const kinds = Object.keys(pageAssets);
    if (kinds.length !== 1 || kinds[0] !== "base") {
      throw new Error(`manifest.pages[${page}] only allows the base kind`);
    }
    validateAsset(pageAssets.base, `manifest.pages[${page}].base`);
  }

  return structuredClone(manifest);
}

export async function loadAssetManifest({ projectRoot, chapter }) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("projectRoot must be a non-empty string");
  }
  const safeChapter = requireChapter(chapter);
  const manifestPath = path.join(
    path.resolve(projectRoot),
    "docs",
    "story",
    "chapters",
    safeChapter,
    "assets.json",
  );
  const manifest = validateAssetManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.chapter !== safeChapter) {
    throw new Error(
      `Manifest chapter does not match requested chapter: expected ${safeChapter}, actual ${manifest.chapter}`,
    );
  }
  return manifest;
}

export function resolvePageAsset({ manifest, chapter, page, kind }) {
  const validated = validateAssetManifest(manifest);
  const safeChapter = requireChapter(chapter);
  const safePage = requirePage(page);
  if (validated.chapter !== safeChapter) {
    throw new Error(
      `Manifest chapter does not match requested chapter: expected ${safeChapter}, actual ${validated.chapter}`,
    );
  }
  if (kind !== "base") {
    throw new Error(`Unsupported asset kind: ${String(kind)}`);
  }

  const pageAssets = Object.hasOwn(validated.pages, safePage)
    ? validated.pages[safePage]
    : undefined;
  if (pageAssets === undefined || !Object.hasOwn(pageAssets, kind)) {
    throw new Error(`No ${kind} asset for chapter ${safeChapter} page ${safePage}`);
  }
  return pageAssets[kind];
}

export function resolveAssetCachePath({ projectRoot, chapter, asset }) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new Error("projectRoot must be a non-empty string");
  }
  const safeChapter = requireChapter(chapter);
  const input = requireObject(asset, "asset");
  const cacheFile = requireCacheFile(input.cacheFile, "asset.cacheFile");
  const cacheRoot = path.resolve(projectRoot, ".story-assets", "cache", safeChapter);
  const cachePath = path.resolve(cacheRoot, cacheFile);
  if (!cachePath.startsWith(`${cacheRoot}${path.sep}`)) {
    throw new Error("Asset cache path escapes chapter cache");
  }
  return cachePath;
}
