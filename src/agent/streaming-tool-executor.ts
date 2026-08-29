import Anthropic from "@anthropic-ai/sdk";

import {
  executeTool,
  isToolConcurrencySafe,
  type ToolContext,
  type ToolExecutionResult,
} from "../tools/index.ts";

type ToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolExecutionResult>;

type ToolExecutionOutcome =
  | { status: "completed"; output: ToolExecutionResult }
  | { status: "interrupted" };

export class StreamingToolExecutor {
  private toolUses: Anthropic.ToolUseBlock[] = [];
  private earlyExecutions = new Map<string, Promise<ToolExecutionOutcome>>();
  private reachedExecutionBarrier = false;
  private context: ToolContext;
  private execute: ToolExecutor;

  constructor(
    context: ToolContext,
    execute: ToolExecutor = executeTool,
  ) {
    this.context = context;
    this.execute = execute;
  }

  accept(block: Anthropic.ToolUseBlock): void {
    this.toolUses.push(block);

    if (!this.isConcurrencySafe(block)) {
      this.reachedExecutionBarrier = true;
      return;
    }

    if (!this.reachedExecutionBarrier) {
      this.earlyExecutions.set(block.id, this.executeBlock(block));
    }
  }

  async finish(): Promise<Anthropic.ToolResultBlockParam[]> {
    const results: Anthropic.ToolResultBlockParam[] = [];
    let index = 0;

    while (index < this.toolUses.length) {
      const toolUse = this.toolUses[index];
      const earlyExecution = this.earlyExecutions.get(toolUse.id);

      if (earlyExecution) {
        this.logToolUse(toolUse);
        results.push(this.toToolResult(toolUse, await earlyExecution));
        index++;
        continue;
      }

      if (this.context.signal?.aborted) {
        results.push(this.toToolResult(toolUse, { status: "interrupted" }));
        index++;
        continue;
      }

      if (!this.isConcurrencySafe(toolUse)) {
        this.logToolUse(toolUse);
        results.push(this.toToolResult(toolUse, await this.executeBlock(toolUse)));
        index++;
        continue;
      }

      const batch: Anthropic.ToolUseBlock[] = [];
      while (
        index < this.toolUses.length
        && this.isConcurrencySafe(this.toolUses[index])
        && !this.earlyExecutions.has(this.toolUses[index].id)
      ) {
        batch.push(this.toolUses[index]);
        index++;
      }

      for (const toolUse of batch) this.logToolUse(toolUse);
      const outputs = await Promise.all(batch.map((toolUse) => this.executeBlock(toolUse)));
      results.push(
        ...batch.map((toolUse, batchIndex) => this.toToolResult(toolUse, outputs[batchIndex])),
      );
    }

    return results;
  }

  async settle(): Promise<void> {
    await Promise.all(this.earlyExecutions.values());
  }

  private isConcurrencySafe(block: Anthropic.ToolUseBlock): boolean {
    return isToolConcurrencySafe(
      block.name,
      block.input as Record<string, unknown>,
    );
  }

  private async executeBlock(block: Anthropic.ToolUseBlock): Promise<ToolExecutionOutcome> {
    if (this.context.signal?.aborted) {
      return { status: "interrupted" };
    }

    try {
      const output = await this.execute(
        block.name,
        block.input as Record<string, unknown>,
        this.context,
      );
      return { status: "completed", output };
    } catch (error) {
      if (this.context.signal?.aborted) {
        return { status: "interrupted" };
      }
      throw error;
    }
  }

  private logToolUse(block: Anthropic.ToolUseBlock): void {
    console.log(`  -> ${block.name}(${JSON.stringify(block.input)})`);
  }

  private toToolResult(
    block: Anthropic.ToolUseBlock,
    outcome: ToolExecutionOutcome,
  ): Anthropic.ToolResultBlockParam {
    if (outcome.status === "interrupted") {
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: "Interrupted by user.",
        is_error: true,
      };
    }

    const result: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: block.id,
      content: outcome.output.content,
    };
    if (outcome.output.isError) result.is_error = true;
    return result;
  }
}
