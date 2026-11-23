import { z } from 'zod';

/**
 * Body of `GET /readyz` (apps/api, GWP#53): 200 with the first shape when the database answered the
 * readiness check, 503 with the second when it did not.
 */
export const ReadyResponse = z.union([
  z.object({ status: z.literal('ok'), database: z.literal('ok') }).strict(),
  z.object({ status: z.literal('degraded'), database: z.literal('down') }).strict(),
]);
export type ReadyResponse = z.infer<typeof ReadyResponse>;
