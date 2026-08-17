import test from "node:test";
import assert from "node:assert/strict";

import { classifyShellCommand } from "../../src/tools/shell-command-semantics.ts";

test("识别常用只读命令", () => {
  for (const command of [
    "pwd",
    "ls -la src",
    "cat package.json",
    "head -n 10 README.md",
    "tail -f app.log",
    "grep -R todo src",
    "rg --files",
    "wc -l package.json",
    "which node",
    "file package.json",
    "stat package.json",
    "du -sh src",
    "df -h",
    "echo hello",
    "printf '%s' hello",
  ]) {
    assert.equal(classifyShellCommand(command), "readOnly", command);
  }
});

test("明确修改状态的命令返回 mutating", () => {
  for (const command of [
    "rm old.txt",
    "mv old.txt new.txt",
    "cp source.txt target.txt",
    "mkdir output",
    "touch created.txt",
    "file --compile magic",
    "file --comp -m magic",
    "printf -v result value",
    "printf -vPATH /tmp/bin && ls",
  ]) {
    assert.equal(classifyShellCommand(command), "mutating", command);
  }
});

test("未知命令、环境变量前缀和包装器返回 unknown", () => {
  for (const command of [
    "npm test",
    "pnpm test",
    "node script.js",
    "FOO=bar git status",
    "env FOO=bar git status",
    "timeout 10 git status",
    "sudo cat package.json",
    "sh -c 'git status'",
    "command git status",
    "rg --pre processor README.md",
    "rg --search-zip archive.gz",
    "rg -uz archive.gz",
  ]) {
    assert.equal(classifyShellCommand(command), "unknown", command);
  }
});

test("复合命令只有全部只读时才是 readOnly", () => {
  assert.equal(classifyShellCommand("pwd && git status"), "readOnly");
  assert.equal(classifyShellCommand("cat a | grep hello"), "readOnly");
  assert.equal(classifyShellCommand("pwd; ls\ngit status"), "readOnly");
  assert.equal(classifyShellCommand("pwd && rm a"), "mutating");
  assert.equal(classifyShellCommand("pwd && custom-command"), "unknown");
});

test("引号和转义符中的运算符不会拆分命令", () => {
  assert.equal(classifyShellCommand("echo 'a && b | c'"), "readOnly");
  assert.equal(classifyShellCommand('printf "%s" "a; b"'), "readOnly");
  assert.equal(classifyShellCommand("echo a\\&b"), "readOnly");
  assert.equal(classifyShellCommand("echo '$(rm a)'"), "readOnly");
  assert.equal(classifyShellCommand("echo '$HOME *.ts {a,b}'"), "readOnly");
  assert.equal(classifyShellCommand("echo \\*.ts"), "readOnly");
});

test("重定向和复杂 Shell 语法保守分类", () => {
  assert.equal(classifyShellCommand("echo hello > output.txt"), "mutating");
  assert.equal(classifyShellCommand("echo hello 2>&1"), "mutating");
  assert.equal(classifyShellCommand("cat < input.txt"), "unknown");
  assert.equal(classifyShellCommand('echo "$(rm a)"'), "unknown");
  assert.equal(classifyShellCommand('echo "$HOME"'), "unknown");
  assert.equal(classifyShellCommand("echo `pwd`"), "unknown");
  assert.equal(classifyShellCommand("(pwd)"), "unknown");
  assert.equal(classifyShellCommand("pwd &&"), "unknown");
  assert.equal(classifyShellCommand("echo 'unfinished"), "unknown");
});

test("find 只放行不执行命令且不写文件的查询", () => {
  assert.equal(classifyShellCommand("find . -name '*.ts'"), "readOnly");
  assert.equal(classifyShellCommand("find . -delete"), "mutating");
  assert.equal(classifyShellCommand("find . -fprint results.txt"), "mutating");
  assert.equal(classifyShellCommand("find . -exec cat {} ';'"), "unknown");
  assert.equal(classifyShellCommand("find . -delet?"), "unknown");
  assert.equal(classifyShellCommand("find . -{delete,print}"), "unknown");
  assert.equal(classifyShellCommand('find . "-$ACTION"'), "unknown");
});

test("Git 只放行明确的查询形式", () => {
  for (const command of [
    "git status --short",
    "git diff --stat",
    "git diff -- README.md",
    "git log -n 5",
    "git show HEAD",
    "git rev-parse HEAD",
    "git ls-files",
    "git branch",
    "git branch --list 'feature/*'",
    "git tag --list 'v*'",
    "git remote -v",
    "git remote get-url origin",
  ]) {
    assert.equal(classifyShellCommand(command), "readOnly", command);
  }

  assert.equal(classifyShellCommand("git branch feature/new"), "mutating");
  assert.equal(
    classifyShellCommand("git branch --list --edit-description"),
    "mutating",
  );
  assert.equal(classifyShellCommand("git tag v1.0.0"), "mutating");
  assert.equal(classifyShellCommand("git push origin main"), "mutating");
  assert.equal(classifyShellCommand("git diff --output=changes.patch"), "mutating");
  assert.equal(classifyShellCommand("git diff --out=changes.patch"), "mutating");
  assert.equal(classifyShellCommand("git diff --ext-diff"), "unknown");
  assert.equal(classifyShellCommand("git diff --ext-di"), "unknown");
  assert.equal(classifyShellCommand("git show --textc HEAD"), "unknown");
  assert.equal(classifyShellCommand("git grep -O less pattern"), "unknown");
  assert.equal(
    classifyShellCommand("git grep --open-files='sh -c touch' pattern"),
    "unknown",
  );
  assert.equal(classifyShellCommand("git remote show -n origin --unknown"), "unknown");
  assert.equal(classifyShellCommand("git -C .. status"), "unknown");
});
