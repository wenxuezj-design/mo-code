import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "src", "cli.ts");
const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const olderSessionId = "550e8400-e29b-41d4-a716-446655440001";
const latestSessionId = "550e8400-e29b-41d4-a716-446655440002";
const otherProjectSessionId = "550e8400-e29b-41d4-a716-446655440003";
const damagedSessionId = "550e8400-e29b-41d4-a716-446655440004";

test("--help 和 -h 显示 CLI 帮助后退出", () => {
  for (const option of ["--help", "-h"]) {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", cliPath, option],
      { cwd: projectRoot, encoding: "utf-8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Usage: mo-code \[options\] \[prompt\.\.\.\]/m);
    assert.match(result.stdout, /-h, --help/);
    assert.match(result.stdout, /-v, --version/);
    assert.match(result.stdout, /-p, --print/);
    assert.match(result.stdout, /-r, --resume \[id\]/);
    assert.match(result.stdout, /--mortis/);
    assert.match(result.stdout, /--max-budget-usd <amount>/);
  }
});

test("--version 和 -v 显示当前版本后退出", () => {
  for (const option of ["--version", "-v"]) {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", cliPath, option],
      { cwd: projectRoot, encoding: "utf-8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "0.4.0 (mo-code)\n");
  }
});

test("--print 和 -p 执行位置参数中的单次任务", async () => {
  for (const option of ["--print", "-p"]) {
    const result = await captureCliRequest([option, "hello", "world"]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "done\n");
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].messages[0].content.at(-1).text, "hello world");
  }
});

test("--model 和 -m 设置单次任务使用的模型", async () => {
  for (const option of ["--model", "-m"]) {
    const result = await captureCliRequest([
      "--print",
      option,
      "test-model",
      "hello",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].model, "test-model");
    assert.equal(result.requests[0].messages[0].content.at(-1).text, "hello");
  }
});

test("--permission-mode 提示权限控制尚未实现", async () => {
  const result = await captureCliRequest([
    "--print",
    "--permission-mode",
    "plan",
    "hello",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "Warning: --permission-mode 暂未实现权限控制\n");
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].messages[0].content.at(-1).text, "hello");
});

test("不带 --print 的 Prompt 进入交互模式", async () => {
  const result = await captureCliRequest(["hello", "world"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].messages[0].content.at(-1).text, "hello world");
});

test("交互模式读取输入并通过内置命令退出", async () => {
  for (const command of ["/exit", "/quit"]) {
    const result = await captureCliRequest([], `hello\n${command}\n`);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].messages[0].content.at(-1).text, "hello");
  }
});

test("--print 缺少 Prompt 时直接退出", async () => {
  const result = await captureCliRequest(["--print"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 0);
});

test("无参数时不执行默认任务", async () => {
  const result = await captureCliRequest([]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "> ");
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 0);
});

test("新会话使用 UUID，并在每轮完成后向同一个 JSONL 文件追加 turn", async () => {
  const result = await captureCliRequest([], "first\nsecond\n/exit\n");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 2);
  assert.equal(result.sessions.length, 1);

  const [{ filename, data: session, records }] = result.sessions;
  assert.match(
    session.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(filename, `${session.id}.jsonl`);
  assert.equal(session.version, 1);
  assert.equal(session.cwd, projectRoot);
  assert.equal(session.model, "mock");
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages.at(-2).content, "second");
  assert.ok(Date.parse(session.createdAt));
  assert.ok(Date.parse(session.updatedAt));
  assert.deepEqual(records.map(({ type }) => type), ["session", "turn", "turn"]);
  assert.equal(records[1].messages.length, 2);
  assert.equal(records[2].messages.length, 2);
  assert.equal(records[2].messages[0].content, "second");
});

