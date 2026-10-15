import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TELEMETRY } from '@/application/telemetry';
import type { PrometheusTelemetry } from '@/infrastructure/observability/prometheus-telemetry';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(TELEMETRY) private readonly telemetry: PrometheusTelemetry) {}

  @Get()
  async metrics(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.telemetry.registry.contentType);
    response.send(await this.telemetry.registry.metrics());
  }
}
