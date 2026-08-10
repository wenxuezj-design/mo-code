import test from "node:test";
import assert from "node:assert/strict";

import { PermissionModePolicy } from "../src/permissions/permission-mode-policy.ts";
import { PermissionRulePolicy } from "../src/permissions/permission-rule-policy.ts";

const KNOWN_TOOLS = ["read_file", "write_file", "run_shell", "web_fetch"];

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
    input: {},
    cwd: "/project",
  };
}
