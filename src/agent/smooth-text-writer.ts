const SMOOTH_OUTPUT_INTERVAL_MS = 10;

export class SmoothTextWriter {
  private characters: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private resolveDrained!: () => void;
  private drained: Promise<void>;
  hasText = false;

  constructor() {
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve;
    });
  }

  write(text: string): void {
    const characters = Array.from(text);
    if (characters.length === 0) return;

    this.hasText = true;
    this.characters.push(...characters);
    this.pump();
  }

  finish(): Promise<void> {
    this.ended = true;
    this.resolveIfDrained();
    return this.drained;
  }

  abort(): void {
    this.ended = true;
    this.characters = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.resolveDrained();
  }

  private pump(): void {
    if (this.timer || this.characters.length === 0) return;

    process.stdout.write(this.characters.shift()!);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
      this.resolveIfDrained();
    }, SMOOTH_OUTPUT_INTERVAL_MS);
  }

  /** 平滑文字输出是否彻底结束 */
  private resolveIfDrained(): void {
    // 已经调用结束方法，不会加入新文字
    // 且 没有正在执行的输出定时器
    // 且 待输出的字符串缓冲区已经清空
    if (this.ended && !this.timer && this.characters.length === 0) {
      this.resolveDrained();
    }
  }
}
