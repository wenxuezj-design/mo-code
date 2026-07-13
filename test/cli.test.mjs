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

test("新会话使用 UUID，并在每轮完成后覆盖同一个 JSON 文件", async () => {
  const result = await captureCliRequest([], "first\nsecond\n/exit\n");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 2);
  assert.equal(result.sessions.length, 1);

  const [{ filename, data: session }] = result.sessions;
  assert.match(
    session.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(filename, `${session.id}.json`);
  assert.equal(session.version, 1);
  assert.equal(session.cwd, projectRoot);
  assert.equal(session.model, "mock");
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages.at(-2).content, "second");
  assert.ok(Date.parse(session.createdAt));
  assert.ok(Date.parse(session.updatedAt));
});

test("会话 JSON 保存完整的 tool_use 和 tool_result", async () => {
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

    const sessionDir = join(home, ".mo-code", "sessions");
    const sessions = existsSync(sessionDir)
      ? readdirSync(sessionDir).map((filename) => ({
          filename,
          data: JSON.parse(readFileSync(join(sessionDir, filename), "utf-8")),
        }))
      : [];

    return { status, stdout, stderr, requests, sessions };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    rmSync(testRoot, { recursive: true, force: true });
  }
}
