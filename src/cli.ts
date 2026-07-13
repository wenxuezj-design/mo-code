import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { Agent } from "./agent-loop.ts";

export const HELP_TEXT = `Usage: mo-code [options] [prompt...]

Options:
  -h, --help                         显示帮助信息
  -v, --version                      显示当前版本
  -p, --print                        执行非交互任务后退出
  -c, --continue                     继续当前项目最近的会话
  -r, --resume <session>             恢复指定 ID 或名称的会话
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
  prompt?: string;
};

export function parseArgs(args: string[]): ParsedArgs {
  let help = false;
  let version = false;
  let print = false;
  let model: string | undefined;
  let permissionMode: string | undefined;
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

async function runRepl(agent: Agent, initialPrompt?: string): Promise<void> {
  if (initialPrompt) await agent.chat(initialPrompt);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (input === "/exit" || input === "/quit") break;
    if (input) await agent.chat(input);
    rl.prompt();
  }

  rl.close();
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args);

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

  const agent = new Agent({ model: parsed.model });

  if (parsed.print) {
    if (parsed.prompt) await agent.chat(parsed.prompt);
    return;
  }

  await runRepl(agent, parsed.prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
