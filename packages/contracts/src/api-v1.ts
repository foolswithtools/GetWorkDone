// Request and response bodies of the /api/v1 routes added by GWP#2, GWP#3 (`me`), GWP#4 (capture),
// GWP#5 (process), GWP#23 (editing an item's data), GWP#20 and GWP#99 (team members) and GWP#54 (cancel, a step's decision) (apps/api/src/modules). The domain shapes themselves come from domain.ts.
import { z } from 'zod';
import { CaptureField, ItemStatus, ProcessStep, WorkTypeDefinition } from './domain.js';

/** A work type's slug, unique within its team: lower kebab case, starting with a letter. */
export const Slug = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const CreateTeamRequest = z.object({ name: z.string().min(1).max(120) });
export const CreateWorkTypeRequest = z.object({ slug: Slug, definition: WorkTypeDefinition });

/** POST /api/v1/teams/:teamId/work-types/:id/versions (GWP#4): the next version's whole definition. */
export const CreateWorkTypeVersionRequest = z.object({ definition: WorkTypeDefinition });
/**
 * POST /api/v1/teams/:teamId/work-types/:id/items (GWP#4): the captured values, field key -> value. The
 * envelope is checked here; the values are checked against the latest version by validateCapture.
 */
export const CreateItemRequest = z.object({ data: z.record(z.string(), z.unknown()) }).strict();
/** The 422 body of a capture or a version that fails validation: messages keyed by field (capture.ts). */
export const CaptureErrorResponse = z.object({ errors: z.record(z.string(), z.array(z.string())) });

export const TeamRole = z.enum(['member', 'admin']);
export const TeamResponse = z.object({ id: z.string(), name: z.string(), createdAt: z.string() });
/**
 * POST /api/v1/teams/:teamId/members (GWP#20; admins): the identity's subject, as the identity provider
 * gives it (the OIDC `sub`, at most 255 characters), and its role. Surrounding spaces are dropped.
 */
export const AddTeamMemberRequest = z.object({ subject: z.string().trim().min(1).max(255), role: TeamRole }).strict();
/**
 * GET /api/v1/teams/:teamId/members (GWP#20; admins) lists these, oldest first; the POST answers one.
 * `email` and `displayName` are what the member's identity provider asserted at their last sign-in
 * (GWP#99), each null until they have signed in; `displayName` is also null when it asserted no name.
 */
export const TeamMemberResponse = z.object({
  subject: z.string(), role: TeamRole, createdAt: z.string(), email: z.string().nullable(), displayName: z.string().nullable(),
});
export const WorkTypeResponse = z.object({
  id: z.string(), teamId: z.string(), slug: z.string(), createdAt: z.string(),
  /** The latest version; versions are immutable, a change writes the next one. */
  version: z.object({ id: z.string(), version: z.number().int(), definition: WorkTypeDefinition, createdAt: z.string() }),
  /**
   * GWP#6: only in the answer to the save (create or new version) that generated them, output id ->
   * signing secret, for webhook outputs new to the work type. Shown once; no read returns them.
   */
  webhookSecrets: z.record(z.string(), z.string()).optional(),
  /** GWP#55: when the work type was archived, or null; while archived, capture and new versions are 409. */
  archivedAt: z.string().nullable(),
});
/** POST /api/v1/teams/:teamId/work-types/:id/archive and .../unarchive (GWP#55; admins): an empty object. */
export const ArchiveWorkTypeRequest = z.object({}).strict();
export const ItemEventResponse = z.object({
  seq: z.number().int(), type: z.string(), actorSubject: z.string().nullable(), at: z.string(), payload: z.unknown(),
});
export const ItemResponse = z.object({
  id: z.string(), teamId: z.string(), workTypeVersionId: z.string(), data: z.record(z.string(), z.unknown()),
  status: ItemStatus, currentStepIndex: z.number().int(), rowVersion: z.number().int(),
  createdAt: z.string(), updatedAt: z.string(), events: z.array(ItemEventResponse),
});
/**
 * GET /api/v1/teams/:teamId/work-types/:id/items (GWP#21): one page of the work type's items, newest
 * first. `nextCursor` is passed back as `?cursor=` for the next page; null on the last page.
 */
