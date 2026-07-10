import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { grepSearch } from "../../src/tools/grep-search.ts";

test("grep_search 返回匹配行的路径和行号", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-grep-search-"));

  try {
    const filePath = join(dir, "hello.ts");
    writeFileSync(filePath, "const name = 'Agent';\nconsole.log(name);");

    const result = grepSearch({ pattern: "Agent", path: dir });

    assert.equal(result, `${filePath}:1:const name = 'Agent';`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep_search 使用 include 限制文件类型", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-grep-search-"));

  try {
    const tsPath = join(dir, "hello.ts");
    const mdPath = join(dir, "hello.md");
    writeFileSync(tsPath, "Agent in ts");
    writeFileSync(mdPath, "Agent in md");

    const result = grepSearch({ pattern: "Agent", path: dir, include: "*.ts" });

    assert.equal(result, `${tsPath}:1:Agent in ts`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grep_search 没有匹配时返回提示", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-grep-search-"));

  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "hello.ts"), "hello");

    const result = grepSearch({ pattern: "missing", path: dir });

    assert.equal(result, "No matches found.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
