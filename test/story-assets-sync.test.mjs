import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  chmod,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  pullPageBase,
  pushPageBase,
  runRclone,
} from "../docs/story/tools/lettering/lib/asset-sync.mjs";
import { main as runAssetsCli } from "../docs/story/tools/lettering/assets-cli.mjs";

function pngFixture(width = 24, height = 36) {
  const buffer = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function assetFor(contents, overrides = {}) {
  return {
    remotePath: "chapters/01-agent-loop/bases/page-02-base-v1.png",
    cacheFile: "page-02-base.png",
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.length,
    width: 24,
    height: 36,
    ...overrides,
  };
}

async function createProject(asset) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "story-assets-sync-"));
  const manifestPath = path.join(
    projectRoot,
    "docs/story/chapters/01-agent-loop/assets.json",
  );
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      chapter: "01-agent-loop",
      pages: { "02": { base: asset } },
    }, null, 2)}\n`,
    "utf8",
  );
  return projectRoot;
}

function manifestPathFor(projectRoot) {
  return path.join(
    projectRoot,
    "docs/story/chapters/01-agent-loop/assets.json",
  );
}

function cachePathFor(projectRoot, asset) {
  return path.join(
    projectRoot,
    ".story-assets/cache/01-agent-loop",
    asset.cacheFile,
  );
}

async function assertNoPartFiles(cachePath) {
  const names = await readdir(path.dirname(cachePath));
  assert.equal(names.some((name) => name.includes(".part-")), false);
}

function captureOutput() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
      },
    },
    read() {
      return value;
    },
  };
}

async function invokeAssetsCli({
  argv,
  projectRoot,
  env = {},
  runRemoteCommand,
}) {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const status = await runAssetsCli({
    argv,
    cwd: projectRoot,
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runRemoteCommand,
  });
  return { status, stdout: stdout.read(), stderr: stderr.read() };
}

test("pullPageBase downloads to a sibling temporary file and replaces the cache after verification", async () => {
  const downloaded = pngFixture();
  const asset = assetFor(downloaded);
  const projectRoot = await createProject(asset);
  const cachePath = cachePathFor(projectRoot, asset);
  const calls = [];

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, "old-cache", "utf8");

    const result = await pullPageBase({
      projectRoot,
      chapter: "01-agent-loop",
      page: "02",
      remote: "story-drive:",
      runRemoteCommand: async (args) => {
        calls.push(args);
        await writeFile(args[2], downloaded);
      },
    });

    assert.equal(result, cachePath);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      [calls[0][0], calls[0][1], calls[0][3]],
      [
        "copyto",
        "story-drive:chapters/01-agent-loop/bases/page-02-base-v1.png",
        "--no-traverse",
      ],
    );
    assert.equal(path.dirname(calls[0][2]), path.dirname(cachePath));
    assert.match(calls[0][2], /page-02-base\.png\.part-\d+-\d+$/);
    assert.deepEqual(await readFile(cachePath), downloaded);
    await assertNoPartFiles(cachePath);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pullPageBase skips the remote when an existing cache is valid", async () => {
  const downloaded = pngFixture();
  const asset = assetFor(downloaded);
  const projectRoot = await createProject(asset);
  const cachePath = cachePathFor(projectRoot, asset);
  let calls = 0;

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, downloaded);

    assert.equal(
      await pullPageBase({
        projectRoot,
        chapter: "01-agent-loop",
        page: "02",
        remote: "story-drive:",
        runRemoteCommand: async () => {
          calls += 1;
        },
      }),
      cachePath,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pullPageBase preserves the old cache and removes the temporary file when the runner fails", async () => {
  const downloaded = pngFixture();
  const asset = assetFor(downloaded);
  const projectRoot = await createProject(asset);
  const cachePath = cachePathFor(projectRoot, asset);
  const oldCache = Buffer.from("old-cache", "utf8");

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, oldCache);

    await assert.rejects(
      () =>
        pullPageBase({
          projectRoot,
          chapter: "01-agent-loop",
          page: "02",
          remote: "story-drive:",
          runRemoteCommand: async (args) => {
            await writeFile(args[2], "partial", "utf8");
            throw new Error("remote unavailable");
          },
        }),
      /remote unavailable/,
    );

    assert.deepEqual(await readFile(cachePath), oldCache);
    await assertNoPartFiles(cachePath);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pullPageBase preserves the old cache and removes the temporary file when verification fails", async () => {
  const expected = pngFixture();
  const downloaded = pngFixture(25, 36);
  const asset = assetFor(expected);
  const projectRoot = await createProject(asset);
  const cachePath = cachePathFor(projectRoot, asset);
  const oldCache = Buffer.from("old-cache", "utf8");

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, oldCache);

    await assert.rejects(
      () =>
        pullPageBase({
          projectRoot,
          chapter: "01-agent-loop",
          page: "02",
          remote: "story-drive:",
          runRemoteCommand: async (args) => {
            await writeFile(args[2], downloaded);
          },
        }),
      /mismatch/,
    );

    assert.deepEqual(await readFile(cachePath), oldCache);
    await assertNoPartFiles(cachePath);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pullPageBase rejects content that disagrees with the manifest cache extension", async () => {
  const downloaded = pngFixture();
  const asset = assetFor(downloaded, {
    remotePath: "chapters/01-agent-loop/bases/page-02-base-v1.webp",
    cacheFile: "page-02-base.webp",
  });
  const projectRoot = await createProject(asset);
  const cachePath = cachePathFor(projectRoot, asset);
  const oldCache = Buffer.from("old-cache", "utf8");

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, oldCache);

    await assert.rejects(
      () =>
        pullPageBase({
          projectRoot,
          chapter: "01-agent-loop",
          page: "02",
          remote: "story-drive:",
          runRemoteCommand: async (args) => {
            await writeFile(args[2], downloaded);
          },
        }),
      /format mismatch/i,
    );

    assert.deepEqual(await readFile(cachePath), oldCache);
    await assertNoPartFiles(cachePath);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pushPageBase uploads an immutable version name before atomically updating the manifest", async () => {
  const existing = pngFixture();
  const uploaded = pngFixture(48, 72);
  const asset = assetFor(existing);
  const projectRoot = await createProject(asset);
  const sourceFile = path.join(projectRoot, "new page.png");
  const calls = [];

  try {
    await writeFile(sourceFile, uploaded);

    const result = await pushPageBase({
      projectRoot,
      chapter: "01-agent-loop",
      page: "02",
      version: "v2",
      sourceFile,
      remote: "story-drive:",
      runRemoteCommand: async (args) => {
        calls.push(args);
        const manifestDuringUpload = JSON.parse(
          await readFile(manifestPathFor(projectRoot), "utf8"),
        );
        assert.deepEqual(manifestDuringUpload.pages["02"].base, asset);
      },
    });

    const expectedAsset = {
      remotePath: "chapters/01-agent-loop/bases/page-02-base-v2.png",
      cacheFile: "page-02-base.png",
      sha256: createHash("sha256").update(uploaded).digest("hex"),
      bytes: uploaded.length,
      width: 48,
      height: 72,
    };
    assert.deepEqual(result, expectedAsset);
    assert.deepEqual(calls, [[
      "copyto",
      sourceFile,
      "story-drive:chapters/01-agent-loop/bases/page-02-base-v2.png",
      "--no-traverse",
      "--immutable",
      "--checksum",
    ]]);

    const updatedManifest = JSON.parse(
      await readFile(manifestPathFor(projectRoot), "utf8"),
    );
    assert.deepEqual(updatedManifest.pages["02"].base, expectedAsset);
    assert.deepEqual(
      (await readdir(path.dirname(manifestPathFor(projectRoot)))).filter((name) =>
        name.includes("assets.json.part-")),
      [],
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pushPageBase only accepts v followed by a canonical positive integer", async () => {
  const uploaded = pngFixture();
  const asset = assetFor(uploaded);
  const projectRoot = await createProject(asset);
  const sourceFile = path.join(projectRoot, "new-page.png");

  try {
    await writeFile(sourceFile, uploaded);
    for (const version of ["1", "v0", "v01", "v-1", "v1.5", "v"] ) {
      await assert.rejects(
        () =>
          pushPageBase({
            projectRoot,
            chapter: "01-agent-loop",
            page: "02",
            version,
            sourceFile,
            remote: "story-drive:",
            runRemoteCommand: async () => {
              assert.fail("invalid versions must not invoke the runner");
            },
          }),
        /version/i,
      );
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pushPageBase rejects invalid page numbers before upload or manifest update", async (t) => {
  const uploaded = pngFixture();
  const asset = assetFor(uploaded);
  const projectRoot = await createProject(asset);
  const sourceFile = path.join(projectRoot, "new-page.png");
  const manifestPath = manifestPathFor(projectRoot);

  try {
    await writeFile(sourceFile, uploaded);

    for (const page of ["__proto__", "1", "aa"]) {
      await t.test(page, async () => {
        const before = await readFile(manifestPath);
        let runnerCalls = 0;

        await assert.rejects(
          () =>
            pushPageBase({
              projectRoot,
              chapter: "01-agent-loop",
              page,
              version: "v2",
              sourceFile,
              remote: "story-drive:",
              runRemoteCommand: async () => {
                runnerCalls += 1;
              },
            }),
          /page/i,
        );

        assert.equal(runnerCalls, 0);
        assert.deepEqual(await readFile(manifestPath), before);
      });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("pushPageBase leaves the manifest byte-for-byte unchanged when upload fails", async () => {
  const existing = pngFixture();
  const uploaded = pngFixture(48, 72);
  const asset = assetFor(existing);
  const projectRoot = await createProject(asset);
  const sourceFile = path.join(projectRoot, "new-page.png");
  const manifestPath = manifestPathFor(projectRoot);

  try {
    await writeFile(sourceFile, uploaded);
    const before = await readFile(manifestPath);

    await assert.rejects(
      () =>
        pushPageBase({
          projectRoot,
          chapter: "01-agent-loop",
          page: "02",
          version: "v2",
          sourceFile,
          remote: "story-drive:",
          runRemoteCommand: async () => {
            throw new Error("upload denied");
          },
        }),
      /upload denied/,
    );

    assert.deepEqual(await readFile(manifestPath), before);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("runRclone passes each argument directly to the executable without shell parsing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "story-rclone-"));
  const executable = path.join(directory, "rclone");
  const outputFile = path.join(directory, "args.json");
  const originalPath = process.env.PATH;
  const originalOutputFile = process.env.STORY_TEST_RCLONE_ARGS;

  try {
    await writeFile(
      executable,
      "#!/usr/bin/env node\n" +
        "await import('node:fs/promises').then(({ writeFile }) => " +
        "writeFile(process.env.STORY_TEST_RCLONE_ARGS, JSON.stringify(process.argv.slice(2))))\n",
      "utf8",
    );
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
    process.env.STORY_TEST_RCLONE_ARGS = outputFile;

    const args = [
      "copyto",
      "story-drive:path with spaces;still-one-argument",
      "/cache path/page.png",
      "--no-traverse",
    ];
    await runRclone(args);

    assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), args);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalOutputFile === undefined) delete process.env.STORY_TEST_RCLONE_ARGS;
    else process.env.STORY_TEST_RCLONE_ARGS = originalOutputFile;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runRclone rejects a non-zero rclone exit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "story-rclone-"));
  const executable = path.join(directory, "rclone");
  const originalPath = process.env.PATH;

  try {
    await writeFile(executable, "#!/bin/sh\nexit 7\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;

    await assert.rejects(() => runRclone(["copyto"]), /exit.*7|code.*7/i);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("assets CLI pull downloads the selected page through the injected runner", async () => {
  const downloaded = pngFixture();
  const asset = assetFor(downloaded);
  const projectRoot = await createProject(asset);
  const stdout = captureOutput();
  const stderr = captureOutput();

  try {
    const status = await runAssetsCli({
      argv: ["pull", "--chapter", "01-agent-loop", "--page", "02"],
      cwd: projectRoot,
      env: { STORY_RCLONE_REMOTE: "story-drive:" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      runRemoteCommand: async (args) => {
        await writeFile(args[2], downloaded);
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(await readFile(cachePathFor(projectRoot, asset)), downloaded);
    assert.equal(stderr.read(), "");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("assets CLI verify checks local caches without requiring a remote", async () => {
  const downloaded = pngFixture();
  const asset = assetFor(downloaded);
  const projectRoot = await createProject(asset);
  const cachePath = cachePathFor(projectRoot, asset);
  const stdout = captureOutput();
  const stderr = captureOutput();

  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, downloaded);

    const status = await runAssetsCli({
      argv: ["verify", "--chapter", "01-agent-loop"],
      cwd: projectRoot,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(status, 0);
    assert.match(stdout.read(), /verified.*02|02.*verified/i);
    assert.equal(stderr.read(), "");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("assets CLI push requires all push options and updates the manifest", async () => {
  const existing = pngFixture();
  const uploaded = pngFixture(48, 72);
  const asset = assetFor(existing);
  const projectRoot = await createProject(asset);
  const sourceFile = path.join(projectRoot, "new-page.png");
  const stdout = captureOutput();
  const stderr = captureOutput();

  try {
    await writeFile(sourceFile, uploaded);
    const status = await runAssetsCli({
      argv: [
        "push",
        "--chapter",
        "01-agent-loop",
        "--page",
        "02",
        "--version",
        "v2",
        "--source",
        sourceFile,
      ],
      cwd: projectRoot,
      env: { STORY_RCLONE_REMOTE: "story-drive:" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      runRemoteCommand: async () => {},
    });

    assert.equal(status, 0);
    const manifest = JSON.parse(await readFile(manifestPathFor(projectRoot), "utf8"));
    assert.equal(
      manifest.pages["02"].base.remotePath,
      "chapters/01-agent-loop/bases/page-02-base-v2.png",
    );
    assert.equal(stderr.read(), "");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("assets CLI treats one leading pnpm delimiter as equivalent for every command", async (t) => {
  const fixture = pngFixture();

  for (const command of ["pull", "verify", "push"]) {
    await t.test(command, async () => {
      const asset = assetFor(fixture);
      const projectRoot = await createProject(asset);
      const cachePath = cachePathFor(projectRoot, asset);
      const sourceFile = path.join(projectRoot, "new-page.png");
      const args = command === "push"
        ? [
            command,
            "--chapter",
            "01-agent-loop",
            "--page",
            "02",
            "--version",
            "v2",
            "--source",
            sourceFile,
          ]
        : [command, "--chapter", "01-agent-loop", "--page", "02"];
      const env = command === "verify"
        ? {}
        : { STORY_RCLONE_REMOTE: "story-drive:" };

      try {
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, fixture);
        await writeFile(sourceFile, fixture);

        const direct = await invokeAssetsCli({
          argv: args,
          projectRoot,
          env,
          runRemoteCommand: async () => {},
        });
        const delimited = await invokeAssetsCli({
          argv: [args[0], "--", ...args.slice(1)],
          projectRoot,
          env,
          runRemoteCommand: async () => {},
        });

        assert.equal(direct.status, 0);
        assert.deepEqual(delimited, direct);
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    });
  }
});

test("assets CLI continues to reject a bare delimiter outside the leading token position", async () => {
  const fixture = pngFixture();
  const projectRoot = await createProject(assetFor(fixture));

  try {
    const result = await invokeAssetsCli({
      argv: ["verify", "--chapter", "01-agent-loop", "--"],
      projectRoot,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid option.*--|unsupported option.*--/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("assets CLI reports actionable setup instructions and a non-zero status without a remote", async () => {
  const downloaded = pngFixture();
  const projectRoot = await createProject(assetFor(downloaded));
  const stdout = captureOutput();
  const stderr = captureOutput();

  try {
    const status = await runAssetsCli({
      argv: ["pull", "--chapter", "01-agent-loop"],
      cwd: projectRoot,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.notEqual(status, 0);
    assert.match(stderr.read(), /rclone config/);
    assert.match(stderr.read(), /STORY_RCLONE_REMOTE/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("assets CLI rejects local-path and option-like rclone remotes before invoking rclone", async (t) => {
  const downloaded = pngFixture();
  const asset = assetFor(downloaded);
  const projectRoot = await createProject(asset);

  try {
    for (const remote of ["story-drive", "story-drive:subdir/", "--config=evil:"]) {
      await t.test(remote, async () => {
        let runnerCalls = 0;
        const result = await invokeAssetsCli({
          argv: ["pull", "--chapter", "01-agent-loop", "--page", "02"],
          projectRoot,
          env: { STORY_RCLONE_REMOTE: remote },
          runRemoteCommand: async () => {
            runnerCalls += 1;
          },
        });

        assert.equal(result.status, 1);
        assert.equal(runnerCalls, 0);
        assert.match(result.stderr, /remote.*name.*colon|name.*colon.*remote/i);
      });
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("assets CLI reports actionable installation instructions when rclone is missing", async () => {
  const downloaded = pngFixture();
  const projectRoot = await createProject(assetFor(downloaded));
  const stdout = captureOutput();
  const stderr = captureOutput();

  try {
    const status = await runAssetsCli({
      argv: ["pull", "--chapter", "01-agent-loop", "--page", "02"],
      cwd: projectRoot,
      env: { STORY_RCLONE_REMOTE: "story-drive:" },
      stdout: stdout.stream,
      stderr: stderr.stream,
      runRemoteCommand: async () => {
        const error = new Error("spawn rclone ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    });

    assert.notEqual(status, 0);
    assert.match(stderr.read(), /install.*rclone|rclone.*install/i);
    assert.match(stderr.read(), /rclone config/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
