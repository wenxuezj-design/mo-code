import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { PathBoundary } from "../src/permissions/index.ts";

test("PathBoundary 以启动 cwd 及其真实路径为主工作目录", (t) => {
  const fixture = createFixture(t);
  const workspace = join(fixture, "workspace");
  const workspaceLink = join(fixture, "workspace-link");
  mkdirSync(workspace);
  symlinkSync(workspace, workspaceLink, "dir");

  const assessment = new PathBoundary().inspect(workspaceLink, known([
    { path: join(workspaceLink, "new", "file.txt"), operation: "write" },
    { path: join(workspace, "existing-view.txt"), operation: "write" },
  ]));

  assert.equal(assessment.status, "known");
  assert.equal(assessment.hasExternalPath, false);
  assert.equal(assessment.hasUnresolvedPath, false);
});

test("PathBoundary 同时检查链接位置和真实目标", (t) => {
  const fixture = createFixture(t);
  const workspace = join(fixture, "workspace");
  const external = join(fixture, "external");
  mkdirSync(workspace);
  mkdirSync(external);
  symlinkSync(external, join(workspace, "outside-link"), "dir");
  symlinkSync(workspace, join(external, "inside-link"), "dir");

  const fromInside = inspectOne(
    new PathBoundary(),
    workspace,
    join(workspace, "outside-link", "new.txt"),
  );
  assert.equal(fromInside.outsideWorkingDirectory, true);
  assert.equal(fromInside.resolvedPath, join(external, "new.txt"));

  const fromOutside = inspectOne(
    new PathBoundary(),
    workspace,
    join(external, "inside-link", "new.txt"),
  );
  assert.equal(fromOutside.outsideWorkingDirectory, true);
  assert.equal(fromOutside.resolvedPath, join(workspace, "new.txt"));
});

test("PathBoundary 通过最近存在祖先解析尚未创建的目标", (t) => {
  const fixture = createFixture(t);
  const workspace = join(fixture, "workspace");
  const external = join(fixture, "external");
  mkdirSync(workspace);
  mkdirSync(external);
  symlinkSync(external, join(workspace, "output"), "dir");

  const access = inspectOne(
    new PathBoundary(),
    workspace,
    join(workspace, "output", "nested", "new.txt"),
  );

  assert.equal(access.resolvedPath, join(external, "nested", "new.txt"));
  assert.equal(access.outsideWorkingDirectory, true);
});

test("PathBoundary 在处理 .. 前先跟随符号链接", (t) => {
  const fixture = createFixture(t);
  const workspace = join(fixture, "workspace");
  const external = join(fixture, "external");
  const externalChild = join(external, "child");
  mkdirSync(workspace);
  mkdirSync(externalChild, { recursive: true });
  symlinkSync(externalChild, join(workspace, "link"), "dir");

  const access = inspectOne(
    new PathBoundary(),
    workspace,
    "link/../owned.txt",
  );

  assert.equal(access.requestedPath, join(workspace, "owned.txt"));
  assert.equal(access.resolvedPath, join(external, "owned.txt"));
  assert.equal(access.outsideWorkingDirectory, true);
});

test("PathBoundary 对无法解析的悬空链接保持未知", (t) => {
  const fixture = createFixture(t);
  const workspace = join(fixture, "workspace");
  mkdirSync(workspace);
  symlinkSync(join(fixture, "missing-target"), join(workspace, "dangling"));

  const assessment = new PathBoundary().inspect(workspace, known([
    { path: join(workspace, "dangling", "new.txt"), operation: "write" },
  ]));

  assert.equal(assessment.status, "known");
  assert.equal(assessment.hasUnresolvedPath, true);
  assert.equal(assessment.accesses[0].resolvedPath, undefined);
});

test("PathBoundary 只对保护路径的修改标记特殊保护", (t) => {
  const fixture = createFixture(t);
  const workspace = join(fixture, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "nested"));

  const assessment = new PathBoundary().inspect(workspace, known([
    { path: join(workspace, ".git", "config"), operation: "write" },
    { path: join(workspace, "nested", "AGENTS.md"), operation: "delete" },
    { path: join(workspace, ".mo-code", "settings.json"), operation: "read" },
    { path: join(workspace, "src", "app.ts"), operation: "write" },
    { path: join(workspace, ".GIT", "config"), operation: "write" },
    { path: join(workspace, "nested", "agents.md"), operation: "write" },
  ]));

  assert.equal(assessment.status, "known");
  assert.deepEqual(
    assessment.accesses.map((access) => access.protectedPath),
    [true, true, false, false, true, true],
  );
});

test("PathBoundary 识别根目录和注入 Home 的递归删除", (t) => {
  const fixture = createFixture(t);
  const workspace = join(fixture, "workspace");
  const fakeHome = join(fixture, "home");
  mkdirSync(workspace);
  mkdirSync(fakeHome);
  const boundary = new PathBoundary({ homeDirectory: fakeHome });

  const assessment = boundary.inspect(workspace, known([
    { path: resolve("/"), operation: "delete", recursive: true },
    { path: fakeHome, operation: "delete", recursive: true },
    { path: fakeHome, operation: "delete", recursive: false },
    { path: fakeHome.toUpperCase(), operation: "delete", recursive: true },
  ]));

  assert.equal(assessment.status, "known");
  assert.deepEqual(
    assessment.accesses.map((access) => access.catastrophicDelete),
    [true, true, false, true],
  );
});

test("PathBoundary 保留缺失分析、未知分析和已知空访问三种状态", (t) => {
  const fixture = createFixture(t);
  const boundary = new PathBoundary();

  assert.deepEqual(boundary.inspect(fixture, undefined), {
    status: "notApplicable",
  });
  assert.deepEqual(boundary.inspect(fixture, { status: "unknown" }), {
    status: "unknown",
  });
  assert.deepEqual(boundary.inspect(fixture, {
    status: "unknown",
    catastrophicDeleteRisk: true,
  }), {
    status: "unknown",
    hasCatastrophicDelete: true,
  });
  assert.deepEqual(boundary.inspect(fixture, known([])), {
    status: "known",
    accesses: [],
    hasUnresolvedPath: false,
    hasExternalPath: false,
    hasProtectedPath: false,
    hasCatastrophicDelete: false,
  });
});

function createFixture(t) {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "mo-code-path-boundary-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  return fixture;
}

function known(accesses) {
  return { status: "known", accesses };
}

function inspectOne(boundary, cwd, path) {
  const assessment = boundary.inspect(cwd, known([
    { path, operation: "write" },
  ]));
  assert.equal(assessment.status, "known");
  return assessment.accesses[0];
}
