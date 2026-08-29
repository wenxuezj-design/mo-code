import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeShellCommand } from "../../src/tools/shell-command-semantics.ts";

function semanticsOf(command) {
  return analyzeShellCommand(command).semantics;
}

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
    assert.equal(semanticsOf(command), "readOnly", command);
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
    assert.equal(semanticsOf(command), "mutating", command);
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
    assert.equal(semanticsOf(command), "unknown", command);
  }
});

test("复合命令只有全部只读时才是 readOnly", () => {
  assert.equal(semanticsOf("pwd && git status"), "readOnly");
  assert.equal(semanticsOf("cat a | grep hello"), "readOnly");
  assert.equal(semanticsOf("pwd; ls\ngit status"), "readOnly");
  assert.equal(semanticsOf("pwd && rm a"), "mutating");
  assert.equal(semanticsOf("pwd && custom-command"), "unknown");
});

test("引号和转义符中的运算符不会拆分命令", () => {
  assert.equal(semanticsOf("echo 'a && b | c'"), "readOnly");
  assert.equal(semanticsOf('printf "%s" "a; b"'), "readOnly");
  assert.equal(semanticsOf("echo a\\&b"), "readOnly");
  assert.equal(semanticsOf("echo '$(rm a)'"), "readOnly");
  assert.equal(semanticsOf("echo '$HOME *.ts {a,b}'"), "readOnly");
  assert.equal(semanticsOf("echo \\*.ts"), "readOnly");
});

test("重定向和复杂 Shell 语法保守分类", () => {
  assert.equal(semanticsOf("echo hello > output.txt"), "mutating");
  assert.equal(semanticsOf("echo hello 2>&1"), "mutating");
  assert.equal(semanticsOf("cat < input.txt"), "unknown");
  assert.equal(semanticsOf('echo "$(rm a)"'), "unknown");
  assert.equal(semanticsOf('echo "$HOME"'), "unknown");
  assert.equal(semanticsOf("echo `pwd`"), "unknown");
  assert.equal(semanticsOf("(pwd)"), "unknown");
  assert.equal(semanticsOf("pwd &&"), "unknown");
  assert.equal(semanticsOf("echo 'unfinished"), "unknown");
});

test("find 只放行不执行命令且不写文件的查询", () => {
  assert.equal(semanticsOf("find . -name '*.ts'"), "readOnly");
  assert.equal(semanticsOf("find . -delete"), "mutating");
  assert.equal(semanticsOf("find . -fprint results.txt"), "mutating");
  assert.equal(semanticsOf("find . -exec cat {} ';'"), "unknown");
  assert.equal(semanticsOf("find . -delet?"), "unknown");
  assert.equal(semanticsOf("find . -{delete,print}"), "unknown");
  assert.equal(semanticsOf('find . "-$ACTION"'), "unknown");
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
    assert.equal(semanticsOf(command), "readOnly", command);
  }

  assert.equal(semanticsOf("git branch feature/new"), "mutating");
  assert.equal(
    semanticsOf("git branch --list --edit-description"),
    "mutating",
  );
  assert.equal(semanticsOf("git tag v1.0.0"), "mutating");
  assert.equal(semanticsOf("git push origin main"), "mutating");
  assert.equal(semanticsOf("git diff --output=changes.patch"), "mutating");
  assert.equal(semanticsOf("git diff --out=changes.patch"), "mutating");
  assert.equal(semanticsOf("git diff --ext-diff"), "unknown");
  assert.equal(semanticsOf("git diff --ext-di"), "unknown");
  assert.equal(semanticsOf("git show --textc HEAD"), "unknown");
  assert.equal(semanticsOf("git grep -O less pattern"), "unknown");
  assert.equal(
    semanticsOf("git grep --open-files='sh -c touch' pattern"),
    "unknown",
  );
  assert.equal(semanticsOf("git remote show -n origin --unknown"), "unknown");
  assert.equal(semanticsOf("git -C .. status"), "unknown");
});

