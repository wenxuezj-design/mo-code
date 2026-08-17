#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadAssetManifest,
  resolveAssetCachePath,
  resolvePageAsset,
} from "./lib/asset-manifest.mjs";
import { verifyLocalAsset } from "./lib/image-metadata.mjs";
import {
  assertRcloneRemote,
  pullPageBase,
  pushPageBase,
  runRclone,
} from "./lib/asset-sync.mjs";

const COMMAND_OPTIONS = {
  pull: new Set(["chapter", "page"]),
  verify: new Set(["chapter", "page"]),
  push: new Set(["chapter", "page", "version", "source"]),
};

function parseArguments(argv) {
  const [command, ...rawTokens] = argv;
  const tokens = rawTokens[0] === "--" ? rawTokens.slice(1) : rawTokens;
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) {
    throw new Error("command must be pull, verify, or push");
  }

  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || value === undefined) {
      throw new Error(`invalid option: ${String(flag)}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`unsupported option for ${command}: ${flag}`);
    if (Object.hasOwn(options, name)) throw new Error(`duplicate option: ${flag}`);
    options[name] = value;
  }

  for (const required of command === "push"
    ? ["chapter", "page", "version", "source"]
    : ["chapter"]) {
    if (!options[required]) throw new Error(`--${required} is required for ${command}`);
  }
  return { command, options };
}

function requireRemote(env) {
  const remote = env.STORY_RCLONE_REMOTE;
  if (typeof remote !== "string" || remote.length === 0) {
    const error = new Error("STORY_RCLONE_REMOTE is not configured");
    error.code = "STORY_REMOTE_MISSING";
    throw error;
  }
  return assertRcloneRemote(remote);
}

async function selectedPages({ projectRoot, chapter, page }) {
  if (page !== undefined) return [page];
  const manifest = await loadAssetManifest({ projectRoot, chapter });
  return Object.keys(manifest.pages).sort((left, right) => Number(left) - Number(right));
}

function writeSetupError(stderr, error) {
  if (error?.code === "STORY_REMOTE_MISSING") {
    stderr.write(
      "STORY_RCLONE_REMOTE is missing. Run `rclone config`, then set " +
        "`export STORY_RCLONE_REMOTE=mo-code-story:` and retry.\n",
    );
    return;
  }
  if (error?.code === "ENOENT") {
    stderr.write(
      "rclone is not installed. Install it with `brew install rclone` (or see " +
        "https://rclone.org/install/), run `rclone config`, set STORY_RCLONE_REMOTE, and retry.\n",
    );
    return;
  }
  stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
}

export async function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runRemoteCommand = runRclone,
} = {}) {
  try {
    const { command, options } = parseArguments(argv);
    const projectRoot = path.resolve(cwd);

    if (command === "pull") {
      const remote = requireRemote(env);
      const pages = await selectedPages({
        projectRoot,
        chapter: options.chapter,
        page: options.page,
      });
      for (const page of pages) {
        const cachePath = await pullPageBase({
          projectRoot,
          chapter: options.chapter,
          page,
          remote,
          runRemoteCommand,
        });
        stdout.write(`Pulled page ${page}: ${cachePath}\n`);
      }
    }

    if (command === "verify") {
      const manifest = await loadAssetManifest({
        projectRoot,
        chapter: options.chapter,
      });
      const pages = options.page === undefined
        ? Object.keys(manifest.pages).sort((left, right) => Number(left) - Number(right))
        : [options.page];
      for (const page of pages) {
        const asset = resolvePageAsset({
          manifest,
          chapter: options.chapter,
          page,
          kind: "base",
        });
        const cachePath = resolveAssetCachePath({
          projectRoot,
          chapter: options.chapter,
          asset,
        });
        await verifyLocalAsset({ filePath: cachePath, asset });
        stdout.write(`Verified page ${page}: ${cachePath}\n`);
      }
    }

    if (command === "push") {
      const remote = requireRemote(env);
      const asset = await pushPageBase({
        projectRoot,
        chapter: options.chapter,
        page: options.page,
        version: options.version,
        sourceFile: options.source,
        remote,
        runRemoteCommand,
      });
      stdout.write(`Pushed page ${options.page}: ${asset.remotePath}\n`);
    }

    return 0;
  } catch (error) {
    writeSetupError(stderr, error);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  process.exitCode = await main();
}