test("会话 JSONL 的 turn 保存完整的 tool_use 和 tool_result", async () => {
  const result = await captureCliRequest(
    ["--print", "read package.json"],
    "",
    {
      responses: [
        {
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "read_file",
            input: { file_path: "package.json" },
          }],
        },
        { content: [{ type: "text", text: "done" }] },
      ],
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.sessions.length, 1);

  const messages = result.sessions[0].data.messages;
  const toolUse = messages[1].content[0];
  const toolResult = messages[2].content[0];
  assert.deepEqual(toolUse, {
    type: "tool_use",
    id: "tool-1",
    name: "read_file",
    input: { file_path: "package.json" },
  });
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "tool-1");
  assert.match(toolResult.content, /"name": "mo-code"/);
  assert.deepEqual(messages.at(-1).content, [{ type: "text", text: "done" }]);
});

test("--resume 和 -r 恢复指定会话并继续写入原文件", async () => {
  for (const option of ["--resume", "-r"]) {
    const initialSession = createStoredSession();
    const result = await captureCliRequest(
      [option, sessionId, "new question"],
      "",
      { initialSession },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].model, "saved-model");
    assert.equal(result.requests[0].messages[0].content, "old question");
    assert.equal(result.requests[0].messages.at(-1).content, "new question");
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].filename, `${sessionId}.jsonl`);
    assert.equal(result.sessions[0].data.id, sessionId);
    assert.equal(result.sessions[0].data.createdAt, initialSession.createdAt);
    assert.equal(result.sessions[0].data.messages.length, 4);
    assert.deepEqual(
      result.sessions[0].records.map(({ type }) => type),
      ["session", "turn", "turn"],
    );
  }
});

test("--resume 忽略并移除 JSONL 末尾残缺行后继续追加", async () => {
  const partialLine = '{"type":"turn","timestamp":"broken"';
  const initialSession = `${serializeStoredSession(createStoredSession())}${partialLine}`;
  const result = await captureCliRequest(
    ["--print", "--resume", sessionId, "new question"],
    "",
    { initialSession, initialSessionId: sessionId },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 1);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].data.messages.length, 4);
  assert.deepEqual(
    result.sessions[0].records.map(({ type }) => type),
    ["session", "turn", "turn"],
  );
  assert.equal(result.sessions[0].raw.includes(partialLine), false);
});

test("--resume 遇到 JSONL 文件中间损坏时明确报错", async () => {
  const [header, turn] = serializeStoredSession(createStoredSession()).trimEnd().split("\n");
  const initialSession = `${header}\n{not-json\n${turn}\n`;
  const result = await captureCliRequest(
    ["--resume", sessionId],
    "",
    { initialSession, initialSessionId: sessionId },
  );

  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.equal(result.stderr, `Error: 会话文件已损坏: ${sessionId}\n`);
});

test("--resume 校验 JSONL 记录结构", async () => {
  const [header] = serializeStoredSession(createStoredSession()).trimEnd().split("\n");
  const invalidTurn = JSON.stringify({
    type: "turn",
    timestamp: "2026-07-14T08:05:00.000Z",
    model: "saved-model",
    messages: "not-an-array",
  });
  const result = await captureCliRequest(
    ["--resume", sessionId],
    "",
    {
      initialSession: `${header}\n${invalidTurn}\n`,
      initialSessionId: sessionId,
    },
  );

  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.equal(result.stderr, `Error: 会话文件已损坏: ${sessionId}\n`);
});

test("--resume 在工作目录不一致时拒绝恢复并给出说明", async () => {
  const initialSession = createStoredSession({ cwd: "/other/project" });
  const result = await captureCliRequest(
    ["--resume", sessionId],
    "",
    { initialSession },
  );

  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.match(result.stderr, /属于另一个工作目录/);
  assert.match(result.stderr, /会话目录: \/other\/project/);
  assert.match(result.stderr, /请切换到会话目录后重新运行 mo-code --resume/);
});

test("--resume 对不存在和损坏的会话给出明确错误", async () => {
  const missing = await captureCliRequest(["--resume", sessionId]);
  assert.equal(missing.status, 1);
  assert.equal(missing.requests.length, 0);
  assert.equal(missing.stderr, `Error: 找不到会话: ${sessionId}\n`);

  const damaged = await captureCliRequest(
    ["--resume", sessionId],
    "",
    { initialSession: "{not-json", initialSessionId: sessionId },
  );
  assert.equal(damaged.status, 1);
  assert.equal(damaged.requests.length, 0);
  assert.equal(damaged.stderr, `Error: 会话文件已损坏: ${sessionId}\n`);
});

