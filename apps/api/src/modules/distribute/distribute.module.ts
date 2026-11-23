import { Module, type DynamicModule } from '@nestjs/common';
import { DeliveriesController, DeliveriesService } from './deliveries.controller.js';
import { DeliveryBacklog } from './delivery.backlog.js';
import { DeliveryWorker } from './delivery.worker.js';
import { DISTRIBUTE_RUNTIME, distributeRuntime, type DistributeOptions } from './distribute.options.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';

/**
 * Distribution (GWP#6, docs/outputs.md): the delivery worker, the backlog gauge (GWP#53), the deliveries read and exports. Global, so
 * the process engine reaches the worker without importing this module (it is configured once, here).
 */
@Module({})
export class DistributeModule {
  static forRoot(options: DistributeOptions = {}): DynamicModule {
    return {
      module: DistributeModule,
      global: true,
      controllers: [DeliveriesController, ExportsController],
      providers: [{ provide: DISTRIBUTE_RUNTIME, useFactory: () => distributeRuntime(options) }, DeliveryWorker, DeliveryBacklog, DeliveriesService, ExportsService],
      exports: [DeliveryWorker, DISTRIBUTE_RUNTIME],
    };
  }
}
