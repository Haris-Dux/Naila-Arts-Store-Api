import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppThrottlerGuard } from './throttling/app-throttler.guard';
import { CacheModule } from './cache/cache.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { LoggingModule } from './logging/logging.module';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ProductsModule } from './modules/products/products.module';
import { SizesModule } from './modules/sizes/sizes.module';
import { SizeChartsModule } from './modules/size-charts/size-charts.module';
import { StoreModule } from './modules/store/store.module';
import { ContentModule } from './modules/content/content.module';
import { ErpModule } from './modules/erp/erp.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { MediaModule } from './modules/media/media.module';
import { OrdersModule } from './modules/orders/orders.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { OpsModule } from './modules/ops/ops.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { UsersModule } from './modules/users/users.module';
import { ThrottlingModule } from './throttling/throttling.module';

/**
 * Composition root of the modular monolith.
 *
 * Platform concerns (config, database, cache, queues, logging, throttling) are
 * global and imported once here. Domain modules are added under `modules/` as
 * each migration phase lands; they talk to each other through exported services
 * for synchronous work and through domain events for side effects.
 */
@Module({
  imports: [
    // Platform
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    CacheModule,
    JobsModule,
    ThrottlingModule,
    EventEmitterModule.forRoot({
      // Namespaced event names: 'order.placed', 'shipment.created', …
      wildcard: true,
      delimiter: '.',
      // Surface handler errors instead of swallowing them silently.
      ignoreErrors: false,
    }),
    HealthModule,
    StoreModule,

    // Domain modules
    UsersModule,
    AuthModule,
    MediaModule,
    CategoriesModule,
    SizesModule,
    SizeChartsModule,
    ProductsModule,
    ContentModule,
    InventoryModule,
    ErpModule,
    OutboxModule,
    OrdersModule,
    PaymentsModule,
    ShippingModule,
    NotificationsModule,
    OpsModule,
    AnalyticsModule,

    // Remaining phases:
    //   Phase 6 — PaymentsModule
    //   Phase 7 — ShippingModule
    //   Phase 8 — NotificationsModule
    //   Phase 9 — ErpModule
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
