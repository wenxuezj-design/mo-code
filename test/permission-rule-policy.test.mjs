import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PermissionModePolicy } from "../src/permissions/permission-mode-policy.ts";
import { PermissionRulePolicy } from "../src/permissions/permission-rule-policy.ts";

const KNOWN_TOOLS = [
  "read_file",
  "write_file",
  "list_files",
  "run_shell",
  "web_fetch",
];

test("规则支持裸工具、精确 specifier 和任意位置通配符", () => {
  const policy = createPolicy([
    rule("allow", "read_file"),
    rule("allow", "run_shell(git status)"),
    rule("ask", "run_shell(git * --no-verify)"),
    rule("deny", "web_fetch(*://internal.*/*)"),
  ]);

  assert.equal(policy.evaluate(request("read_file", "read", "/tmp/a")).behavior, "allow");
  assert.equal(policy.evaluate(request("read_file", "read", "/tmp/b")).behavior, "allow");
  assert.equal(policy.evaluate(request("run_shell", "shell", "git status")).behavior, "allow");
  assert.equal(policy.evaluate(request("run_shell", "shell", "git status -s")).behavior, "ask");
  assert.equal(
    policy.evaluate(request("run_shell", "shell", "git commit --no-verify")).behavior,
    "ask",
  );
  assert.equal(
    policy.evaluate(request("web_fetch", "network", "https://internal.example/a")).behavior,
    "deny",
  );
  assert.equal(
    policy.evaluate(request("web_fetch", "network", "https://example.com/a")).behavior,
    "ask",
  );
});

test("specifier 中的正则字符按普通文本匹配", () => {
  const policy = createPolicy([
    rule("allow", "run_shell(npm test -- --grep=a+b?)"),
  ]);

  assert.equal(
    policy.evaluate(request("run_shell", "shell", "npm test -- --grep=a+b?")).behavior,
    "allow",
  );
  assert.equal(
    policy.evaluate(request("run_shell", "shell", "npm test -- --grep=abx")).behavior,
    "ask",
  );
});

test("规则支持转义星号和反斜杠，以精确匹配自动生成的 Shell 命令", () => {
  const policy = createPolicy([
    rule("allow", String.raw`run_shell(printf C:\\temp\\\*.log)`),
  ]);

  assert.equal(
    policy.evaluate(
      request("run_shell", "shell", String.raw`printf C:\temp\*.log`),
    ).behavior,
    "allow",
  );
  assert.equal(
    policy.evaluate(
      request("run_shell", "shell", String.raw`printf C:\temp\app.log`),
    ).behavior,
    "ask",
  );
});

test("通配符可以匹配包含换行的目标", () => {
  const policy = createPolicy([
    rule("allow", "run_shell(echo * done)"),
  ]);

  assert.equal(
    policy.evaluate(request("run_shell", "shell", "echo first\nsecond done")).behavior,
    "allow",
  );
});

test("read/edit specifier 相对 cwd 解析，并统一路径分隔符后匹配", () => {
  const policy = createPolicy([
    rule("deny", "read_file(./.env)"),
    rule("allow", String.raw`write_file(src\*.ts)`),
  ]);

  assert.equal(
    policy.evaluate(request("read_file", "read", "/project/.env")).behavior,
    "deny",
  );
  assert.equal(
    policy.evaluate(request("read_file", "read", "/other/.env")).behavior,
    "allow",
  );
  assert.equal(
    policy.evaluate(request("write_file", "edit", "/project/src/a.ts")).behavior,
    "allow",
  );
  assert.equal(
    policy.evaluate(request("write_file", "edit", "/project/test/a.ts")).behavior,
    "ask",
  );
});

test("空规则、畸形语法、空 specifier 和未知工具会在构造时拒绝", () => {
  for (const [raw, expected] of [
    ["", /rule is empty/],
    ["   ", /rule is empty/],
    ["run_shell)", /unmatched parenthesis/],
    ["run_shell(command", /malformed tool\(specifier\) syntax/],
    ["(command)", /malformed tool\(specifier\) syntax/],
    ["run_shell()", /specifier is empty/],
    ["run_shell(   )", /specifier is empty/],
    ["missing_tool", /unknown tool "missing_tool"/],
  ]) {
    assert.throws(
      () => createPolicy([rule("allow", raw, "/rules/settings.json")]),
      (error) => {
        assert.match(error.message, expected);
        assert.match(error.message, /\/rules\/settings\.json/);
        return true;
      },
      raw,
    );
  }
});

