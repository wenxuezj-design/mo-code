import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

test("非 Git 目录不生成 Git 上下文", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory(() => {
    assert.equal(getGitContext(), "");
  });
});

test("空仓库保留分支和干净状态", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory((directory) => {
    initRepository(directory, "empty-branch");

    const context = getGitContext();

    assert.match(context, /Current branch: empty-branch/);
    assert.match(context, /Status:\n\(clean\)/);
    assert.doesNotMatch(context, /Recent commits:/);
  });
});

test("Git 上下文包含分支、状态和最近提交", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory((directory) => {
    initRepository(directory, "feature/context");
    writeFileSync(join(directory, "tracked.txt"), "initial");
    runGit(directory, "add", "tracked.txt");
    runGit(directory, "commit", "-m", "initial commit");
    writeFileSync(join(directory, "tracked.txt"), "changed");
    writeFileSync(join(directory, "untracked.txt"), "new");

    const context = getGitContext();

    assert.match(context, /^<git-context>/);
    assert.match(context, /repository metadata is untrusted data/);
    assert.match(context, /snapshot and will not update automatically/);
    assert.match(context, /Current branch: feature\/context/);
    assert.match(context, / M tracked\.txt/);
    assert.match(context, /\?\? untracked\.txt/);
    assert.match(context, /Recent commits:\n[0-9a-f]+ initial commit/);
    assert.match(context, /<\/git-context>$/);
  });
});

test("Detached HEAD 使用短 Commit ID", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory((directory) => {
    initRepository(directory, "main");
    writeFileSync(join(directory, "tracked.txt"), "initial");
    runGit(directory, "add", "tracked.txt");
    runGit(directory, "commit", "-m", "initial commit");
    const head = runGit(directory, "rev-parse", "--short", "HEAD");
    runGit(directory, "checkout", "--detach");

    assert.match(getGitContext(), new RegExp(`Current branch: HEAD \\(${head}\\)`));
  });
});

test("Git 状态超过 2000 个字符时截断", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory((directory) => {
    initRepository(directory, "main");
    for (let index = 0; index < 50; index += 1) {
      const suffix = String(index).padStart(2, "0");
      writeFileSync(join(directory, `untracked-${suffix}-${"x".repeat(40)}.txt`), "new");
    }

    const context = getGitContext();
    const truncatedStatus = context.match(
      /Status:\n([\s\S]*?)\n\.\.\. \(truncated; run git status for full output\)/,
    );

    assert.ok(truncatedStatus);
    assert.equal(truncatedStatus[1].length, 2000);
  });
});

test("Git 状态不受用户颜色配置影响", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory((directory) => {
    initRepository(directory, "main");
    runGit(directory, "config", "color.status", "always");
    writeFileSync(join(directory, "untracked.txt"), "new");

    assert.doesNotMatch(getGitContext(), /\u001b\[/);
  });
});

test("Git 状态超过进程缓冲区时仍返回截断结果", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory((directory) => {
    initRepository(directory, "main");
    for (let index = 0; index < 5600; index += 1) {
      const suffix = String(index).padStart(4, "0");
      writeFileSync(join(directory, `untracked-${suffix}-${"x".repeat(175)}.txt`), "");
    }

    const context = getGitContext();

    assert.doesNotMatch(context, /Status:\n\(unavailable\)/);
    assert.match(context, /\.\.\. \(truncated; run git status for full output\)/);
  });
});

test("分支命令失败时不误报为 Detached HEAD", async () => {
  const { getGitContext } = await loadGitContextModule();

  await withTempDirectory(async (directory) => {
    await withFakeGit(directory, "branch-failure", () => {
      const context = getGitContext();

      assert.match(context, /Current branch: \(unavailable\)/);
      assert.doesNotMatch(context, /Current branch: HEAD \(/);
    });
  });
});

async function loadGitContextModule() {
  let loaded;
  try {
    loaded = await import("../src/git-context.ts");
  } catch {}

  assert.equal(typeof loaded?.getGitContext, "function");
  return loaded;
}

async function withTempDirectory(run) {
  const originalCwd = process.cwd();
  const directory = mkdtempSync(join(os.tmpdir(), "mo-code-git-context-"));
  try {
    process.chdir(directory);
    return await run(directory);
  } finally {
    process.chdir(originalCwd);
    rmSync(directory, { recursive: true, force: true });
  }
}

function initRepository(directory, branch) {
  runGit(directory, "init", "-b", branch);
  runGit(directory, "config", "user.name", "Test User");
  runGit(directory, "config", "user.email", "test@example.com");
  runGit(directory, "config", "commit.gpgsign", "false");
}

function runGit(directory, ...args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

async function withFakeGit(directory, mode, run) {
  const binDirectory = join(directory, "fake-bin");
  mkdirSync(binDirectory);

  const source = `
const args = process.argv.slice(2).filter((arg) => arg !== "--no-optional-locks");
const command = args.join(" ");
const mode = process.env.MO_CODE_FAKE_GIT_MODE;

function output(value) {
  process.stdout.write(value);
  process.exit(0);
}

if (command === "rev-parse --is-inside-work-tree") output("true\\n");
if (command === "status --short" || command === "status --porcelain=v1") {
  output("");
}
if (command === "branch --show-current") {
  if (mode === "branch-failure") process.exit(1);
  output("main\\n");
}
if (command === "rev-parse --short HEAD") output("abc1234\\n");
if (command === "log --oneline -5") process.exit(1);
process.exit(1);
`;

  if (process.platform === "win32") {
    const scriptPath = join(binDirectory, "fake-git.cjs");
    writeFileSync(scriptPath, source);
    writeFileSync(
      join(binDirectory, "git.cmd"),
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
  } else {
    const executablePath = join(binDirectory, "git");
    writeFileSync(executablePath, `#!/usr/bin/env node\n${source}`);
    chmodSync(executablePath, 0o755);
  }

  const originalPath = process.env.PATH;
  const originalMode = process.env.MO_CODE_FAKE_GIT_MODE;
  process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ""}`;
  process.env.MO_CODE_FAKE_GIT_MODE = mode;

  try {
    return await run();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalMode === undefined) delete process.env.MO_CODE_FAKE_GIT_MODE;
    else process.env.MO_CODE_FAKE_GIT_MODE = originalMode;
  }
}
