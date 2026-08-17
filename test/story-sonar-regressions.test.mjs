import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPageApiRoot,
  parseEditorRoute,
} from "../docs/story/tools/lettering/lib/editor-route.mjs";
import {
  resolveRcloneExecutable,
} from "../docs/story/tools/lettering/lib/asset-sync.mjs";

test("editor route accepts the documented chapter and page", () => {
  assert.deepEqual(parseEditorRoute("?chapter=01-agent-loop&page=07"), {
    chapter: "01-agent-loop",
    page: "07",
  });
  assert.equal(
    buildPageApiRoot({ chapter: "01-agent-loop", page: "07" }),
    "/api/pages/01-agent-loop/07",
  );
});

test("editor route rejects query parameters that could change the request path", () => {
  assert.throws(
    () => parseEditorRoute("?chapter=..%2F..&page=01"),
    /invalid chapter/i,
  );
  assert.throws(
    () => parseEditorRoute("?chapter=01-agent-loop&page=01%2Flayout"),
    /invalid page/i,
  );
});

test("rclone executable must be configured with an absolute path", async () => {
  await assert.rejects(
    () => resolveRcloneExecutable({ env: { STORY_RCLONE_BIN: "rclone" } }),
    /absolute path/i,
  );
});

test("rclone executable accepts a trusted executable file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "story-rclone-bin-"));
  const executable = path.join(directory, process.platform === "win32" ? "rclone.exe" : "rclone");

  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    assert.equal(
      await resolveRcloneExecutable({ env: { STORY_RCLONE_BIN: executable } }),
      await realpath(executable),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