export const ItemPage = z.object({ items: z.array(ItemResponse), nextCursor: z.string().nullable() });
/**
 * GET /api/v1/teams/:teamId/items/:itemId, and the answer to a step's complete or retry (GWP#5): the item
 * with the steps of the version it was captured under, in execution order, and that version's fields,
 * which an admin's data edit is validated against (GWP#23).
 */
export const ItemDetailResponse = ItemResponse.extend({ steps: z.array(ProcessStep), fields: z.array(CaptureField) });
/**
 * POST .../items/:itemId/steps/:stepId/complete and .../retry (GWP#5): the item's rowVersion as the caller
 * last read it. A stale or replayed request no longer matches it and is 409 (docs/process.md).
 */
export const StepTransitionRequest = z.object({ rowVersion: z.number().int().min(0) }).strict();
/**
 * POST .../items/:itemId/steps/:stepId/complete (GWP#54): the rowVersion, and the person's decision and
 * comment, recorded on the step_completed event and never written to the item's data. A step that lists
 * `decisions` needs one of them (422 keyed `decision`); a step without accepts any text or none.
 */
export const CompleteStepRequest = StepTransitionRequest.extend({ decision: z.string().min(1).max(40).optional(), comment: z.string().max(2000).optional() }).strict();
/** POST /api/v1/teams/:teamId/items/:itemId/cancel (GWP#54; admins): the rowVersion and an optional reason for the `cancelled` event. */
export const CancelItemRequest = StepTransitionRequest.extend({ reason: z.string().max(2000).optional() }).strict();
/**
 * POST /api/v1/teams/:teamId/items/:itemId/data (GWP#23; admins): the item's rowVersion as the caller last
 * read it, and the item's whole new data, checked by validateCapture against the item's own version.
 */
export const EditItemDataRequest = z.object({ rowVersion: z.number().int().min(0), data: z.record(z.string(), z.unknown()) }).strict();

/**
 * GET /api/v1/me: the signed-in identity, the token the SPA sends as X-GWD-CSRF, and its teams. `r4c` is
 * present only when the instance has a request-4-change signing key (GWP#10, docs/r4c.md): the SPA then
 * embeds the widget with `app-id` set to `appId`.
 */
export const MeResponse = z.object({
  subject: z.string(), email: z.string(), displayName: z.string().optional(), csrfToken: z.string(),
  teams: z.array(z.object({ id: z.string(), name: z.string(), role: TeamRole })),
  r4c: z.object({ appId: z.string() }).optional(),
});

export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;
export type CreateWorkTypeRequest = z.infer<typeof CreateWorkTypeRequest>;
export type CreateWorkTypeVersionRequest = z.infer<typeof CreateWorkTypeVersionRequest>;
export type CreateItemRequest = z.infer<typeof CreateItemRequest>;
export type CaptureErrorResponse = z.infer<typeof CaptureErrorResponse>;
export type TeamRole = z.infer<typeof TeamRole>;
export type TeamResponse = z.infer<typeof TeamResponse>;
export type AddTeamMemberRequest = z.infer<typeof AddTeamMemberRequest>;
export type TeamMemberResponse = z.infer<typeof TeamMemberResponse>;
export type WorkTypeResponse = z.infer<typeof WorkTypeResponse>;
export type ItemEventResponse = z.infer<typeof ItemEventResponse>;
export type ItemResponse = z.infer<typeof ItemResponse>;
export type ItemPage = z.infer<typeof ItemPage>;
export type ItemDetailResponse = z.infer<typeof ItemDetailResponse>;
export type StepTransitionRequest = z.infer<typeof StepTransitionRequest>;
export type CompleteStepRequest = z.infer<typeof CompleteStepRequest>;
export type CancelItemRequest = z.infer<typeof CancelItemRequest>;
export type EditItemDataRequest = z.infer<typeof EditItemDataRequest>;
export type MeResponse = z.infer<typeof MeResponse>;
