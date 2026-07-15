import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadAssetManifest,
  resolveAssetCachePath,
  resolvePageAsset,
} from "./lib/asset-manifest.mjs";
import { verifyLocalAsset } from "./lib/image-metadata.mjs";
import {
  isGeneratedSource,
  isPortraitItem,
  validatePageLayout,
} from "./lib/page-model.mjs";
import {
  loadPortraitCatalog,
  resolvePortraitImagePath,
} from "./lib/portrait-catalog.mjs";
import { resolvePagePaths } from "./lib/paths.mjs";
import { atomicWrite, HttpError, readRequestBody, sendJson } from "./lib/http.mjs";

const JSON_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 25 * 1024 * 1024;
const TOOL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORTRAIT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9]\d*$/;
const PAGE_LAYOUT_FILE_PATTERN = /^page-(\d{2})-lettering\.json$/;

function parsePageRoute(pathname) {
  const match = pathname.match(/^\/api\/pages\/([^/]+)\/([^/]+)(?:\/(layout|base|export)(?:\/([^/]+))?)?$/);
  if (!match) return null;
  try {
    return {
      chapter: decodeURIComponent(match[1]),
      page: decodeURIComponent(match[2]),
      action: match[3] ?? "page",
      format: match[4] ? decodeURIComponent(match[4]) : null,
    };
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Malformed URL encoding");
  }
}

function parsePortraitRoute(pathname) {
  const match = pathname.match(/^\/api\/portraits\/([^/]+)\/image$/);
  if (!match) return null;
  let portraitId;
  try {
    portraitId = decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, "INVALID_PATH", "Malformed URL encoding");
  }
  if (!PORTRAIT_ID_PATTERN.test(portraitId)) {
    throw new HttpError(400, "INVALID_PATH", "Invalid portrait ID");
  }
  return { portraitId };
}

async function serveFile(response, filePath, contentType) {
  const bytes = await readFile(filePath);
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": bytes.length,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function ensureLayoutMatchesRoute(layout, route) {
  if (layout.chapter !== route.chapter || layout.page !== route.page) {
    throw new HttpError(400, "LAYOUT_ROUTE_MISMATCH", "Layout chapter/page does not match request path");
  }
}

function ensureLayoutMatchesAsset(layout, asset) {
  const source = layout.source;
  if (
    source.file !== asset.cacheFile ||
    source.width !== asset.width ||
    source.height !== asset.height
  ) {
    throw new HttpError(
      409,
      "LAYOUT_ASSET_MISMATCH",
      "Layout source file or dimensions do not match the asset manifest",
    );
  }
}

function missingBaseError(route) {
  const command = `pnpm story:assets:pull -- --chapter ${route.chapter} --page ${route.page}`;
  return new HttpError(404, "BASE_ASSET_MISSING", `Base image is not cached. Run: ${command}`);
}

function staleBaseError(route, error) {
  const command = `pnpm story:assets:pull -- --chapter ${route.chapter} --page ${route.page}`;
  return new HttpError(
    409,
    "BASE_ASSET_STALE",
    `Cached base image does not match assets.json (${error.message}). Run: ${command}`,
  );
}

async function ensureBaseAvailable(filePath, asset, route) {
  try {
    await verifyLocalAsset({ filePath, asset });
  } catch (error) {
    if (error?.code === "ENOENT") throw missingBaseError(route);
    if (error?.code) throw error;
    throw staleBaseError(route, error);
  }
}

function baseContentType(asset) {
  const extension = path.extname(asset.cacheFile).toLowerCase();
  if (extension === ".webp") return "image/webp";
  if (extension === ".png") return "image/png";
  throw new HttpError(
    415,
    "UNSUPPORTED_BASE_FORMAT",
    `Unsupported base image format: ${extension || "none"}`,
  );
}

function portraitContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".webp") return "image/webp";
  if (extension === ".png") return "image/png";
  throw new HttpError(
    415,
    "UNSUPPORTED_PORTRAIT_FORMAT",
    `Unsupported portrait image format: ${extension || "none"}`,
  );
}

