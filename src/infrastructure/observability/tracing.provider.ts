import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { shutdownTracing } from './tracing';

@Injectable()
export class TracingShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTracing();
  }
}
