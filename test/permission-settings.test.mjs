import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  addLocalPermissionAllowRule,
  loadPermissionSettings,
} from "../src/permissions/permission-settings.ts";

const temporaryDirectories = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("没有配置文件时返回空设置", () => {
  const root = createTemporaryDirectory();

  assert.deepEqual(loadPermissionSettings({
    cwd: join(root, "project"),
    homeDir: join(root, "home"),
  }), { rules: [] });
});

test("加载用户级规则和默认模式并记录来源", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const cwd = join(root, "project");
  const sourcePath = join(homeDir, ".mo-code", "settings.json");
  writeJson(sourcePath, {
    permissions: {
      allow: ["read_file"],
      ask: ["run_shell(npm test*)"],
      deny: ["web_fetch"],
      defaultMode: "acceptEdits",
    },
  });

  assert.deepEqual(loadPermissionSettings({ cwd, homeDir }), {
    rules: [
      {
        behavior: "allow",
        raw: "read_file",
        sourceScope: "user",
        sourcePath,
      },
      {
        behavior: "ask",
        raw: "run_shell(npm test*)",
        sourceScope: "user",
        sourcePath,
      },
      {
        behavior: "deny",
        raw: "web_fetch",
        sourceScope: "user",
        sourcePath,
      },
    ],
    defaultMode: "acceptEdits",
    defaultModeSource: { sourceScope: "user", sourcePath },
  });
});

test("按 user、project、local 合并规则，后层默认模式覆盖前层", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const projectDir = join(root, "workspace", "project");
  const cwd = join(projectDir, "src", "nested");
  const userPath = join(homeDir, ".mo-code", "settings.json");
  const projectPath = join(projectDir, ".mo-code", "settings.json");
  const localPath = join(projectDir, ".mo-code", "settings.local.json");

  writeJson(userPath, {
    permissions: { allow: ["read_file"], defaultMode: "default" },
  });
  writeJson(projectPath, {
    permissions: { ask: ["run_shell"], defaultMode: "plan" },
  });
  writeJson(localPath, {
    permissions: { deny: ["web_fetch"], defaultMode: "dontAsk" },
  });

  assert.deepEqual(loadPermissionSettings({ cwd, homeDir }), {
    rules: [
      {
        behavior: "allow",
        raw: "read_file",
        sourceScope: "user",
        sourcePath: userPath,
      },
      {
        behavior: "ask",
        raw: "run_shell",
        sourceScope: "project",
        sourcePath: projectPath,
      },
      {
        behavior: "deny",
        raw: "web_fetch",
        sourceScope: "local",
        sourcePath: localPath,
      },
    ],
    defaultMode: "dontAsk",
    defaultModeSource: { sourceScope: "local", sourcePath: localPath },
  });
});

test("未信任项目只过滤项目侧 allow 和 defaultMode", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const projectDir = join(root, "workspace", "project");
  const cwd = join(projectDir, "src");
  const userPath = join(homeDir, ".mo-code", "settings.json");
  const projectPath = join(projectDir, ".mo-code", "settings.json");
  const localPath = join(projectDir, ".mo-code", "settings.local.json");

  writeJson(userPath, {
    permissions: {
      allow: ["user_allow"],
      ask: ["user_ask"],
      deny: ["user_deny"],
      defaultMode: "acceptEdits",
    },
  });
  writeJson(projectPath, {
    permissions: {
      allow: ["project_allow"],
      ask: ["project_ask"],
      deny: ["project_deny"],
      defaultMode: "plan",
    },
  });
  writeJson(localPath, {
    permissions: {
      allow: ["local_allow"],
      ask: ["local_ask"],
      deny: ["local_deny"],
      defaultMode: "dontAsk",
    },
  });

  assert.deepEqual(loadPermissionSettings({
    cwd,
    homeDir,
    trustRoot: projectDir,
    projectTrusted: false,
  }), {
    rules: [
      rule("allow", "user_allow", "user", userPath),
      rule("ask", "user_ask", "user", userPath),
      rule("deny", "user_deny", "user", userPath),
      rule("ask", "project_ask", "project", projectPath),
      rule("deny", "project_deny", "project", projectPath),
      rule("ask", "local_ask", "local", localPath),
      rule("deny", "local_deny", "local", localPath),
    ],
    defaultMode: "acceptEdits",
    defaultModeSource: { sourceScope: "user", sourcePath: userPath },
    trustGated: {
      rules: [
        rule("allow", "project_allow", "project", projectPath),
        rule("allow", "local_allow", "local", localPath),
      ],
      defaultMode: "dontAsk",
      defaultModeSource: { sourceScope: "local", sourcePath: localPath },
    },
  });
});

