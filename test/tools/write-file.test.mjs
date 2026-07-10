import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { writeFile } from "../../src/tools/write-file.ts";

test("write_file 创建父目录并写入文件内容", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-write-file-"));

  try {
    const filePath = join(dir, "nested", "hello.txt");

    const result = writeFile({ file_path: filePath, content: "hello\nworld" });

    assert.equal(result, `Successfully wrote to ${filePath}`);
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, "utf-8"), "hello\nworld");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
