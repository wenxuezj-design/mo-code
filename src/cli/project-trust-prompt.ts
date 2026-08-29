import type { PermissionMode } from "../permissions/index.ts";
import type { TerminalInput } from "./terminal-input.ts";

type TextOutput = {
  write(text: string): unknown;
};

export type ProjectTrustPromptDetails = {
  trustRoot: string;
  allowRules: readonly string[];
  defaultMode?: PermissionMode;
};

export class ProjectTrustPromptInterruptedError extends Error {
  constructor() {
    super("Project trust prompt interrupted");
    this.name = "ProjectTrustPromptInterruptedError";
  }
}

/** 在 Agent 构造前确认是否采用项目提供的权限扩张配置。 */
export async function promptForProjectTrust(
  terminal: TerminalInput,
  details: ProjectTrustPromptDetails,
  output: TextOutput = process.stdout,
): Promise<boolean> {
  const interruptController = new AbortController();
  const handleInterrupt = () => {
    interruptController.abort(new ProjectTrustPromptInterruptedError());
  };
  const removeInterruptListener = terminal.onInterrupt(handleInterrupt);
  process.on("SIGINT", handleInterrupt);

  try {
    output.write(
      "\n首次在此项目运行 mo-code\n\n"
      + `信任根: ${details.trustRoot}\n\n`,
    );

    if (details.allowRules.length === 0 && details.defaultMode === undefined) {
      output.write(
        "当前未发现权限扩张配置；信任后，项目未来新增的此类配置也会自动生效。\n",
      );
    } else {
      output.write("信任后将启用项目提供的权限扩张配置:\n");
      for (const rule of details.allowRules) {
        output.write(`- allow: ${rule}\n`);
      }
      if (details.defaultMode !== undefined) {
        output.write(`- defaultMode: ${details.defaultMode}\n`);
      }
    }

    output.write(
      "\n项目提供的 deny 和 ask 规则无论是否信任都会生效。\n"
      + "1. 信任并继续\n"
      + "2. 暂不信任，受限继续\n",
    );

    while (true) {
      const input = await terminal.readLine(
        "请选择 [1-2]: ",
        interruptController.signal,
      );
      if (input === undefined) return false;

      const selection = input.trim();
      if (selection === "1") return true;
      if (selection === "2") return false;

      output.write("请输入 1 或 2\n");
    }
  } finally {
    process.off("SIGINT", handleInterrupt);
    removeInterruptListener();
  }
}