async function referencedPortraitMetadata({ projectRoot, layout }) {
  const portraitIds = [...new Set(
    layout.items.filter(isPortraitItem).map((item) => item.portraitId),
  )];
  if (portraitIds.length === 0) return {};

  const catalog = await loadPortraitCatalog({ projectRoot });
  const portraits = {};
  for (const portraitId of portraitIds) {
    if (!Object.hasOwn(catalog, portraitId)) {
      throw new HttpError(400, "UNKNOWN_PORTRAIT_ID", `Unknown portrait ID: ${portraitId}`);
    }
    const { label, character, expression, crop } = catalog[portraitId];
    portraits[portraitId] = {
      label,
      character,
      expression,
      crop,
      imageUrl: `/api/portraits/${portraitId}/image`,
    };
  }
  return portraits;
}

async function discoverPageNavigation({ layoutJson, currentPage }) {
  const entries = await readdir(path.dirname(layoutJson), { withFileTypes: true });
  const pages = entries
    .filter((entry) => entry.isFile())
    .map((entry) => PAGE_LAYOUT_FILE_PATTERN.exec(entry.name)?.[1] ?? null)
    .filter((page) => page !== null)
    .sort((left, right) => Number(left) - Number(right));
  const currentIndex = pages.indexOf(currentPage);
  return {
    previous: currentIndex > 0 ? pages[currentIndex - 1] : null,
    next: currentIndex >= 0 && currentIndex < pages.length - 1
      ? pages[currentIndex + 1]
      : null,
  };
}

async function resolveBaseAsset({ projectRoot, route }) {
  const manifest = await loadAssetManifest({ projectRoot, chapter: route.chapter });
  const asset = resolvePageAsset({
    manifest,
    chapter: route.chapter,
    page: route.page,
    kind: "base",
  });
  return {
    asset,
    filePath: resolveAssetCachePath({ projectRoot, chapter: route.chapter, asset }),
    contentType: baseContentType(asset),
  };
}

