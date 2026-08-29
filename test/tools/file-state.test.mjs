import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { recordFileState } from "../../src/tools/file-state.ts";

test("recordFileState 无法读取文件状态时返回警告", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-file-state-"));
  const filePath = join(dir, "missing.txt");

  try {
    const warning = recordFileState(filePath, {
      cwd: dir,
      readFileState: new Map(),
    });

    assert.equal(typeof warning, "string");
    assert.match(warning, new RegExp(`^Warning: Failed to record file state for ${filePath}:`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