test("bypassPermissions 在所有配置规则前直接放行", () => {
  const policy = createPolicy(
    [rule("deny", "run_shell")],
    "bypassPermissions",
  );

  assert.deepEqual(
    policy.evaluate(request("run_shell", "shell", "rm -rf build")),
    { behavior: "allow" },
  );
});

test("deny 优先于 plan、ask 和 allow，并在原因中保留原始规则来源", () => {
  const rules = [
    rule("allow", "run_shell(git *)"),
    rule("ask", "run_shell(git push*)"),
    rule("deny", "run_shell(git push --force*)", "/project/.mo-code/settings.json"),
  ];
  const policy = createPolicy(rules, "plan");

  const decision = policy.evaluate(
    request("run_shell", "shell", "git push --force-with-lease"),
  );
  assert.equal(decision.behavior, "deny");
  assert.match(decision.reason, /run_shell\(git push --force\*\)/);
  assert.match(decision.reason, /\/project\/\.mo-code\/settings\.json/);
});

test("plan 对 edit 和 shell 的硬拒绝优先于 ask 与 allow", () => {
  const policy = createPolicy([
    rule("allow", "write_file"),
    rule("ask", "run_shell"),
  ], "plan");

  assert.equal(
    policy.evaluate(request("write_file", "edit", "/project/a.ts")).behavior,
    "deny",
  );
  assert.equal(
    policy.evaluate(request("run_shell", "shell", "pnpm test")).behavior,
    "deny",
  );
});

test("ask 优先于 allow，并在 dontAsk 下转为带来源的 deny", () => {
  const modePolicy = new PermissionModePolicy("default");
  const policy = new PermissionRulePolicy([
    rule("allow", "run_shell(pnpm *)"),
    rule("ask", "run_shell(pnpm test)", "/user/settings.json"),
  ], modePolicy, KNOWN_TOOLS);
  const toolRequest = request("run_shell", "shell", "pnpm test");

  const askDecision = policy.evaluate(toolRequest);
  assert.equal(askDecision.behavior, "ask");
  assert.equal(askDecision.rememberable, false);
  assert.match(askDecision.reason, /run_shell\(pnpm test\)/);
  assert.match(askDecision.reason, /\/user\/settings\.json/);

  modePolicy.setMode("dontAsk");
  const denyDecision = policy.evaluate(toolRequest);
  assert.equal(denyDecision.behavior, "deny");
  assert.match(denyDecision.reason, /dontAsk mode blocks prompts/);
  assert.match(denyDecision.reason, /\/user\/settings\.json/);
});

test("allow 优先于模式默认结论，未匹配时回退到同一个可切换 ModePolicy", () => {
  const modePolicy = new PermissionModePolicy("default");
  const policy = new PermissionRulePolicy([
    rule("allow", "run_shell(pnpm test)"),
  ], modePolicy, KNOWN_TOOLS);

  assert.equal(
    policy.evaluate(request("run_shell", "shell", "pnpm test")).behavior,
    "allow",
  );
  assert.equal(
    policy.evaluate(request("write_file", "edit", "/project/a.ts")).behavior,
    "ask",
  );

  modePolicy.setMode("acceptEdits");
  assert.equal(
    policy.evaluate(request("write_file", "edit", "/project/a.ts")).behavior,
    "allow",
  );
});

test("普通外部路径默认逐次询问，但显式 allow 可以预先授权", (t) => {
  const { workspace, external } = createPathFixture(t);
  const target = join(external, "notes.txt");
  const toolRequest = fileRequest("read_file", "read", target, target, "read", workspace);

  const defaultPolicy = createPolicy([]);
  const decision = defaultPolicy.evaluate(toolRequest);
  assert.equal(decision.behavior, "ask");
  assert.equal(decision.rememberable, false);
  assert.match(decision.reason, /outside the primary working directory/);

  const allowedPolicy = createPolicy([
    rule("allow", `read_file(${target})`),
  ]);
  assert.equal(allowedPolicy.evaluate(toolRequest).behavior, "allow");

  const dontAskPolicy = createPolicy([], "dontAsk");
  assert.equal(dontAskPolicy.evaluate(toolRequest).behavior, "deny");

  // cwd 来自请求，而不是进程全局 cwd。
  assert.equal(toolRequest.cwd, workspace);
});

