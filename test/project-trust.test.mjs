import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ProjectTrustStore,
  resolveProjectTrustRoot,
} from "../src/permissions/project-trust.ts";

const temporaryDirectories = [];

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Git 项目使用最近仓库的真实根目录", () => {
  const fixture = createFixture();
  const outer = join(fixture.root, "outer");
  const nested = join(outer, "packages", "nested");
  const cwd = join(nested, "src");
  mkdirSync(join(outer, ".git"), { recursive: true });
  mkdirSync(dirname(cwd), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(nested, ".git"), "gitdir: ../../.git/modules/nested\n");

  const linkedRoot = join(fixture.root, "linked-nested");
  symlinkSync(nested, linkedRoot, "dir");
  const result = resolveProjectTrustRoot({
    cwd: join(linkedRoot, "src"),
    homeDir: fixture.homeDir,
  });

  assert.deepEqual(result, {
    kind: "git",
    path: realpathSync(nested),
    sessionOnly: false,
  });
});

test("非 Git 项目使用启动目录而不是父目录", () => {
  const fixture = createFixture();
  const cwd = join(fixture.root, "workspace", "project", "src");
  mkdirSync(cwd, { recursive: true });

  assert.deepEqual(resolveProjectTrustRoot({
    cwd,
    homeDir: fixture.homeDir,
  }), {
    kind: "directory",
    path: realpathSync(cwd),
    sessionOnly: false,
  });
});

test("接受普通信任根后持久化，新的 store 也能读取", () => {
  const fixture = createFixture();
  const project = join(fixture.root, "project");
  mkdirSync(project);
  const root = resolveProjectTrustRoot({
    cwd: project,
    homeDir: fixture.homeDir,
  });
  const store = new ProjectTrustStore({ homeDir: fixture.homeDir });

  assert.deepEqual(store.getStatus(root), {
    trusted: false,
    source: "none",
    sessionOnly: false,
  });
  assert.deepEqual(store.accept(root), {
    trusted: true,
    source: "persistent",
    sessionOnly: false,
  });

  const trustPath = join(fixture.homeDir, ".mo-code", "trust.json");
  assert.deepEqual(JSON.parse(readFileSync(trustPath, "utf-8")), {
    acceptedRoots: [realpathSync(project)],
  });
  assert.equal(new ProjectTrustStore({
    homeDir: fixture.homeDir,
  }).isTrusted(root), true);
});

test("Home 接受只在当前 store 中有效且不生成信任文件", () => {
  const fixture = createFixture();
  const root = resolveProjectTrustRoot({
    cwd: fixture.homeDir,
    homeDir: fixture.homeDir,
  });
  const store = new ProjectTrustStore({ homeDir: fixture.homeDir });

  assert.equal(root.sessionOnly, true);
  assert.deepEqual(store.accept(root), {
    trusted: true,
    source: "session",
    sessionOnly: true,
  });
  assert.equal(store.isTrusted(root), true);
  assert.equal(
    new ProjectTrustStore({ homeDir: fixture.homeDir }).isTrusted(root),
    false,
  );
  assert.throws(
    () => readFileSync(join(fixture.homeDir, ".mo-code", "trust.json")),
    { code: "ENOENT" },
  );
});

test("手工写入的 Home 持久信任不会生效", () => {
  const fixture = createFixture();
  const trustPath = join(fixture.homeDir, ".mo-code", "trust.json");
  writeJson(trustPath, { acceptedRoots: [fixture.homeDir] });
  const root = resolveProjectTrustRoot({
    cwd: fixture.homeDir,
    homeDir: fixture.homeDir,
  });

  assert.deepEqual(new ProjectTrustStore({
    homeDir: fixture.homeDir,
  }).getStatus(root), {
    trusted: false,
    source: "none",
    sessionOnly: true,
  });
});

for (const invalidValue of [
  "{invalid-json",
  JSON.stringify({ acceptedRoots: "not-an-array" }),
  JSON.stringify({ acceptedRoots: ["relative/path"] }),
]) {
  test("信任文件损坏时按未信任处理", () => {
    const fixture = createFixture();
    const project = join(fixture.root, "project");
    mkdirSync(project);
    const trustPath = join(fixture.homeDir, ".mo-code", "trust.json");
    mkdirSync(dirname(trustPath), { recursive: true });
    writeFileSync(trustPath, invalidValue);
    const root = resolveProjectTrustRoot({
      cwd: project,
      homeDir: fixture.homeDir,
    });

    const store = new ProjectTrustStore({ homeDir: fixture.homeDir });
    assert.equal(store.isTrusted(root), false);
  });
}

test("信任文件不可读时按未信任处理", () => {
  const fixture = createFixture();
  const project = join(fixture.root, "project");
  mkdirSync(project);
  const trustPath = join(fixture.homeDir, ".mo-code", "trust.json");
  mkdirSync(trustPath, { recursive: true });
  const root = resolveProjectTrustRoot({
    cwd: project,
    homeDir: fixture.homeDir,
  });

  const store = new ProjectTrustStore({ homeDir: fixture.homeDir });
  assert.equal(store.isTrusted(root), false);
});

test("持久化失败时不会在内存中把项目标记为 trusted", () => {
  const fixture = createFixture();
  const project = join(fixture.root, "project");
  mkdirSync(project);
  const blockedParent = join(fixture.root, "not-a-directory");
  writeFileSync(blockedParent, "file");
  const store = new ProjectTrustStore({
    homeDir: fixture.homeDir,
    trustFilePath: join(blockedParent, "trust.json"),
  });
  const root = resolveProjectTrustRoot({
    cwd: project,
    homeDir: fixture.homeDir,
  });

  assert.throws(
    () => store.accept(root),
    /Cannot persist project trust/,
  );
  assert.equal(store.isTrusted(root), false);
});

test("Home 不可用时仍能按未信任状态读取，接受则明确失败", () => {
  const fixture = createFixture();
  const invalidHome = join(fixture.root, "home-file");
  const project = join(fixture.root, "project");
  writeFileSync(invalidHome, "not a directory");
  mkdirSync(project);

  const root = resolveProjectTrustRoot({ cwd: project, homeDir: invalidHome });
  const store = new ProjectTrustStore({ homeDir: invalidHome });

  assert.equal(store.isTrusted(root), false);
  assert.throws(() => store.accept(root), /Cannot persist project trust/);
  assert.equal(store.isTrusted(root), false);
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "mo-code-project-trust-"));
  temporaryDirectories.push(root);
  const homeDir = join(root, "home");
  mkdirSync(homeDir);
  return { root, homeDir };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
