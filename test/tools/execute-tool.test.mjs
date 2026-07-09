import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { executeTool } from "../../src/tools/execute-tool.ts";
import { toolDefinitions, tools } from "../../src/tools/index.ts";

test("工具定义由工具对象派生且不暴露 execute", () => {
  const toolNames = tools.map((tool) => tool.name);
  const definitionNames = toolDefinitions.map((tool) => tool.name);

  assert.deepEqual(definitionNames, toolNames);
  assert.ok(tools.every((tool) => typeof tool.execute === "function"));
  assert.ok(toolDefinitions.every((tool) => !("execute" in tool)));
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