test("保护路径写入早于 ask/allow，且确认不可记忆", (t) => {
  const { workspace } = createPathFixture(t);
  const target = join(workspace, "nested", ".mo-code", "settings.json");
  const rules = [
    rule("allow", "write_file"),
    rule("ask", `write_file(${target})`),
  ];

  const decision = createPolicy(rules).evaluate(
    fileRequest("write_file", "edit", target, target, "write", workspace),
  );
  assert.equal(decision.behavior, "ask");
  assert.equal(decision.rememberable, false);
  assert.match(decision.reason, /protected project-control path/);

  assert.equal(
    createPolicy(rules, "dontAsk").evaluate(
      fileRequest("write_file", "edit", target, target, "write", workspace),
    ).behavior,
    "deny",
  );
  assert.equal(
    createPolicy(rules, "bypassPermissions").evaluate(
      fileRequest("write_file", "edit", target, target, "write", workspace),
    ).behavior,
    "allow",
  );
});

test("显式 deny 早于普通保护路径判断", (t) => {
  const { workspace } = createPathFixture(t);
  const target = join(workspace, ".git", "config");
  const decision = createPolicy([
    rule("deny", "write_file", "/user/settings.json"),
  ]).evaluate(fileRequest("write_file", "edit", target, target, "write", workspace));

  assert.equal(decision.behavior, "deny");
  assert.match(decision.reason, /\/user\/settings\.json/);
});

test("保护路径读取仍按普通读取规则处理", (t) => {
  const { workspace } = createPathFixture(t);
  const target = join(workspace, "nested", "AGENTS.md");

  assert.deepEqual(
    createPolicy([]).evaluate(fileRequest("read_file", "read", target, target, "read", workspace)),
    { behavior: "allow" },
  );
});

test("未知或无法解析的文件访问不能被普通 allow 跳过", (t) => {
  const { workspace } = createPathFixture(t);
  const dangling = join(workspace, "dangling");
  symlinkSync(join(workspace, "missing-target"), dangling);

  const unknownRequest = {
    ...request("run_shell", "shell", 'rm -rf "$TARGET"'),
    cwd: workspace,
    filesystemAccesses: { status: "unknown" },
  };
  const allowPolicy = createPolicy([rule("allow", "run_shell")]);
  const unknownDecision = allowPolicy.evaluate(unknownRequest);
  assert.equal(unknownDecision.behavior, "ask");
  assert.equal(unknownDecision.rememberable, false);

  const unresolvedTarget = join(dangling, "new.txt");
  const unresolvedDecision = createPolicy([
    rule("allow", "write_file"),
  ]).evaluate(
    fileRequest(
      "write_file",
      "edit",
      unresolvedTarget,
      unresolvedTarget,
      "write",
      workspace,
    ),
  );
  assert.equal(unresolvedDecision.behavior, "ask");
  assert.match(unresolvedDecision.reason, /cannot be resolved reliably/);

  assert.equal(
    createPolicy([], "plan").evaluate(unknownRequest).behavior,
    "deny",
  );
  assert.equal(
    createPolicy([], "bypassPermissions").evaluate(unknownRequest).behavior,
    "allow",
  );
});

test("灾难删除熔断即使在 bypassPermissions 下仍需确认", () => {
  const toolRequest = {
    ...request("run_shell", "shell", "rm -rf /"),
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: resolve("/"), operation: "delete", recursive: true }],
    },
  };

  const bypassDecision = createPolicy([], "bypassPermissions").evaluate(toolRequest);
  assert.equal(bypassDecision.behavior, "ask");
  assert.equal(bypassDecision.rememberable, false);
  assert.match(bypassDecision.reason, /filesystem root or Home/);
  assert.equal(createPolicy([], "plan").evaluate(toolRequest).behavior, "deny");
  assert.equal(createPolicy([], "dontAsk").evaluate(toolRequest).behavior, "deny");

  const followedLinkRisk = createPolicy([], "bypassPermissions").evaluate({
    ...request("run_shell", "shell", "find -L . -delete"),
    filesystemAccesses: {
      status: "unknown",
      catastrophicDeleteRisk: true,
    },
  });
  assert.equal(followedLinkRisk.behavior, "ask");
  assert.equal(followedLinkRisk.rememberable, false);
  assert.match(followedLinkRisk.reason, /may reach.*root or Home/);
});

