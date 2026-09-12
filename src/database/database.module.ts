import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { applyBaseTransforms } from '../common/schemas/base.schema';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('Mongoose');

        return {
          uri: config.getOrThrow<string>('database.uri'),

          /**
           * The schemas are the database's definition. There are no migrations:
           * on startup Mongoose creates any missing collection and builds every
           * index a schema declares, so attaching an empty database and starting
           * the app is the whole setup. The first administrator is created the
           * same way (AdminSeedService).
           *
           * The trade-off: an index added to a large, live collection is built at
           * startup. MongoDB builds it without blocking reads or writes, but a
           * very big collection is still better indexed ahead of the deploy.
           */
          autoIndex: true,
          autoCreate: true,
          // Fail fast rather than buffering commands against a dead connection —
          // a hung request is harder to diagnose than a clean error.
          bufferCommands: false,
          serverSelectionTimeoutMS: 10_000,
          // Reads and writes both land on the primary by default, which is what
          // transactional checkout requires. Read replicas can be opted into per
          // query later.
          retryWrites: true,
          connectionFactory: (connection: Connection) => {
            connection.on('connected', () => logger.log('MongoDB connected'));
            connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
            connection.on('reconnected', () => logger.log('MongoDB reconnected'));
            connection.on('error', (error: Error) =>
              logger.error(`MongoDB error: ${error.message}`),
            );

            // Applied once, centrally, so no schema can forget to hide __v or
            // expose a raw _id.
            connection.plugin(applyBaseTransforms);
            return connection;
          },
        };
      },
    }),
  ],
})
export class DatabaseModule {}