test("--resume 未提供 ID 时列出当前目录会话并按编号恢复", async () => {
  const olderSession = createStoredSession({
    id: olderSessionId,
    updatedAt: "2026-07-14T08:05:00.000Z",
    messages: [
      { role: "user", content: "older question" },
      { role: "assistant", content: [{ type: "text", text: "older answer" }] },
    ],
  });
  const latestSession = createStoredSession({
    id: latestSessionId,
    model: "latest-model",
    updatedAt: "2026-07-14T09:05:00.000Z",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "context reminder" },
          { type: "text", text: "latest question" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
    ],
  });
  const result = await captureCliRequest(
    ["--resume", "--print", "new question"],
    "2\n",
    {
      initialSessions: [
        { id: olderSessionId, contents: olderSession },
        { id: latestSessionId, contents: latestSession },
      ],
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /1\. .*latest-model.*latest question/);
  assert.match(result.stdout, /2\. .*saved-model.*older question/);
  assert.doesNotMatch(result.stdout, /context reminder/);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].messages[0].content, "older question");
  assert.equal(result.requests[0].messages.at(-1).content, "new question");
});

test("--resume 会话选择器输入 q 时取消恢复", async () => {
  const result = await captureCliRequest(
    ["--resume"],
    "q\n",
    { initialSession: createStoredSession() },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.requests.length, 0);
  assert.match(result.stdout, /已取消/);
});