async function handleApi(request, response, projectRoot, pathname) {
  const portraitRoute = parsePortraitRoute(pathname);
  if (portraitRoute) {
    if (request.method !== "GET") return false;
    const catalog = await loadPortraitCatalog({ projectRoot });
    if (!Object.hasOwn(catalog, portraitRoute.portraitId)) {
      throw new HttpError(
        404,
        "PORTRAIT_NOT_FOUND",
        `Unknown portrait ID: ${portraitRoute.portraitId}`,
      );
    }
    let filePath;
    try {
      filePath = resolvePortraitImagePath({
        projectRoot,
        portrait: catalog[portraitRoute.portraitId],
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new HttpError(404, "PORTRAIT_IMAGE_NOT_FOUND", "Portrait image is missing");
      }
      if (error?.code === "PORTRAIT_PATH_OUTSIDE" || error?.code === "PORTRAIT_IMAGE_NOT_FILE") {
        throw new HttpError(403, "PORTRAIT_IMAGE_UNSAFE", "Portrait image path is not allowed");
      }
      throw error;
    }
    await serveFile(response, filePath, portraitContentType(filePath));
    return true;
  }

  const route = parsePageRoute(pathname);
  if (!route) return false;

  let paths;
  try {
    paths = resolvePagePaths({ projectRoot, chapter: route.chapter, page: route.page });
  } catch (error) {
    throw new HttpError(400, "INVALID_PATH", error.message);
  }

  if (request.method === "GET" && route.action === "page") {
    const layout = validatePageLayout(JSON.parse(await readFile(paths.layoutJson, "utf8")));
    ensureLayoutMatchesRoute(layout, route);
    const portraits = await referencedPortraitMetadata({ projectRoot, layout });
    const navigation = await discoverPageNavigation({
      layoutJson: paths.layoutJson,
      currentPage: route.page,
    });
    if (isGeneratedSource(layout.source)) {
      sendJson(response, 200, { layout, baseUrl: null, portraits, navigation });
      return true;
    }
    const { asset, filePath } = await resolveBaseAsset({ projectRoot, route });
    ensureLayoutMatchesAsset(layout, asset);
    await ensureBaseAvailable(filePath, asset, route);
    sendJson(response, 200, {
      layout,
      baseUrl: `/api/pages/${route.chapter}/${route.page}/base`,
      portraits,
      navigation,
    });
    return true;
  }

  if (request.method === "GET" && route.action === "base") {
    const { asset, filePath, contentType } = await resolveBaseAsset({ projectRoot, route });
    try {
      await ensureBaseAvailable(filePath, asset, route);
      await serveFile(response, filePath, contentType);
    } catch (error) {
      if (error?.code === "ENOENT") throw missingBaseError(route);
      throw error;
    }
    return true;
  }

  if (request.method === "PUT" && route.action === "layout") {
    const body = await readRequestBody(request, JSON_LIMIT);
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
    }
    let layout;
    try {
      layout = validatePageLayout(parsed);
    } catch (error) {
      throw new HttpError(400, "INVALID_LAYOUT", error.message);
    }
    ensureLayoutMatchesRoute(layout, route);
    await referencedPortraitMetadata({ projectRoot, layout });
    if (!isGeneratedSource(layout.source)) {
      const { asset } = await resolveBaseAsset({ projectRoot, route });
      ensureLayoutMatchesAsset(layout, asset);
    }
    await atomicWrite(paths.layoutJson, `${JSON.stringify(layout, null, 2)}\n`);
    sendJson(response, 200, { saved: true, itemCount: layout.items.length });
    return true;
  }

  if (request.method === "POST" && route.action === "export") {
    if (!new Set(["webp", "png"]).has(route.format)) return false;
    const bytes = await readRequestBody(request, IMAGE_LIMIT);
    if (bytes.length === 0) throw new HttpError(400, "EMPTY_EXPORT", "Export body is empty");
    const output = route.format === "webp" ? paths.finalWebp : paths.finalPng;
    await atomicWrite(output, bytes);
    sendJson(response, 200, { saved: true, format: route.format, bytes: bytes.length });
    return true;
  }

  return false;
}

async function handleStatic(request, response, pathname) {
  if (request.method !== "GET") return false;
  const files = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/lib/layout.mjs", ["lib/layout.mjs", "text/javascript; charset=utf-8"]],
    ["/lib/text-fit.mjs", ["lib/text-fit.mjs", "text/javascript; charset=utf-8"]],
    ["/lib/canvas-export.mjs", ["lib/canvas-export.mjs", "text/javascript; charset=utf-8"]],
    ["/lib/page-model.mjs", ["lib/page-model.mjs", "text/javascript; charset=utf-8"]],
    ["/lib/save-queue.mjs", ["lib/save-queue.mjs", "text/javascript; charset=utf-8"]],
  ]);
  const entry = files.get(pathname);
  if (!entry) return false;
  await serveFile(response, path.join(TOOL_ROOT, entry[0]), entry[1]);
  return true;
}

export async function createLetteringServer({ projectRoot, host = "127.0.0.1", port = 41731 }) {
  const root = path.resolve(projectRoot);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const handled = url.pathname.startsWith("/api/")
        ? await handleApi(request, response, root, url.pathname)
        : await handleStatic(request, response, url.pathname);
      if (!handled) sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found" });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { code: error.code, message: error.message });
        return;
      }
      if (error?.code === "ENOENT") {
        sendJson(response, 404, { code: "FILE_NOT_FOUND", message: "Page file not found" });
        return;
      }
      sendJson(response, 500, { code: "INTERNAL_ERROR", message: "Unexpected server error" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${actualPort}` };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const projectRoot = process.cwd();
  const app = await createLetteringServer({ projectRoot });
  console.log(`Manga lettering editor: ${app.url}`);
}
