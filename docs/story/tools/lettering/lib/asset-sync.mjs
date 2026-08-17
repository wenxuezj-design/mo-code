import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  loadAssetManifest,
  resolveAssetCachePath,
  resolvePageAsset,
  validateAssetManifest,
} from "./asset-manifest.mjs";
import { inspectImage, verifyLocalAsset } from "./image-metadata.mjs";

const VERSION_PATTERN = /^v[1-9]\d*$/;
const PAGE_PATTERN = /^\d{2}$/;
const IMAGE_EXTENSION_PATTERN = /^\.(png|webp)$/i;
const RCLONE_REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*:$/;
const GROUP_OR_WORLD_WRITABLE = 0o022;

function rcloneExecutableError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function validateRcloneExecutable(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw rcloneExecutableError(
      "STORY_RCLONE_BIN_INVALID",
      "STORY_RCLONE_BIN must be an absolute path to the rclone executable",
    );
  }

  const resolvedPath = await realpath(filePath);
  const [fileInfo, directoryInfo] = await Promise.all([
    stat(resolvedPath),
    stat(path.dirname(resolvedPath)),
  ]);
  if (!fileInfo.isFile()) {
    throw rcloneExecutableError(
      "STORY_RCLONE_BIN_INVALID",
      `rclone executable is not a file: ${resolvedPath}`,
    );
  }
  await access(resolvedPath, fsConstants.X_OK);

  if (process.platform !== "win32") {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    for (const [info, label] of [
      [fileInfo, "rclone executable"],
      [directoryInfo, "rclone executable directory"],
    ]) {
      if ((info.mode & GROUP_OR_WORLD_WRITABLE) !== 0) {
        throw rcloneExecutableError(
          "STORY_RCLONE_BIN_UNSAFE",
          `${label} must not be writable by group or other users`,
        );
      }
      if (currentUid !== null && info.uid !== 0 && info.uid !== currentUid) {
        throw rcloneExecutableError(
          "STORY_RCLONE_BIN_UNSAFE",
          `${label} must be owned by the current user or root`,
        );
      }
    }
  }

  return resolvedPath;
}

function missingRcloneError() {
  return rcloneExecutableError(
    "ENOENT",
    "rclone executable was not found in STORY_RCLONE_BIN or a trusted PATH directory",
  );
}

export async function resolveRcloneExecutable({ env = process.env } = {}) {
  if (env.STORY_RCLONE_BIN !== undefined) {
    return validateRcloneExecutable(env.STORY_RCLONE_BIN);
  }

  if (typeof env.PATH !== "string" || env.PATH.length === 0) {
    throw missingRcloneError();
  }
  const executableName = process.platform === "win32" ? "rclone.exe" : "rclone";
  for (const directory of env.PATH.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      return await validateRcloneExecutable(path.join(directory, executableName));
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) continue;
      throw error;
    }
  }
  throw missingRcloneError();
}

export function assertRcloneRemote(remote) {
  if (typeof remote !== "string" || !RCLONE_REMOTE_PATTERN.test(remote)) {
    const error = new Error(
      "STORY_RCLONE_REMOTE must be a remote name ending with a colon, for example mo-code-story:",
    );
    error.code = "STORY_REMOTE_INVALID";
    throw error;
  }
  return remote;
}

export async function runRclone(args) {
  const executable = await resolveRcloneExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = code === null ? `signal ${signal}` : `code ${code}`;
      reject(new Error(`rclone exited with ${detail}`));
    });
  });
}

export async function pullPageBase({
  projectRoot,
  chapter,
  page,
  remote,
  runRemoteCommand,
}) {
  const safeRemote = assertRcloneRemote(remote);
  const manifest = await loadAssetManifest({ projectRoot, chapter });
  const asset = resolvePageAsset({ manifest, chapter, page, kind: "base" });
  const cachePath = resolveAssetCachePath({ projectRoot, chapter, asset });

  try {
    await verifyLocalAsset({ filePath: cachePath, asset });
    return cachePath;
  } catch {
    // A missing or stale cache is replaced only after the download is verified.
  }

  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.part-${process.pid}-${Date.now()}`;

  try {
    await runRemoteCommand([
      "copyto",
      `${safeRemote}${asset.remotePath}`,
      temporaryPath,
      "--no-traverse",
    ]);
    await verifyLocalAsset({ filePath: temporaryPath, asset });
    await rename(temporaryPath, cachePath);
    return cachePath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function pushPageBase({
  projectRoot,
  chapter,
  page,
  version,
  sourceFile,
  remote,
  runRemoteCommand,
}) {
  const safeRemote = assertRcloneRemote(remote);
  if (typeof page !== "string" || !PAGE_PATTERN.test(page)) {
    throw new Error("page must be exactly two digits");
  }
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error("version must be v followed by a positive integer");
  }
  if (typeof sourceFile !== "string" || !path.isAbsolute(sourceFile)) {
    throw new Error("sourceFile must be an absolute path");
  }

  const extensionMatch = IMAGE_EXTENSION_PATTERN.exec(path.extname(sourceFile));
  if (extensionMatch === null) {
    throw new Error("sourceFile extension must be .png or .webp");
  }
  const extension = extensionMatch[1].toLowerCase();
  const manifest = await loadAssetManifest({ projectRoot, chapter });
  const metadata = await inspectImage(sourceFile);
  const remotePath =
    `chapters/${chapter}/bases/page-${page}-base-${version}.${extension}`;
  const asset = {
    remotePath,
    cacheFile: `page-${page}-base.${extension}`,
    ...metadata,
  };

  const updatedManifest = structuredClone(manifest);
  updatedManifest.pages[page] = { base: asset };
  validateAssetManifest(updatedManifest);

  await runRemoteCommand([
    "copyto",
    sourceFile,
    `${safeRemote}${remotePath}`,
    "--no-traverse",
    "--immutable",
    "--checksum",
  ]);

  const manifestPath = path.join(
    path.resolve(projectRoot),
    "docs",
    "story",
    "chapters",
    chapter,
    "assets.json",
  );
  const temporaryPath = `${manifestPath}.part-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return asset;
}