test("--resume 会话选择器对无效编号重新提示", async () => {
  const result = await captureCliRequest(
    ["--resume", "--print", "new question"],
    "0\n1\n",
    { initialSession: createStoredSession() },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.match(result.stdout, /请输入 1 到 1 之间的编号，或输入 q 取消/);
});

test("--resume 未提供 ID 且当前目录没有会话时明确报错", async () => {
  const result = await captureCliRequest(["--resume"]);

  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.equal(result.stderr, "Error: 当前目录没有可恢复的会话\n");
});

test("--continue 和 -c 恢复当前目录最近的会话", async () => {
  for (const option of ["--continue", "-c"]) {
    const olderSession = createStoredSession({
      id: olderSessionId,
      updatedAt: "2026-07-14T08:05:00.000Z",
      messages: [
        { role: "user", content: "older question" },
        { role: "assistant", content: [{ type: "text", text: "older answer" }] },
      ],
    });
    const latestSession = createStoredSession({
      id: latestSessionId,
      model: "latest-model",
      createdAt: "2026-07-14T09:00:00.000Z",
      updatedAt: "2026-07-14T09:05:00.000Z",
      messages: [
        { role: "user", content: "latest question" },
        { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
      ],
    });
    const otherProjectSession = createStoredSession({
      id: otherProjectSessionId,
      cwd: "/other/project",
      updatedAt: "2026-07-14T10:05:00.000Z",
    });

    const result = await captureCliRequest(
      ["--print", option, "new question"],
      "",
      {
        initialSessions: [
          { id: olderSessionId, contents: olderSession },
          { id: latestSessionId, contents: latestSession },
          { id: otherProjectSessionId, contents: otherProjectSession },
        ],
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].model, "latest-model");
    assert.equal(result.requests[0].messages[0].content, "latest question");
    assert.equal(result.requests[0].messages.at(-1).content, "new question");

    const saved = result.sessions.find(({ filename }) => (
      filename === `${latestSessionId}.jsonl`
    ));
    assert.ok(saved);
    assert.equal(saved.data.id, latestSessionId);
    assert.equal(saved.data.createdAt, latestSession.createdAt);
    assert.equal(saved.data.messages.length, 4);
  }
});

test("--continue 在当前目录没有会话时明确报错", async () => {
  const result = await captureCliRequest(["--continue"]);

  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.equal(result.stderr, "Error: 当前目录没有可恢复的会话\n");
});

test("--continue 跳过损坏的会话文件并显示警告", async () => {
  const validSession = createStoredSession({ id: latestSessionId });
  const result = await captureCliRequest(
    ["--print", "--continue", "new question"],
    "",
    {
      initialSessions: [
        { id: damagedSessionId, contents: "{not-json" },
        { id: latestSessionId, contents: validSession },
      ],
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.equal(
    result.stderr,
    `Warning: 跳过损坏的会话文件: ${damagedSessionId}.jsonl\n`,
  );
});

test("--continue 和 --resume 不能同时使用", async () => {
  const result = await captureCliRequest(["--continue", "--resume", sessionId]);

  assert.equal(result.status, 1);
  assert.equal(result.requests.length, 0);
  assert.equal(result.stderr, "Error: --continue 和 --resume 不能同时使用\n");
});

test("会话保存失败时警告但不中断后续对话", async () => {
  const result = await captureCliRequest(
    [],
    "first\nsecond\n/exit\n",
    { invalidHome: true },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 2);
  assert.equal(
    result.stderr.match(/Warning: 会话保存失败:/g)?.length,
    2,
  );
  assert.equal(result.sessions.length, 0);
});

async function captureCliRequest(args, stdin = "", options = {}) {
  const requests = [];
  const testRoot = mkdtempSync(join(tmpdir(), "mo-code-cli-"));
  const home = options.invalidHome ? join(testRoot, "home-file") : join(testRoot, "home");
  if (options.invalidHome) {
    writeFileSync(home, "not a directory");
  } else {
    mkdirSync(home);
  }
  const sessionDir = join(home, ".mo-code", "sessions");
  if (options.initialSession !== undefined) {
    mkdirSync(sessionDir, { recursive: true });
    const id = options.initialSessionId ?? options.initialSession.id;
    const contents = typeof options.initialSession === "string"
      ? options.initialSession
      : serializeStoredSession(options.initialSession);
    writeFileSync(join(sessionDir, `${id}.jsonl`), contents);
  }
  for (const sessionFile of options.initialSessions ?? []) {
    mkdirSync(sessionDir, { recursive: true });
    const contents = typeof sessionFile.contents === "string"
      ? sessionFile.contents
      : serializeStoredSession(sessionFile.contents);
    writeFileSync(join(sessionDir, `${sessionFile.id}.jsonl`), contents);
  }

  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      const response = options.responses?.[requests.length - 1]
        ?? { content: [{ type: "text", text: "done" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);

    const child = spawn(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", cliPath, ...args],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          HOME: home,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(stdin);

    const status = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    const sessions = existsSync(sessionDir)
      ? readdirSync(sessionDir).map((filename) => {
          const raw = readFileSync(join(sessionDir, filename), "utf-8");
          let data;
          let records = [];
          try {
            ({ data, records } = parseStoredSession(raw));
          } catch {
            data = undefined;
          }
          return { filename, data, records, raw };
        })
      : [];

    return { status, stdout, stderr, requests, sessions };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function createStoredSession(overrides = {}) {
  return {
    version: 1,
    id: sessionId,
    cwd: projectRoot,
    model: "saved-model",
    createdAt: "2026-07-14T08:00:00.000Z",
    updatedAt: "2026-07-14T08:05:00.000Z",
    messages: [
      { role: "user", content: "old question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "old answer" }],
      },
    ],
    ...overrides,
  };
}

function serializeStoredSession(session) {
  const header = {
    type: "session",
    version: session.version,
    id: session.id,
    cwd: session.cwd,
    model: session.model,
    createdAt: session.createdAt,
  };
  const records = [header];
  if (session.messages.length > 0) {
    records.push({
      type: "turn",
      timestamp: session.updatedAt,
      model: session.model,
      messages: session.messages,
    });
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function parseStoredSession(raw) {
  const records = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
  const [header, ...turns] = records;
  assert.equal(header.type, "session");

  const lastTurn = turns.at(-1);
  return {
    records,
    data: {
      version: header.version,
      id: header.id,
      cwd: header.cwd,
      model: lastTurn?.model ?? header.model,
      createdAt: header.createdAt,
      updatedAt: lastTurn?.timestamp ?? header.createdAt,
      messages: turns.flatMap((turn) => turn.messages),
    },
  };
}
