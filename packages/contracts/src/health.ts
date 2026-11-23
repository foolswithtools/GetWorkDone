import { z } from 'zod';

/** Body of `GET /healthz` (apps/api), read by the SPA. */
export const HealthResponse = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof HealthResponse>;
