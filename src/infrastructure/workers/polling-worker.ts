import { Logger } from '@nestjs/common';

export class PollingWorker {
  private readonly logger: Logger;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<boolean>,
    private readonly idleMs: number,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let hasMoreWork = false;
      try {
        hasMoreWork = await this.tick();
      } catch (error) {
        this.logger.error(`${this.name} tick failed: ${(error as Error).message}`);
      }
      if (!hasMoreWork && this.running) {
        await this.sleep(this.idleMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
