export const HELP_TEXT = `Usage: mo-code [options] [prompt...]

Options:
  -h, --help                         显示帮助信息
  -v, --version                      显示当前版本
  -p, --print                        执行非交互任务后退出
  -c, --continue                     继续当前项目最近的会话
  -r, --resume [id]                  恢复指定会话；未提供 ID 时从列表选择
      --delete-session [id]          删除会话；未提供 ID 时从列表选择
  -m, --model <model>                设置本次会话使用的模型
      --thinking                     开启 Extended Thinking
      --permission-mode <mode>       设置权限模式
      --dangerously-skip-permissions 跳过权限检查，仅用于隔离环境
      --mortis                       --dangerously-skip-permissions 的别名
      --max-budget-usd <amount>      限制本次运行的最大费用
`;

export type ParsedArgs = {
  help: boolean;
  version: boolean;
  print: boolean;
  continueSession: boolean;
  resume: boolean;
  deleteSession: boolean;
  thinking: boolean;
  model?: string;
  permissionMode?: string;
  resumeId?: string;
  deleteSessionId?: string;
  prompt?: string;
};

export function parseArgs(args: string[]): ParsedArgs {
  let help = false;
  let version = false;
  let print = false;
  let continueSession = false;
  let resume = false;
  let deleteSessionRequested = false;
  let thinking = false;
  let model: string | undefined;
  let permissionMode: string | undefined;
  let resumeId: string | undefined;
  let deleteSessionId: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--print" || arg === "-p") {
      print = true;
    } else if (arg === "--continue" || arg === "-c") {
      continueSession = true;
    } else if (arg === "--model" || arg === "-m") {
      model = args[++i];
    } else if (arg === "--thinking") {
      thinking = true;
    } else if (arg === "--permission-mode") {
      permissionMode = args[++i];
    } else if (arg === "--resume" || arg === "-r") {
      resume = true;
      const sessionId = args[i + 1];
      if (sessionId && !sessionId.startsWith("-")) {
        resumeId = sessionId;
        i++;
      }
    } else if (arg === "--delete-session") {
      deleteSessionRequested = true;
      const sessionId = args[i + 1];
      if (sessionId && !sessionId.startsWith("-")) {
        deleteSessionId = sessionId;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  if (continueSession && resume) {
    throw new Error("--continue 和 --resume 不能同时使用");
  }
  if (deleteSessionRequested && (continueSession || resume)) {
    throw new Error("--delete-session 不能和 --continue 或 --resume 同时使用");
  }

  return {
    help,
    version,
    print,
    continueSession,
    resume,
    deleteSession: deleteSessionRequested,
    thinking,
    model,
    permissionMode,
    resumeId,
    deleteSessionId,
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}
