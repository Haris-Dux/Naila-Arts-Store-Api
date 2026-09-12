import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProduction = config.getOrThrow<string>('app.env') === 'production';

        return {
          pinoHttp: {
            level: isProduction ? 'info' : 'debug',
            // Human-readable locally, newline-delimited JSON in production so a
            // log shipper can parse it.
            transport: isProduction ? undefined : { target: 'pino-pretty' },

            // Correlation id: honour an upstream header if present (so a trace
            // survives a proxy or the future ERP callback), otherwise mint one.
            genReqId: (req, res) => {
              const existing = req.headers['x-request-id'];
              const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },

            // Never log credentials, tokens, or card data.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.currentPassword',
                'req.body.newPassword',
                'req.body.refreshToken',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },

            autoLogging: {
              // Health probes would otherwise dominate the log volume.
              ignore: (req) => req.url === '/health' || req.url === '/health/liveness',
            },
          },
        };
      },
    }),
  ],
})
export class LoggingModule {}