test("已信任项目全量采用项目和本地项目配置", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const projectDir = join(root, "project");
  const projectPath = join(projectDir, ".mo-code", "settings.json");
  const localPath = join(projectDir, ".mo-code", "settings.local.json");

  writeJson(projectPath, {
    permissions: {
      allow: ["project_allow"],
      ask: ["project_ask"],
      defaultMode: "plan",
    },
  });
  writeJson(localPath, {
    permissions: {
      allow: ["local_allow"],
      deny: ["local_deny"],
      defaultMode: "acceptEdits",
    },
  });

  assert.deepEqual(loadPermissionSettings({
    cwd: join(projectDir, "src"),
    homeDir,
    trustRoot: projectDir,
    projectTrusted: true,
  }), {
    rules: [
      rule("allow", "project_allow", "project", projectPath),
      rule("ask", "project_ask", "project", projectPath),
      rule("allow", "local_allow", "local", localPath),
      rule("deny", "local_deny", "local", localPath),
    ],
    defaultMode: "acceptEdits",
    defaultModeSource: { sourceScope: "local", sourcePath: localPath },
  });
});

test("未信任项目没有权限扩张配置时不返回门控摘要", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const projectDir = join(root, "project");
  const projectPath = join(projectDir, ".mo-code", "settings.json");
  writeJson(projectPath, {
    permissions: { ask: ["project_ask"], deny: ["project_deny"] },
  });

  assert.deepEqual(loadPermissionSettings({
    cwd: projectDir,
    homeDir,
    trustRoot: projectDir,
    projectTrusted: false,
  }), {
    rules: [
      rule("ask", "project_ask", "project", projectPath),
      rule("deny", "project_deny", "project", projectPath),
    ],
  });
});

test("项目配置发现不会越过 trustRoot", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const outerDir = join(root, "workspace");
  const trustRoot = join(outerDir, "nested-repository");
  const outerPath = join(outerDir, ".mo-code", "settings.json");
  writeJson(outerPath, { permissions: { deny: ["outer_rule"] } });

  assert.deepEqual(loadPermissionSettings({
    cwd: join(trustRoot, "src"),
    homeDir,
    trustRoot,
    projectTrusted: true,
  }), { rules: [] });
});

test("未信任项目中的无效配置仍然抛错", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const projectDir = join(root, "project");
  const projectPath = join(projectDir, ".mo-code", "settings.json");
  writeRaw(projectPath, "{invalid-json");

  assert.throws(
    () => loadPermissionSettings({
      cwd: projectDir,
      homeDir,
      trustRoot: projectDir,
      projectTrusted: false,
    }),
    (error) => error instanceof Error
      && error.message.includes(projectPath)
      && error.message.includes("invalid JSON"),
  );
});

test("只使用距离 cwd 最近的项目配置目录", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const workspaceDir = join(root, "workspace");
  const projectDir = join(workspaceDir, "project");
  const cwd = join(projectDir, "src");

  writeJson(join(workspaceDir, ".mo-code", "settings.json"), {
    permissions: { deny: ["outer_rule"] },
  });
  const nearestPath = join(projectDir, ".mo-code", "settings.local.json");
  writeJson(nearestPath, {
    permissions: { allow: ["nearest_rule"] },
  });

  assert.deepEqual(loadPermissionSettings({ cwd, homeDir }).rules, [
    {
      behavior: "allow",
      raw: "nearest_rule",
      sourceScope: "local",
      sourcePath: nearestPath,
    },
  ]);
});

