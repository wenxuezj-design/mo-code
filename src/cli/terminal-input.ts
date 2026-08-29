import { createInterface, type Interface } from "node:readline";

export type TerminalInput = {
  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined>;
  redisplay(): void;
  onInterrupt(listener: () => void): () => void;
  close(): void;
};

type TerminalInputOptions = {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

type PendingRead = {
  prompt: string;
  resolve: (line: string | undefined) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** 整个交互模式只创建一个实例，避免多个 readline 同时读取 stdin。 */
export class ReadlineTerminalInput implements TerminalInput {
  private readonly readline: Interface;
  private readonly output: NodeJS.WritableStream;
  private readonly lines: string[] = [];
  private pendingRead: PendingRead | undefined;
  private closed = false;

  constructor(options: TerminalInputOptions = {}) {
    this.output = options.output ?? process.stdout;
    this.readline = createInterface({
      input: options.input ?? process.stdin,
      output: this.output,
    });

    this.readline.on("line", (line) => {
      const pending = this.takePendingRead();
      if (pending) {
        pending.resolve(line);
      } else {
        this.lines.push(line);
      }
    });
    this.readline.on("close", () => {
      this.closed = true;
      this.takePendingRead()?.resolve(undefined);
    });
  }

  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.pendingRead) {
      return Promise.reject(new Error("终端已有输入请求正在等待"));
    }

    signal?.throwIfAborted();
    this.output.write(prompt);

    const queuedLine = this.lines.shift();
    if (queuedLine !== undefined) return Promise.resolve(queuedLine);
    if (this.closed) return Promise.resolve(undefined);

    return new Promise<string | undefined>((resolve, reject) => {
      const pending: PendingRead = { prompt, resolve, reject, signal };
      if (signal) {
        pending.onAbort = () => {
          if (this.pendingRead !== pending) return;
          this.takePendingRead();
          reject(signal.reason);
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pendingRead = pending;

      // 避免 signal 在 throwIfAborted() 和事件监听之间中断而遗漏通知。
      if (signal?.aborted) pending.onAbort?.();
    });
  }

  redisplay(): void {
    if (this.pendingRead) this.output.write(this.pendingRead.prompt);
  }

  onInterrupt(listener: () => void): () => void {
    this.readline.on("SIGINT", listener);
    return () => this.readline.off("SIGINT", listener);
  }

  close(): void {
    if (!this.closed) this.readline.close();
  }

  private takePendingRead(): PendingRead | undefined {
    const pending = this.pendingRead;
    if (!pending) return undefined;

    this.pendingRead = undefined;
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }
}
