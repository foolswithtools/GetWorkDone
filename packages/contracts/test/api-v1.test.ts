import { describe, expect, it } from 'vitest';
import { CancelItemRequest, CaptureErrorResponse, CompleteStepRequest, CreateItemRequest, CreateTeamRequest, CreateWorkTypeRequest, CreateWorkTypeVersionRequest, MeResponse, Slug } from '../src/api-v1.js';

const definition = {
  fields: [{ key: 'title', label: 'Title', type: 'text' }],
  steps: [],
  outputs: [{ id: 'keep', kind: 'persist', config: {} }],
};

describe('api/v1 request bodies', () => {
  it('a team needs a name of 1 to 120 characters', () => {
    expect(CreateTeamRequest.parse({ name: 'Ops' })).toEqual({ name: 'Ops' });
    expect(CreateTeamRequest.safeParse({ name: '' }).success).toBe(false);
    expect(CreateTeamRequest.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
  });

  it('a work type slug is lower kebab case starting with a letter', () => {
    expect(Slug.safeParse('purchase-orders').success).toBe(true);
    for (const slug of ['Purchase', '1st', 'a_b', '', 'a'.repeat(64)]) expect(Slug.safeParse(slug).success, slug).toBe(false);
  });

  it('a work type is created from a slug and a valid definition', () => {
    expect(CreateWorkTypeRequest.parse({ slug: 'orders', definition }).definition.fields[0]?.required).toBe(false);
    expect(CreateWorkTypeRequest.safeParse({ slug: 'orders', definition: { ...definition, outputs: [] } }).success).toBe(false);
  });
});

describe('capture request bodies (GWP#4)', () => {
  it('a version is a whole definition, checked at definition time', () => {
    expect(CreateWorkTypeVersionRequest.parse({ definition }).definition.fields[0]?.key).toBe('title');
    const unsafe = { ...definition, fields: [{ key: 'title', label: 'Title', type: 'text', pattern: '(a+)+$' }] };
    expect(CreateWorkTypeVersionRequest.safeParse({ definition: unsafe }).success).toBe(false);
  });

  it('an item carries its captured values as an object under `data`, validated later against the latest version', () => {
    expect(CreateItemRequest.parse({ data: { title: 'x', extra: 1 } })).toEqual({ data: { title: 'x', extra: 1 } });
    for (const body of [{}, { data: 'x' }, { data: [] }, { data: {}, other: 1 }]) expect(CreateItemRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it('a 422 body is errors keyed by field', () => {
    expect(CaptureErrorResponse.parse({ errors: { title: ['Required'] } })).toEqual({ errors: { title: ['Required'] } });
  });
});

describe('GET /api/v1/me (GWP#3)', () => {
  it('is the identity, its CSRF token and its team memberships with their roles', () => {
    const me = { subject: 's', email: 'e@example.test', csrfToken: 't', teams: [{ id: 'a', name: 'A', role: 'admin' }] };
    expect(MeResponse.parse(me)).toEqual(me);
    expect(MeResponse.parse({ ...me, displayName: 'S' }).displayName).toBe('S');
    expect(MeResponse.safeParse({ ...me, teams: [{ id: 'a', name: 'A', role: 'owner' }] }).success).toBe(false);
  });
});

describe('cancel and step completion bodies (GWP#54)', () => {
  it('a cancel is the rowVersion and an optional reason of at most 2000 characters, and nothing else', () => {
    expect(CancelItemRequest.parse({ rowVersion: 3 })).toEqual({ rowVersion: 3 });
    expect(CancelItemRequest.parse({ rowVersion: 3, reason: 'captured twice' })).toEqual({ rowVersion: 3, reason: 'captured twice' });
    expect(CancelItemRequest.safeParse({ rowVersion: 3, reason: 'x'.repeat(2000) }).success).toBe(true);
    for (const body of [{}, { rowVersion: -1 }, { rowVersion: 3, reason: 'x'.repeat(2001) }, { rowVersion: 3, reason: 7 }, { rowVersion: 3, note: 'x' }]) {
      expect(CancelItemRequest.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('a completion is the rowVersion, an optional decision of 1 to 40 characters and an optional comment of at most 2000, and nothing else', () => {
    expect(CompleteStepRequest.parse({ rowVersion: 1 })).toEqual({ rowVersion: 1 });
    expect(CompleteStepRequest.parse({ rowVersion: 1, decision: 'approve', comment: 'ok' })).toEqual({ rowVersion: 1, decision: 'approve', comment: 'ok' });
    expect(CompleteStepRequest.safeParse({ rowVersion: 1, decision: 'x'.repeat(40), comment: 'x'.repeat(2000) }).success).toBe(true);
    for (const body of [{ rowVersion: 1, decision: 'x'.repeat(41) }, { rowVersion: 1, decision: '' }, { rowVersion: 1, comment: 'x'.repeat(2001) }, { rowVersion: 1, reason: 'x' }]) {
      expect(CompleteStepRequest.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false);
    }
  });
});
