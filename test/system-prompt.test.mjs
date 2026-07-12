import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_PROMPT_TEMPLATE } from "../src/system-prompt.ts";

const documentPath = fileURLToPath(
  new URL("../docs/notes/0.3 System Prompt工程.md", import.meta.url),
);

test("SYSTEM_PROMPT_TEMPLATE 与文档中的静态模板保持一致", () => {
  const document = readFileSync(documentPath, "utf-8");
  const tick = String.fromCharCode(96);
  const startMarker = "export const SYSTEM_PROMPT_TEMPLATE = " + tick;
  const start = document.indexOf(startMarker);
  const end = document.indexOf(tick + ";\n" + tick.repeat(3), start + startMarker.length);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.equal(
    SYSTEM_PROMPT_TEMPLATE,
    document.slice(start + startMarker.length, end),
  );
});

test("buildSystemPrompt 组装静态缓存块和动态环境块", async () => {
  const promptModule = await import("../src/system-prompt.ts");

  assert.equal(typeof promptModule.buildSystemPrompt, "function");

  const prompt = promptModule.buildSystemPrompt("baseline prompt");
  assert.deepEqual(prompt[0], {
    type: "text",
    text: "baseline prompt",
    cache_control: { type: "ephemeral" },
  });
  assert.equal(prompt[1].type, "text");
  assert.match(prompt[1].text, /# Environment/);
  assert.match(prompt[1].text, new RegExp(`Working directory: ${escapeRegExp(process.cwd())}`));
  assert.match(prompt[1].text, new RegExp(`Platform: ${os.platform()} ${os.arch()}`));
});

test("动态能力占位模块提供空文本", async () => {
  const modules = [
    ["../src/memory/deferred.ts", "buildMemoryPromptSection"],
    ["../src/skills/deferred.ts", "buildSkillDescriptions"],
    ["../src/subagent/deferred.ts", "buildAgentDescriptions"],
  ];

  for (const [modulePath, exportName] of modules) {
    let loaded;
    try {
      loaded = await import(modulePath);
    } catch {}

    assert.equal(typeof loaded?.[exportName], "function");
    assert.equal(loaded[exportName](), "");
  }
});

test("loadProjectInstructions 按父子顺序加载项目指令、include 和规则", async () => {
  const promptModule = await import("../src/system-prompt.ts");
  assert.equal(typeof promptModule.loadProjectInstructions, "function");

  const originalCwd = process.cwd();
  const root = mkdtempSync(join(os.tmpdir(), "mo-code-prompt-"));
  const project = join(root, "project");
  const workingDirectory = join(project, "nested");
  const rulesDirectory = join(workingDirectory, ".claude", "rules");

  mkdirSync(rulesDirectory, { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "root instructions\n@./shared.md");
  writeFileSync(join(root, "shared.md"), "shared instructions");
  writeFileSync(join(project, "CLAUDE.md"), "project instructions");
  writeFileSync(join(rulesDirectory, "b.md"), "rule b");
  writeFileSync(join(rulesDirectory, "a.md"), "rule a");

  try {
    process.chdir(workingDirectory);
    const result = promptModule.loadProjectInstructions();

    assert.match(result, /# Project Instructions \(CLAUDE\.md\)/);
    assert.match(result, /shared instructions/);
    assert.ok(result.indexOf("root instructions") < result.indexOf("project instructions"));
    assert.ok(result.indexOf("rule a") < result.indexOf("rule b"));
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadProjectInstructions 向上加载 Rules", async () => {
  const promptModule = await import("../src/system-prompt.ts");
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(os.tmpdir(), "mo-code-prompt-rules-"));
  const project = join(root, "project");
  const workingDirectory = join(project, "nested");
  const projectRulesDirectory = join(project, ".claude", "rules");
  const localRulesDirectory = join(workingDirectory, ".claude", "rules");

  mkdirSync(projectRulesDirectory, { recursive: true });
  mkdirSync(localRulesDirectory, { recursive: true });
  writeFileSync(join(projectRulesDirectory, "project.md"), "project rule");
  writeFileSync(join(localRulesDirectory, "local.md"), "local rule");

  try {
    process.chdir(workingDirectory);
    const result = promptModule.loadProjectInstructions();

    assert.match(result, /project rule/);
    assert.match(result, /local rule/);
    assert.ok(result.indexOf("project rule") < result.indexOf("local rule"));
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadProjectInstructions 递归加载 Rules", async () => {
  const promptModule = await import("../src/system-prompt.ts");
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(os.tmpdir(), "mo-code-prompt-nested-rules-"));
  const workingDirectory = join(root, "project");
  const nestedRulesDirectory = join(
    workingDirectory,
    ".claude",
    "rules",
    "typescript",
  );

  mkdirSync(nestedRulesDirectory, { recursive: true });
  writeFileSync(join(nestedRulesDirectory, "testing.md"), "nested rule");

  try {
    process.chdir(workingDirectory);
    const result = promptModule.loadProjectInstructions();

    assert.match(result, /nested rule/);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadProjectInstructions 在单个 Rule 读取失败时继续加载", async () => {
  const promptModule = await import("../src/system-prompt.ts");
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(os.tmpdir(), "mo-code-prompt-broken-rule-"));
  const rulesDirectory = join(root, ".claude", "rules");
  const directoryTarget = join(root, "directory-target");

  mkdirSync(rulesDirectory, { recursive: true });
  mkdirSync(directoryTarget);
  writeFileSync(join(root, "CLAUDE.md"), "project instructions");
  writeFileSync(join(rulesDirectory, "good.md"), "good rule");
  symlinkSync(directoryTarget, join(rulesDirectory, "bad.md"), "dir");

  try {
    process.chdir(root);
    const result = promptModule.loadProjectInstructions();

    assert.match(result, /project instructions/);
    assert.match(result, /good rule/);
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildUserContextReminder 使用本地日期", async () => {
  const promptModule = await import("../src/system-prompt.ts");
  assert.equal(typeof promptModule.buildUserContextReminder, "function");

  const now = new Date();
  const expectedDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const reminder = promptModule.buildUserContextReminder();

  assert.match(reminder, /^<system-reminder>/);
  assert.match(reminder, new RegExp(`Today's date is ${expectedDate}\\.`));
  assert.match(reminder, /<\/system-reminder>$/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
