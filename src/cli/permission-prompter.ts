import type {
  PermissionPromptResult,
  PermissionPrompter,
  PermissionRequest,
} from "../permissions/index.ts";
import type { TerminalInput } from "./terminal-input.ts";

type TextOutput = {
  write(text: string): unknown;
};

export class TerminalPermissionPrompter implements PermissionPrompter {
  private readonly terminal: TerminalInput;
  private readonly output: TextOutput;

  constructor(
    terminal: TerminalInput,
    output: TextOutput = process.stdout,
  ) {
    this.terminal = terminal;
    this.output = output;
  }

  async prompt(
    request: PermissionRequest,
    reason: string,
    options: { canRemember: boolean },
  ): Promise<PermissionPromptResult> {
    const grant = options.canRemember ? request.grant : undefined;
    const canRemember = grant !== undefined;
    this.output.write(
      "\n权限确认\n"
      + `工具: ${request.toolName}\n`
      + `目标: ${request.permissionTarget}\n`
      + `原因: ${reason}\n`
      + "1. 仅允许本次\n",
    );
    if (canRemember) {
      this.output.write(
        `2. ${grant.label}\n`
        + "3. 拒绝并告诉 Agent 如何调整\n",
      );
    } else {
      this.output.write("2. 拒绝并告诉 Agent 如何调整\n");
    }

    const denyOption = canRemember ? "3" : "2";
    const selectionPrompt = canRemember ? "请选择 [1-3]: " : "请选择 [1-2]: ";
    while (true) {
      const input = await this.terminal.readLine(selectionPrompt, request.signal);
      if (input === undefined) return { action: "deny" };

      const selection = input.trim();
      if (selection === "1") return { action: "allow", remember: false };
      if (canRemember && selection === "2") {
        return { action: "allow", remember: true };
      }
      if (selection === denyOption) {
        return this.readDenialFeedback(request.signal);
      }

      this.output.write(
        canRemember
          ? "请输入 1 到 3 之间的编号\n"
          : "请输入 1 到 2 之间的编号\n",
      );
    }
  }

  private async readDenialFeedback(
    signal?: AbortSignal,
  ): Promise<PermissionPromptResult> {
    const input = await this.terminal.readLine(
      "拒绝原因（可以留空）: ",
      signal,
    );
    const feedback = input?.trim();
    return feedback
      ? { action: "deny", feedback }
      : { action: "deny" };
  }
}

export const nonInteractivePermissionPrompter: PermissionPrompter = {
  prompt: async () => ({
    action: "deny",
    feedback: "This action requires confirmation, "
      + "but --print mode is non-interactive.",
  }),
};