test("一次分析读命令的字面路径", () => {
  assert.deepEqual(analyzeShellCommand("cat package.json"), {
    semantics: "readOnly",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: "package.json", operation: "read" }],
    },
  });
  assert.deepEqual(analyzeShellCommand("ls -la"), {
    semantics: "readOnly",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: ".", operation: "read" }],
    },
  });
  assert.deepEqual(analyzeShellCommand("grep -r todo src"), {
    semantics: "readOnly",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: "src", operation: "read" }],
    },
  });
  assert.deepEqual(analyzeShellCommand("rg --files src"), {
    semantics: "readOnly",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: "src", operation: "read" }],
    },
  });
  assert.deepEqual(analyzeShellCommand("find . -name '*.ts'"), {
    semantics: "readOnly",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: ".", operation: "read" }],
    },
  });
  assert.deepEqual(analyzeShellCommand("find -- /tmp -maxdepth 0"), {
    semantics: "readOnly",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: "/tmp", operation: "read" }],
    },
  });
  for (const command of [
    "ls -I /etc",
    "ls -T /etc",
    "ls -w /etc",
    "ls --color /etc",
    "stat -f /etc",
    "stat -t /etc",
  ]) {
    assert.deepEqual(analyzeShellCommand(command).filesystemAccesses, {
      status: "known",
      accesses: [{ path: "/etc", operation: "read" }],
    }, command);
  }
  assert.deepEqual(analyzeShellCommand("du --time /etc").filesystemAccesses, {
    status: "unknown",
  });
});

test("一次分析修改命令中的源路径和目标路径", () => {
  assert.deepEqual(analyzeShellCommand("cp source.txt output.txt"), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "known",
      accesses: [
        { path: "source.txt", operation: "read" },
        { path: "output.txt", operation: "write" },
      ],
    },
  });
  assert.deepEqual(analyzeShellCommand("mv old.txt new.txt"), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "known",
      accesses: [
        { path: "old.txt", operation: "delete" },
        { path: "new.txt", operation: "write" },
      ],
    },
  });
  assert.deepEqual(analyzeShellCommand("mkdir build && touch build/result.txt"), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "known",
      accesses: [
        { path: "build", operation: "write" },
        { path: "build/result.txt", operation: "write" },
      ],
    },
  });
});

test("递归删除保留标记并展开未引用的 Home 目录", () => {
  assert.deepEqual(analyzeShellCommand("rm -rf /"), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "unknown",
      accesses: [{ path: "/", operation: "delete", recursive: true }],
    },
  });
  assert.deepEqual(analyzeShellCommand("rm -rf ~ ~/cache"), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "unknown",
      accesses: [
        { path: homedir(), operation: "delete", recursive: true },
      ],
    },
  });
  assert.deepEqual(analyzeShellCommand("rm -rf '~'"), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: "~", operation: "delete", recursive: true }],
    },
  });
});

test("支持命令的动态路径和无法确定的 find 操作返回 unknown", () => {
  for (const command of [
    'rm -rf "$TARGET"',
    "cp $(get_source) output.txt",
    "ls *.ts",
    "find . -delete",
    "find . -exec cat {} ';'",
  ]) {
    assert.deepEqual(
      analyzeShellCommand(command).filesystemAccesses,
      { status: "unknown" },
      command,
    );
  }
});

test("find -delete 保留 root 和 Home 的灾难删除事实", () => {
  for (const command of [
    "find / -delete",
    "find -X / -delete",
    "/usr/bin/find / -delete",
  ]) {
    assert.deepEqual(analyzeShellCommand(command), {
      semantics: "mutating",
      filesystemAccesses: {
        status: "unknown",
        accesses: [{ path: "/", operation: "delete", recursive: true }],
      },
    }, command);
  }
  for (const command of ["find ~ -delete", 'find -d "$HOME" -delete']) {
    assert.deepEqual(analyzeShellCommand(command), {
      semantics: command.includes("HOME") ? "unknown" : "mutating",
      filesystemAccesses: {
        status: "unknown",
        accesses: [{ path: homedir(), operation: "delete", recursive: true }],
      },
    }, command);
  }
});

test("潜在路径命令区分无路径和带路径形式", () => {
  assert.deepEqual(analyzeShellCommand("wc -l"), { semantics: "readOnly" });
  assert.deepEqual(analyzeShellCommand("df -h"), { semantics: "readOnly" });
  assert.deepEqual(analyzeShellCommand("wc -l package.json"), {
    semantics: "readOnly",
    filesystemAccesses: { status: "unknown" },
  });
  assert.deepEqual(analyzeShellCommand("du /tmp"), {
    semantics: "readOnly",
    filesystemAccesses: { status: "unknown" },
  });
});

test("未支持的命令不伪造文件系统分析结果", () => {
  assert.deepEqual(analyzeShellCommand("node script.js"), {
    semantics: "unknown",
  });
  assert.deepEqual(analyzeShellCommand("pwd && git status"), {
    semantics: "readOnly",
  });
});

test("修改型复合命令只有全部受支持时才返回 known", () => {
  for (const command of [
    "git push; touch marker",
    "cd /tmp && touch marker",
    "git status && touch marker",
  ]) {
    assert.deepEqual(analyzeShellCommand(command).filesystemAccesses, {
      status: "unknown",
    }, command);
  }

  assert.deepEqual(analyzeShellCommand("pwd && cat package.json"), {
    semantics: "readOnly",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: "package.json", operation: "read" }],
    },
  });
});

