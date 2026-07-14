import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { Agent } from "./agent-loop.ts";
import {
  createSession,
  loadSession,
  saveSession,
  type SessionData,
} from "./session.ts";

export const HELP_TEXT = `Usage: mo-code [options] [prompt...]

Options:
  -h, --help                         显示帮助信息
  -v, --version                      显示当前版本
  -p, --print                        执行非交互任务后退出
  -c, --continue                     继续当前项目最近的会话
  -r, --resume <id>                  恢复指定 ID 的会话
  -m, --model <model>                设置本次会话使用的模型
      --permission-mode <mode>       设置权限模式
      --dangerously-skip-permissions 跳过权限检查，仅用于隔离环境
      --mortis                       --dangerously-skip-permissions 的别名
      --effort <level>               设置模型的推理强度
      --max-budget-usd <amount>      限制本次运行的最大费用
`;

type ParsedArgs = {
  help: boolean;
  version: boolean;
  print: boolean;
  model?: string;
  permissionMode?: string;
  resume?: string;
  prompt?: string;
};

export function parseArgs(args: string[]): ParsedArgs {
  let help = false;
  let version = false;
  let print = false;
  let model: string | undefined;
  let permissionMode: string | undefined;
  let resume: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--print" || arg === "-p") {
      print = true;
    } else if (arg === "--model" || arg === "-m") {
      model = args[++i];
    } else if (arg === "--permission-mode") {
      permissionMode = args[++i];
    } else if (arg === "--resume" || arg === "-r") {
      const sessionId = args[++i];
      if (!sessionId || sessionId.startsWith("-")) {
        throw new Error(`${arg} 需要会话 ID`);
      }
      resume = sessionId;
    } else {
      positional.push(arg);
    }
  }

  return {
    help,
    version,
    print,
    model,
    permissionMode,
    resume,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}

function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
  ) as { version?: unknown };

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json 中缺少有效的 version");
  }

  return packageJson.version;
}

function saveAgentSession(agent: Agent, session: SessionData): void {
  session.messages = agent.getMessages();

  try {
    saveSession(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: 会话保存失败: ${message}\n`);
  }
}

async function chatAndSave(agent: Agent, session: SessionData, input: string): Promise<void> {
  await agent.chat(input);
  saveAgentSession(agent, session);
}

async function runRepl(
  agent: Agent,
  session: SessionData,
  initialPrompt?: string,
): Promise<void> {
  if (initialPrompt) await chatAndSave(agent, session, initialPrompt);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (input === "/exit" || input === "/quit") break;
    if (input) await chatAndSave(agent, session, input);
    rl.prompt();
  }

  rl.close();
}

function reportCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    reportCliError(error);
    return;
  }

  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (parsed.version) {
    process.stdout.write(`${getVersion()} (mo-code)\n`);
    return;
  }

  if (parsed.permissionMode) {
    process.stderr.write("Warning: --permission-mode 暂未实现权限控制\n");
  }

  let agent: Agent;
  let session: SessionData;

  if (parsed.resume) {
    try {
      session = loadSession(parsed.resume);
    } catch (error) {
      reportCliError(error);
      return;
    }

    // 当前版本要求回到原工作目录，避免旧会话上下文操作到其他项目。
    // Claude Code 对同仓库 worktree 有更灵活的处理，后续再扩展。
    if (session.cwd !== process.cwd()) {
      process.stderr.write(
        `Error: 会话 ${session.id} 属于另一个工作目录\n`
        + `  会话目录: ${session.cwd}\n`
        + `  当前目录: ${process.cwd()}\n`
        + `请切换到会话目录后重新运行 mo-code --resume ${session.id}\n`,
      );
      process.exitCode = 1;
      return;
    }

    agent = new Agent({ model: parsed.model ?? session.model });
    agent.restoreMessages(session.messages);
    session.model = agent.getModel();
  } else {
    agent = new Agent({ model: parsed.model });
    session = createSession(process.cwd(), agent.getModel());
  }

  if (parsed.print) {
    if (parsed.prompt) await chatAndSave(agent, session, parsed.prompt);
    return;
  }

  await runRepl(agent, session, parsed.prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
