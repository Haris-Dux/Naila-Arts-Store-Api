import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { SkipResponseWrap } from '../common/decorators/skip-response-wrap.decorator';
import { Public } from '../modules/auth/decorators/public.decorator';
import { RedisHealthIndicator } from './redis.health';

@ApiTags('health')
// Version-neutral and outside the global /api prefix: probe URLs are contracts
// with the orchestrator, so they must stay at /health regardless of API version.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
@SkipThrottle()
// Probes come from the orchestrator, which holds no credentials.
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Readiness: is this instance able to serve traffic? Checks every dependency.
   * Orchestrators read the raw Terminus body, so the response envelope is skipped.
   */
  @Get()
  @HealthCheck()
  @SkipResponseWrap()
  @ApiOperation({ summary: 'Readiness probe — checks MongoDB and Redis' })
  check() {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.mongoose.pingCheck('mongodb', { timeout: 3000 }),
      (): Promise<HealthIndicatorResult> => this.redis.isHealthy('redis'),
    ]);
  }

  /**
   * Liveness: is the process itself up? Deliberately dependency-free — a Mongo
   * blip should not cause the orchestrator to kill an otherwise healthy process.
   */
  @Get('liveness')
  @SkipResponseWrap()
  @ApiOperation({ summary: 'Liveness probe — process only, no dependencies' })
  liveness() {
    return { status: 'ok', uptime: process.uptime() };
  }
}
