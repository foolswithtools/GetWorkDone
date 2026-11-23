import { Module } from '@nestjs/common';
import { Database } from '../database/database.js';
import { columnReady } from '../database/schema-ready.js';
import { ItemsModule } from '../items/items.module.js';
import { ProcessController } from './process.controller.js';
import { ProcessService } from './process.service.js';
import { STUCK_ITEM_COLUMN, StuckItemSweeper, stuckItemSweeperOptionsFromEnv } from './stuck-item-sweeper.js';

@Module({
  imports: [ItemsModule],
  controllers: [ProcessController],
  providers: [
    ProcessService,
    {
      provide: StuckItemSweeper,
      useFactory: (process: ProcessService, db: Database) => new StuckItemSweeper(process, { ...stuckItemSweeperOptionsFromEnv(), tableReady: () => columnReady(db, STUCK_ITEM_COLUMN.table, STUCK_ITEM_COLUMN.column) }),
      inject: [ProcessService, Database],
    },
  ],
  exports: [ProcessService],
})
export class ProcessModule {}