test("用户设置不会在向上查找时被重复识别为项目设置", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const sourcePath = join(homeDir, ".mo-code", "settings.json");
  writeJson(sourcePath, { permissions: { allow: ["read_file"] } });

  const settings = loadPermissionSettings({
    cwd: join(homeDir, "projects", "demo"),
    homeDir,
  });

  assert.equal(settings.rules.length, 1);
  assert.equal(settings.rules[0].sourceScope, "user");
});

for (const scope of ["user", "project", "local"]) {
  test(`${scope} 配置包含无效 JSON 时抛出带路径的错误`, () => {
    const fixture = createSourceFixture(scope);
    writeRaw(fixture.sourcePath, "{invalid-json");

    assert.throws(
      () => loadPermissionSettings(fixture.options),
      (error) => error instanceof Error
        && error.message.includes(fixture.sourcePath)
        && error.message.includes("invalid JSON"),
    );
  });
}

test("设置根值和 permissions 必须是对象", () => {
  for (const value of [null, [], { permissions: null }, { permissions: [] }]) {
    const root = createTemporaryDirectory();
    const homeDir = join(root, "home");
    const sourcePath = join(homeDir, ".mo-code", "settings.json");
    writeJson(sourcePath, value);

    assert.throws(
      () => loadPermissionSettings({ cwd: join(root, "project"), homeDir }),
      (error) => error instanceof Error && error.message.includes(sourcePath),
    );
  }
});

test("defaultMode 必须是五种有效权限模式之一", () => {
  for (const defaultMode of [42, "unknown"]) {
    const root = createTemporaryDirectory();
    const homeDir = join(root, "home");
    const sourcePath = join(homeDir, ".mo-code", "settings.json");
    writeJson(sourcePath, { permissions: { defaultMode } });

    assert.throws(
      () => loadPermissionSettings({ cwd: join(root, "project"), homeDir }),
      (error) => error instanceof Error
        && error.message.includes(sourcePath)
        && error.message.includes("permissions.defaultMode"),
    );
  }
});

test("allow、ask、deny 必须是字符串数组", () => {
  const invalidPermissions = [
    { allow: "read_file" },
    { ask: ["run_shell", 1] },
    { deny: null },
  ];

  for (const permissions of invalidPermissions) {
    const root = createTemporaryDirectory();
    const homeDir = join(root, "home");
    const sourcePath = join(homeDir, ".mo-code", "settings.json");
    writeJson(sourcePath, { permissions });

    assert.throws(
      () => loadPermissionSettings({ cwd: join(root, "project"), homeDir }),
      (error) => error instanceof Error && error.message.includes(sourcePath),
    );
  }
});

test("忽略权限配置之外的未知字段", () => {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  writeJson(join(homeDir, ".mo-code", "settings.json"), {
    model: "future-model",
    permissions: {
      allow: [],
      futureOption: true,
      defaultMode: "plan",
    },
  });

  assert.deepEqual(loadPermissionSettings({
    cwd: join(root, "project"),
    homeDir,
  }), {
    rules: [],
    defaultMode: "plan",
    defaultModeSource: {
      sourceScope: "user",
      sourcePath: join(homeDir, ".mo-code", "settings.json"),
    },
  });
});

test("持久 allow 规则写入最近的设置根，并保留其他字段且自动去重", () => {
  const root = createTemporaryDirectory();
  const gitRoot = join(root, "workspace");
  const projectRoot = join(gitRoot, "packages", "demo");
  const cwd = join(projectRoot, "src");
  const sharedPath = join(projectRoot, ".mo-code", "settings.json");
  const localPath = join(projectRoot, ".mo-code", "settings.local.json");
  mkdirSync(join(gitRoot, ".git"), { recursive: true });
  writeJson(sharedPath, { permissions: { deny: ["run_shell(rm *)"] } });
  writeJson(localPath, {
    model: "example-model",
    permissions: {
      allow: ["read_file"],
      ask: ["run_shell(git push*)"],
    },
  });

  addLocalPermissionAllowRule({ cwd, rule: "run_shell(pnpm test)" });
  addLocalPermissionAllowRule({ cwd, rule: "run_shell(pnpm test)" });

  assert.deepEqual(readJson(localPath), {
    model: "example-model",
    permissions: {
      allow: ["read_file", "run_shell(pnpm test)"],
      ask: ["run_shell(git push*)"],
    },
  });
  assert.equal(existsSync(join(gitRoot, ".mo-code", "settings.local.json")), false);
});

