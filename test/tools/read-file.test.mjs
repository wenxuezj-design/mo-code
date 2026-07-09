import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { readFile } from "../../src/tools/read-file.ts";

test("read_file 读取文件内容并添加行号", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-read-file-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "hello\nworld");

    const result = readFile({ file_path: filePath });

    assert.equal(result, "   1 | hello\n   2 | world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file 读取不存在的文件时返回错误信息", () => {
  const result = readFile({ file_path: "/path/that/does/not/exist.txt" });

  assert.match(result, /^Error reading file:/);
});