test("不完整分析仍保留可确定的灾难删除事实", (t) => {
  for (const command of [
    "rm -rf / > deletion.log",
    "rm -rf /; git push",
    "/bin/rm -rf / > deletion.log",
    "2>/dev/null rm -rf /",
    "X=1 rm -rf /",
    'rm -rfx "$HOME"',
    'rm --rec "$HOME"',
    "rm -rf --no-preserve-root /",
    "rm \\\n-rf /",
    "echo \\' ; rm \\\n-rf /",
    'rm -rf "$HOME" > deletion.log',
    "rm -rf ${HOME} > deletion.log",
  ]) {
    assert.deepEqual(analyzeShellCommand(command).filesystemAccesses, {
      status: "unknown",
      accesses: [{
        path: command.includes("HOME") ? homedir() : "/",
        operation: "delete",
        recursive: true,
      }],
    }, command);
  }

  const cwd = mkdtempSync(join(tmpdir(), "mo-code-shell-fuse-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  symlinkSync("/", join(cwd, "root-link"), "dir");
  assert.deepEqual(
    analyzeShellCommand("rm -rf root-link > deletion.log", cwd)
      .filesystemAccesses,
    {
      status: "unknown",
      accesses: [{ path: "root-link", operation: "delete", recursive: true }],
    },
  );
});

test("cp 和 mv 识别已存在目录中的最终写入文件", () => {
  assert.deepEqual(analyzeShellCommand("cp nested/AGENTS.md ."), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "known",
      accesses: [
        { path: "nested/AGENTS.md", operation: "read" },
        { path: "AGENTS.md", operation: "write" },
      ],
    },
  });
  assert.deepEqual(analyzeShellCommand("mv nested/CLAUDE.md ."), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "known",
      accesses: [
        { path: "nested/CLAUDE.md", operation: "delete" },
        { path: "CLAUDE.md", operation: "write" },
      ],
    },
  });

  for (const command of [
    "cp a b .",
    "cp -t . source.txt",
    "cp --parents nested/file.txt .",
    "mv a b .",
  ]) {
    assert.deepEqual(analyzeShellCommand(command).filesystemAccesses, {
      status: "unknown",
    }, command);
  }
});

test("目录级删除、复制和移动保守返回 unknown", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mo-code-shell-directory-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "source", ".git"), { recursive: true });
  mkdirSync(join(cwd, "target"));

  for (const command of [
    "rm -rf source",
    "rm -rf link/../source",
    "cp -r source target",
    "cp link/../source target",
    "mv source target",
    "mv link/../source target",
    "cp file.txt link/../target",
    "mv file.txt link/../target",
  ]) {
    assert.equal(
      analyzeShellCommand(command, cwd).filesystemAccesses?.status,
      "unknown",
      command,
    );
  }
});

test("路径型选项未纳入访问列表时保守返回 unknown", () => {
  for (const command of [
    "grep --exclude-from ../patterns todo src",
    "rg --ignore-file ../ignore todo src",
    "wc --files0-from ../files",
    "file --magic-file ../magic target",
    "du --exclude-from ../patterns .",
    "find . -newer ../stamp",
    "find -X /etc -prune",
    "find -f /etc",
    "find -D tree /etc",
  ]) {
    assert.deepEqual(analyzeShellCommand(command).filesystemAccesses, {
      status: "unknown",
    }, command);
  }
});

test("递归读取跟随内部符号链接时保守返回 unknown", () => {
  for (const command of [
    "rg --follow secret .",
    "rg -L secret .",
    "grep -R secret .",
    "find -L . -type f",
    "ls -RL .",
  ]) {
    assert.deepEqual(analyzeShellCommand(command).filesystemAccesses, {
      status: "unknown",
    }, command);
  }
  assert.deepEqual(analyzeShellCommand("find -L . -delete"), {
    semantics: "mutating",
    filesystemAccesses: {
      status: "unknown",
      catastrophicDeleteRisk: true,
    },
  });
});

test("跨平台可选参数不会吞掉后续路径", () => {
  assert.deepEqual(
    analyzeShellCommand("rg --block-buffered TODO /etc/passwd")
      .filesystemAccesses,
    {
      status: "known",
      accesses: [{ path: "/etc/passwd", operation: "read" }],
    },
  );
  assert.deepEqual(
    analyzeShellCommand("mkdir --context /tmp/mo-code-outside inside")
      .filesystemAccesses,
    {
      status: "known",
      accesses: [
        { path: "/tmp/mo-code-outside", operation: "write" },
        { path: "inside", operation: "write" },
      ],
    },
  );
});