test("没有现有设置根时优先写入 Git 根目录", () => {
  const root = createTemporaryDirectory();
  const gitRoot = join(root, "workspace");
  const cwd = join(gitRoot, "packages", "demo");
  const localPath = join(gitRoot, ".mo-code", "settings.local.json");
  mkdirSync(join(gitRoot, ".git"), { recursive: true });

  addLocalPermissionAllowRule({
    cwd,
    rule: "web_fetch(https://example.com/*)",
  });

  assert.deepEqual(readJson(localPath), {
    permissions: { allow: ["web_fetch(https://example.com/*)"] },
  });
});

test("嵌套 Git 仓库的持久授权不会写到外层项目", () => {
  const root = createTemporaryDirectory();
  const outerRoot = join(root, "outer");
  const innerRoot = join(outerRoot, "packages", "inner");
  const cwd = join(innerRoot, "src");
  const outerLocalPath = join(outerRoot, ".mo-code", "settings.local.json");
  const innerLocalPath = join(innerRoot, ".mo-code", "settings.local.json");
  mkdirSync(join(outerRoot, ".git"), { recursive: true });
  mkdirSync(join(innerRoot, ".git"), { recursive: true });
  mkdirSync(cwd);
  writeJson(outerLocalPath, {
    permissions: { allow: ["read_file"] },
  });

  addLocalPermissionAllowRule({
    cwd,
    rule: "run_shell(pnpm test)",
  });

  assert.deepEqual(readJson(outerLocalPath), {
    permissions: { allow: ["read_file"] },
  });
  assert.deepEqual(readJson(innerLocalPath), {
    permissions: { allow: ["run_shell(pnpm test)"] },
  });
});

test("没有设置根和 Git 根时回退到 cwd", () => {
  const root = createTemporaryDirectory();
  const cwd = join(root, "standalone");
  const localPath = join(cwd, ".mo-code", "settings.local.json");

  addLocalPermissionAllowRule({ cwd, rule: "run_shell(pnpm test)" });

  assert.deepEqual(readJson(localPath), {
    permissions: { allow: ["run_shell(pnpm test)"] },
  });
});

test("持久规则写入不会覆盖无效的本地配置", () => {
  const root = createTemporaryDirectory();
  const cwd = join(root, "project");
  const localPath = join(cwd, ".mo-code", "settings.local.json");
  writeRaw(localPath, "{invalid-json");

  assert.throws(
    () => addLocalPermissionAllowRule({ cwd, rule: "run_shell(pnpm test)" }),
    (error) => error instanceof Error
      && error.message.includes(localPath)
      && error.message.includes("cannot update file"),
  );
  assert.equal(readFileSync(localPath, "utf-8"), "{invalid-json");
});

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "mo-code-permission-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createSourceFixture(sourceScope) {
  const root = createTemporaryDirectory();
  const homeDir = join(root, "home");
  const projectDir = join(root, "project");
  const options = { cwd: join(projectDir, "src"), homeDir };

  if (sourceScope === "user") {
    return {
      options,
      sourcePath: join(homeDir, ".mo-code", "settings.json"),
    };
  }
  if (sourceScope === "project") {
    return {
      options,
      sourcePath: join(projectDir, ".mo-code", "settings.json"),
    };
  }
  return {
    options,
    sourcePath: join(projectDir, ".mo-code", "settings.local.json"),
  };
}

function writeJson(path, value) {
  writeRaw(path, JSON.stringify(value));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function rule(behavior, raw, sourceScope, sourcePath) {
  return { behavior, raw, sourceScope, sourcePath };
}

function writeRaw(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}
