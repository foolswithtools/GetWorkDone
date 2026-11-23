import { Controller, Get, Injectable, NotFoundException, Param } from '@nestjs/common';
import type { DeliveredKind, DeliveryResponse } from '@getworkdone/contracts';
import { Database } from '../database/database.js';

/** An item's deliveries, for the item view's deliveries panel. Scoped by teamId: another team's item is not found. */
@Injectable()
export class DeliveriesService {
  constructor(private readonly db: Database) {}

  async list(teamId: string, itemId: string): Promise<DeliveryResponse[]> {
    const item = await this.db.client.item.findFirst({ where: { id: itemId, teamId }, select: { id: true } });
    if (!item) throw new NotFoundException('Item not found');
    const rows = await this.db.client.delivery.findMany({ where: { itemId, teamId }, orderBy: [{ createdAt: 'asc' }, { outputId: 'asc' }] });
    return rows.map((d) => ({
      id: d.id, outputId: d.outputId, kind: d.kind as DeliveredKind, status: d.status, attempts: d.attempts, lastError: d.lastError,
      nextAttemptAt: d.nextAttemptAt.toISOString(), deliveredAt: d.deliveredAt?.toISOString() ?? null, updatedAt: d.updatedAt.toISOString(),
    }));
  }
}

// Members of the team only (team-member.guard.ts).
@Controller('api/v1/teams/:teamId/items/:itemId/deliveries')
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get()
  list(@Param('teamId') teamId: string, @Param('itemId') itemId: string): Promise<DeliveryResponse[]> {
    return this.deliveries.list(teamId, itemId);
  }
}
