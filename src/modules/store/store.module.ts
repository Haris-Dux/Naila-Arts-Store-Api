import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';

/**
 * Read-only exposure of deploy-time store settings.
 *
 * No service and no models: every value comes from ConfigService, which is
 * global. The module exists only to own the controller.
 */
@Module({ controllers: [StoreController] })
export class StoreModule {}