test("不完整 Shell 分析中的灾难删除事实仍触发熔断", (t) => {
  const toolRequest = {
    ...request("run_shell", "shell", "rm -rf / > deletion.log"),
    filesystemAccesses: {
      status: "unknown",
      accesses: [{ path: resolve("/"), operation: "delete", recursive: true }],
    },
  };

  const decision = createPolicy([], "bypassPermissions").evaluate(toolRequest);
  assert.equal(decision.behavior, "ask");
  assert.equal(decision.rememberable, false);
  assert.match(decision.reason, /filesystem root or Home/);

  const { workspace } = createPathFixture(t);
  const rootLink = join(workspace, "root-link");
  symlinkSync(resolve("/"), rootLink, "dir");
  const linkedDecision = createPolicy([], "bypassPermissions").evaluate({
    ...request("run_shell", "shell", "rm -rf root-link > deletion.log"),
    cwd: workspace,
    filesystemAccesses: {
      status: "unknown",
      accesses: [{ path: rootLink, operation: "delete", recursive: true }],
    },
  });
  assert.equal(linkedDecision.behavior, "ask");
  assert.match(linkedDecision.reason, /root-link -> \/\)/);
});

test("文件 allow 需要同时覆盖符号链接位置和真实目标", (t) => {
  const { workspace, external } = createPathFixture(t);
  const link = join(workspace, "shared");
  symlinkSync(external, link, "dir");
  const linkedTarget = join(link, "note.txt");
  const realTarget = join(external, "note.txt");
  const toolRequest = fileRequest(
    "read_file",
    "read",
    linkedTarget,
    linkedTarget,
    "read",
    workspace,
  );

  assert.equal(
    createPolicy([
      rule("allow", `read_file(${link}/*)`),
    ]).evaluate(toolRequest).behavior,
    "ask",
  );
  assert.equal(
    createPolicy([
      rule("allow", `read_file(${link}/*)`),
      rule("allow", `read_file(${external}/*)`),
    ]).evaluate(toolRequest).behavior,
    "allow",
  );

  const denied = createPolicy([
    rule("allow", "read_file"),
    rule("deny", `read_file(${realTarget})`),
  ]).evaluate(toolRequest);
  assert.equal(denied.behavior, "deny");
});

test("list_files glob 在符号链接两侧使用相同后缀匹配", (t) => {
  const { workspace, external } = createPathFixture(t);
  const link = join(workspace, "shared");
  symlinkSync(external, link, "dir");
  const permissionTarget = join(link, "**", "*.ts");
  const toolRequest = fileRequest(
    "list_files",
    "read",
    permissionTarget,
    link,
    "read",
    workspace,
  );

  assert.equal(
    createPolicy([
      rule("allow", `list_files(${link}/**/*.ts)`),
      rule("allow", `list_files(${external}/**/*.ts)`),
    ]).evaluate(toolRequest).behavior,
    "allow",
  );
});

test("acceptEdits 自动允许边界内已识别的修改型 Shell 命令", (t) => {
  const { workspace, external } = createPathFixture(t);
  const internalRequest = {
    ...request("run_shell", "shell", "touch output.txt"),
    cwd: workspace,
    shellSemantics: "mutating",
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: join(workspace, "output.txt"), operation: "write" }],
    },
  };

  assert.equal(createPolicy([], "default").evaluate(internalRequest).behavior, "ask");
  assert.equal(
    createPolicy([], "acceptEdits").evaluate(internalRequest).behavior,
    "allow",
  );

  const externalDecision = createPolicy([], "acceptEdits").evaluate({
    ...internalRequest,
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: join(external, "output.txt"), operation: "write" }],
    },
  });
  assert.equal(externalDecision.behavior, "ask");
  assert.equal(externalDecision.rememberable, false);
});

function createPolicy(rules, mode = "default") {
  return new PermissionRulePolicy(
    rules,
    new PermissionModePolicy(mode),
    KNOWN_TOOLS,
  );
}

function rule(behavior, raw, sourcePath = "/settings.json") {
  return {
    behavior,
    raw,
    sourceScope: "user",
    sourcePath,
  };
}

function request(toolName, permissionKind, permissionTarget) {
  return {
    toolName,
    permissionKind,
    permissionTarget,
    ...(permissionKind === "shell" ? { shellSemantics: "unknown" } : {}),
    input: {},
    cwd: "/project",
  };
}

function fileRequest(
  toolName,
  permissionKind,
  permissionTarget,
  accessPath,
  operation = "read",
  cwd = "/project",
) {
  return {
    ...request(toolName, permissionKind, permissionTarget),
    cwd,
    filesystemAccesses: {
      status: "known",
      accesses: [{ path: accessPath, operation }],
    },
  };
}

function createPathFixture(t) {
  const fixture = mkdtempSync(join(realpathSync(tmpdir()), "mo-code-permission-policy-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const workspace = join(fixture, "workspace");
  const external = join(fixture, "external");
  mkdirSync(workspace);
  mkdirSync(external);
  return { workspace, external };
}
