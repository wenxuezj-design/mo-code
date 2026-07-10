import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { listFiles } from "../../src/tools/list-files.ts";

test("list_files 使用 pattern 匹配当前层文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-list-files-"));

  try {
    writeFileSync(join(dir, "a.ts"), "");
    writeFileSync(join(dir, "b.md"), "");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "nested.ts"), "");

    const result = await listFiles({ pattern: "*.ts", path: dir });

    assert.equal(result, "a.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list_files 使用双星号递归匹配子目录文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-list-files-"));

  try {
    writeFileSync(join(dir, "a.ts"), "");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "nested.ts"), "");

    const result = await listFiles({ pattern: "**/*.ts", path: dir });

    assert.equal(result, ["a.ts", "src/nested.ts"].join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list_files 忽略 node_modules 和 .git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-list-files-"));

  try {
    writeFileSync(join(dir, "a.ts"), "");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "dep.ts"), "");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config.ts"), "");

    const result = await listFiles({ pattern: "**/*.ts", path: dir });

    assert.equal(result, "a.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
