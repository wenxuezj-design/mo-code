import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
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

function writeRaw(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}
