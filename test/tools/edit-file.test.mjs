import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { editFile } from "../../src/tools/edit-file.ts";

test("edit_file 替换唯一匹配的内容", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-edit-file-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "hello agent\nhello user");

    const result = editFile({
      file_path: filePath,
      old_string: "hello agent",
      new_string: "hi agent",
    });

    assert.equal(result, [
      `Successfully edited ${filePath}`,
      "",
      "@@ -1,1 +1,1 @@",
      "- hello agent",
      "+ hi agent",
    ].join("\n"));
    assert.equal(readFileSync(filePath, "utf-8"), "hi agent\nhello user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file 支持引号容错匹配并使用文件中的原始字符串替换", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-edit-file-"));

  try {
    const filePath = join(dir, "hello.ts");
    writeFileSync(filePath, "const msg = “hello”;");

    const result = editFile({
      file_path: filePath,
      old_string: 'const msg = "hello";',
      new_string: 'const msg = "world";',
    });

    assert.equal(result, [
      `Successfully edited ${filePath} (matched via quote normalization)`,
      "",
      "@@ -1,1 +1,1 @@",
      "- const msg = “hello”;",
      '+ const msg = "world";',
    ].join("\n"));
    assert.equal(readFileSync(filePath, "utf-8"), 'const msg = "world";');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file 找不到 old_string 时返回错误", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-edit-file-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "hello agent");

    const result = editFile({
      file_path: filePath,
      old_string: "missing",
      new_string: "hi",
    });

    assert.equal(result, `Error: old_string not found in ${filePath}`);
    assert.equal(readFileSync(filePath, "utf-8"), "hello agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file old_string 出现多次时返回错误", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-edit-file-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "hello\nhello");

    const result = editFile({
      file_path: filePath,
      old_string: "hello",
      new_string: "hi",
    });

    assert.equal(result, `Error: old_string found 2 times in ${filePath}. Must be unique.`);
    assert.equal(readFileSync(filePath, "utf-8"), "hello\nhello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file 标准化后 old_string 出现多次时返回错误", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-edit-file-"));

  try {
    const filePath = join(dir, "hello.ts");
    writeFileSync(filePath, 'const a = "hello";\nconst b = “hello”;');

    const result = editFile({
      file_path: filePath,
      old_string: '"hello"',
      new_string: '"world"',
    });

    assert.equal(result, `Error: old_string found 2 times in ${filePath}. Must be unique.`);
    assert.equal(readFileSync(filePath, "utf-8"), 'const a = "hello";\nconst b = “hello”;');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file old_string 为空时返回错误", () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-edit-file-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "hello");

    const result = editFile({
      file_path: filePath,
      old_string: "",
      new_string: "hi",
    });

    assert.equal(result, "Error: old_string must not be empty.");
    assert.equal(readFileSync(filePath, "utf-8"), "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
