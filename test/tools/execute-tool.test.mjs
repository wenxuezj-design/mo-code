import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  executeTool,
  isToolConcurrencySafe,
} from "../../src/tools/execute-tool.ts";
import { toolDefinitions, tools } from "../../src/tools/index.ts";

test("工具定义由工具对象派生且不暴露 execute", () => {
  const toolNames = tools.map((tool) => tool.name);
  const definitionNames = toolDefinitions.map((tool) => tool.name);

  assert.deepEqual(definitionNames, toolNames);
  assert.ok(tools.every((tool) => typeof tool.execute === "function"));
  assert.ok(toolDefinitions.every((tool) => {
    return Object.keys(tool).sort().join(",") === "description,input_schema,name";
  }));
});

test("executeTool 在执行工具前调用工具自己的 validateInput", async () => {
  const tool = tools.find((item) => item.name === "read_file");
  assert.ok(tool);

  const originalValidateInput = tool.validateInput;
  const originalExecute = tool.execute;
  let executed = false;

  try {
    tool.validateInput = () => ({ ok: false, message: "blocked by tool" });
    tool.execute = () => {
      executed = true;
      return "executed";
    };

    const result = await executeTool("read_file", {});

    assert.equal(result, "blocked by tool");
    assert.equal(executed, false);
  } finally {
    if (originalValidateInput) tool.validateInput = originalValidateInput;
    else delete tool.validateInput;
    tool.execute = originalExecute;
  }
});

test("文件修改工具各自提供 validateInput", () => {
  const writeFileTool = tools.find((tool) => tool.name === "write_file");
  const editFileTool = tools.find((tool) => tool.name === "edit_file");

  assert.equal(typeof writeFileTool?.validateInput, "function");
  assert.equal(typeof editFileTool?.validateInput, "function");
});

test("工具自己声明并发安全性，未声明和未知工具默认不安全", () => {
  for (const name of ["read_file", "list_files", "grep_search", "web_fetch"]) {
    const tool = tools.find((item) => item.name === name);
    assert.equal(typeof tool?.isConcurrencySafe, "function");
    assert.equal(isToolConcurrencySafe(name, {}), true);
  }

  for (const name of ["write_file", "edit_file", "run_shell", "unknown_tool"]) {
    assert.equal(isToolConcurrencySafe(name, {}), false);
  }
});

test("executeTool 截断过长的工具结果并保留头尾", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-execute-tool-"));

  try {
    const filePath = join(dir, "large.txt");
    writeFileSync(filePath, `start-${"x".repeat(60_000)}-end`);

    const result = await executeTool("read_file", { file_path: filePath });

    assert.ok(result.length <= 50_000);
    assert.match(result, /^ {3}1 \| start-/);
    assert.match(result, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
    assert.match(result, /-end$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file 成功后记录文件 mtimeMs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-read-state-"));
  const readFileState = new Map();

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "hello");

    await executeTool("read_file", { file_path: filePath }, { readFileState });

    assert.equal(readFileState.get(resolve(filePath)), statSync(filePath).mtimeMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file 修改已存在文件前必须先 read_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-write-guard-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "old");

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "new",
    }, { readFileState: new Map() });

    assert.equal(result, "Error: You must read this file before writing. Use read_file first.");
    assert.equal(readFileSync(filePath, "utf-8"), "old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file 未传 context 时也不能覆盖未读取的文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-default-write-guard-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "old");

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "new",
    });

    assert.equal(result, "Error: You must read this file before writing. Use read_file first.");
    assert.equal(readFileSync(filePath, "utf-8"), "old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit_file 修改已存在文件前必须先 read_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-edit-guard-"));

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "hello old");

    const result = await executeTool("edit_file", {
      file_path: filePath,
      old_string: "old",
      new_string: "new",
    }, { readFileState: new Map() });

    assert.equal(result, "Error: You must read this file before editing. Use read_file first.");
    assert.equal(readFileSync(filePath, "utf-8"), "hello old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file 创建新文件时不需要先 read_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-new-write-"));
  const readFileState = new Map();

  try {
    const filePath = join(dir, "new.txt");

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "new",
    }, { readFileState });

    assert.equal(result, `Successfully wrote to ${filePath}`);
    assert.equal(readFileSync(filePath, "utf-8"), "new");
    assert.equal(readFileState.get(resolve(filePath)), statSync(filePath).mtimeMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件读取后被外部修改时拒绝 write_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-external-write-"));
  const readFileState = new Map();

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "old");
    await executeTool("read_file", { file_path: filePath }, { readFileState });

    writeFileSync(filePath, "external");
    const changedTime = new Date(statSync(filePath).mtimeMs + 5000);
    utimesSync(filePath, changedTime, changedTime);

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "agent",
    }, { readFileState });

    assert.equal(result, `Warning: ${filePath} was modified externally since your last read. Please read_file again before writing.`);
    assert.equal(readFileSync(filePath, "utf-8"), "external");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
