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

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const prompt = args.join(" ") || "Read the file greeting.txt and tell me what it says.";
  await new Agent().chat(prompt);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
