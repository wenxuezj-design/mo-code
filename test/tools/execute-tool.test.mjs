import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PermissionGate } from "../../src/permissions/index.ts";
import {
  executeTool,
  isToolConcurrencySafe,
} from "../../src/tools/execute-tool.ts";
import { toolDefinitions } from "../../src/tools/index.ts";
import { tools } from "../../src/tools/registry.ts";

test("公共工具定义不暴露 execute", () => {
  assert.deepEqual(
    toolDefinitions.map((tool) => tool.name),
    [
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "grep_search",
      "run_shell",
      "web_fetch",
    ],
  );
  assert.ok(toolDefinitions.every((tool) => {
    return Object.keys(tool).sort().join(",") === "description,input_schema,name";
  }));
});

test("每个工具声明自己的权限类别", () => {
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.permissionKind])),
    {
      read_file: "read",
      write_file: "edit",
      edit_file: "edit",
      list_files: "read",
      grep_search: "read",
      run_shell: "shell",
      web_fetch: "network",
    },
  );
});

test("executeTool 把工具权限类别传给 PermissionGate", async () => {
  let receivedRequest;
  const permissionGate = new PermissionGate({
    policy: {
      evaluate(request) {
        receivedRequest = request;
        return { behavior: "allow" };
      },
    },
  });

  await executeTool("list_files", { pattern: "no-match-*" }, createContext({
    permissionGate,
  }));

  assert.equal(receivedRequest.toolName, "list_files");
  assert.equal(receivedRequest.permissionKind, "read");
});

test("executeTool 要求显式提供 PermissionGate", async () => {
  await assert.rejects(
    executeTool("read_file", {}),
    /ToolContext\.permissionGate is required/,
  );
});

test("executeTool 先校验输入，通过后才检查权限", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-validation-order-"));
  let permissionChecks = 0;
  const permissionGate = new PermissionGate({
    policy: {
      evaluate() {
        permissionChecks++;
        return { behavior: "deny", reason: "should not be reached" };
      },
    },
  });

  try {
    const filePath = join(dir, "existing.txt");
    writeFileSync(filePath, "old");

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "new",
    }, createContext({ permissionGate }));

    assert.deepEqual(result, {
      content: "Error: You must read this file before writing. Use read_file first.",
      isError: true,
    });
    assert.equal(permissionChecks, 0);
    assert.equal(readFileSync(filePath, "utf-8"), "old");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("工具自己声明并发安全性，未声明和未知工具默认不安全", () => {
  for (const name of ["read_file", "list_files", "grep_search", "web_fetch"]) {
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

    const result = await executeTool(
      "read_file",
      { file_path: filePath },
      createContext(),
    );

    assert.equal(result.isError, false);
    assert.ok(result.content.length <= 50_000);
    assert.match(result.content, /^ {3}1 \| start-/);
    assert.match(result.content, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
    assert.match(result.content, /-end$/);
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

    await executeTool(
      "read_file",
      { file_path: filePath },
      createContext({ readFileState }),
    );

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
    }, createContext());

    assert.deepEqual(result, {
      content: "Error: You must read this file before writing. Use read_file first.",
      isError: true,
    });
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
    }, createContext());

    assert.deepEqual(result, {
      content: "Error: You must read this file before editing. Use read_file first.",
      isError: true,
    });
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
    }, createContext({ readFileState }));

    assert.deepEqual(result, {
      content: `Successfully wrote to ${filePath}`,
      isError: false,
    });
    assert.equal(readFileSync(filePath, "utf-8"), "new");
    assert.equal(readFileState.get(resolve(filePath)), statSync(filePath).mtimeMs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件读取后被外部修改时拒绝 write_file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-external-write-"));
  const readFileState = new Map();
  const context = createContext({ readFileState });

  try {
    const filePath = join(dir, "hello.txt");
    writeFileSync(filePath, "old");
    await executeTool("read_file", { file_path: filePath }, context);

    writeFileSync(filePath, "external");
    const changedTime = new Date(statSync(filePath).mtimeMs + 5000);
    utimesSync(filePath, changedTime, changedTime);

    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "agent",
    }, context);

    assert.deepEqual(result, {
      content: `Warning: ${filePath} was modified externally since your last read. Please read_file again before writing.`,
      isError: true,
    });
    assert.equal(readFileSync(filePath, "utf-8"), "external");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未知工具返回结构化错误", async () => {
  const result = await executeTool("unknown_tool", {}, createContext());

  assert.deepEqual(result, {
    content: "Unknown tool: unknown_tool",
    isError: true,
  });
});

test("权限拒绝时不执行工具", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mo-code-permission-deny-"));
  const permissionGate = new PermissionGate({
    policy: {
      evaluate: () => ({ behavior: "deny", reason: "writes are blocked" }),
    },
  });

  try {
    const filePath = join(dir, "blocked.txt");
    const result = await executeTool("write_file", {
      file_path: filePath,
      content: "blocked",
    }, createContext({ permissionGate }));

    assert.deepEqual(result, {
      content: "Permission denied: writes are blocked",
      isError: true,
    });
    assert.equal(existsSync(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createContext(overrides = {}) {
  return {
    cwd: process.cwd(),
    permissionGate: new PermissionGate(),
    readFileState: new Map(),
    ...overrides,
  };
}
