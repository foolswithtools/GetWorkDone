import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { captureValidator } from '@getworkdone/contracts';
import { describe, expect, it, vi } from 'vitest';
import { apiLogger } from '../src/common/logger.js';
import { CaptureController } from '../src/modules/capture/capture.controller.js';
import { CaptureService } from '../src/modules/capture/capture.service.js';
import { MatcherCache } from '../src/modules/capture/matcher-cache.js';
import type { ItemsService } from '../src/modules/items/items.service.js';
import type { ProcessService } from '../src/modules/process/process.service.js';
import type { WorkTypesService } from '../src/modules/work-types/work-types.service.js';
import { definition } from './support/definitions.js';

// Unit partition: the capture service and controller against stand-in services. The real routes,
// database and span are in capture.integration.test.ts.
const workType = { id: 'wt', teamId: 'team-a', slug: 'orders', createdAt: 'c', archivedAt: null as string | null, version: { id: 'v2', version: 2, definition: definition(), createdAt: 'c' } };
const item = { id: 'i1', rowVersion: 0 };
const processed = { id: 'i1', rowVersion: 2, status: 'in_progress' };
const page = { items: [item], nextCursor: null };

function service() {
  const workTypes = { get: vi.fn(async () => workType), reviseDefinition: vi.fn(async () => workType) };
  const items = { create: vi.fn(async () => item), get: vi.fn(async () => ({ ...item, status: 'open' })), listForWorkType: vi.fn(async () => page) };
  const process = { advance: vi.fn(async () => processed) };
  const build = vi.fn(captureValidator);
  const capture = new CaptureService(workTypes as unknown as WorkTypesService, items as unknown as ItemsService, process as unknown as ProcessService, new MatcherCache(8, build));
  return { capture, workTypes, items, process, build, controller: new CaptureController(capture) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => { throw new Error('expected a rejection'); }, (error: unknown) => error);
}

describe('CaptureService', () => {
  it('a valid item is created on the latest version with a `captured` event, with only the validated data, then processed', async () => {
    const { controller, items, process } = service();
    expect(await controller.submit('team-a', 'wt', { subject: 'alice' }, { data: { title: 'x' } })).toBe(processed);
    expect(items.create).toHaveBeenCalledWith('team-a', { workTypeVersionId: 'v2', data: { title: 'x' } }, 'alice', 'captured');
    expect(process.advance).toHaveBeenCalledWith('team-a', 'i1', 0, 'alice');
  });

  // GWP#22: the item exists once created, so a processing failure after that answers it as it stands
  // (logged), rather than a 500 that would have the submitter capture it again.
  it('when advance throws after the item is created, submit answers the created item instead of throwing', async () => {
    const { capture, items, process } = service();
    process.advance.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await capture.submit('team-a', 'wt', { data: { title: 'x' } }, 'alice')).toEqual({ id: 'i1', rowVersion: 0, status: 'open' });
    expect(items.get).toHaveBeenCalledWith('team-a', 'i1');
  });

  // A failure between transitions (a dropped connection while reading the item) has no process.step span
  // of its own, so the capture.submit span records it; a lost race to an admin's resume is only a warning.
  it('a processing failure is recorded on the capture.submit span and logged; a 409 from advance is a warning', async () => {
    const spans = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    trace.setGlobalTracerProvider(provider);
    const error = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    try {
      const { capture, process } = service();
      process.advance.mockRejectedValueOnce(new Error('connection terminated'));
      await capture.submit('team-a', 'wt', { data: { title: 'x' } }, 'alice');
      const [submitted] = spans.getFinishedSpans().filter((s) => s.name === 'capture.submit');
      expect(submitted?.attributes['capture.processing_failed']).toBe(true);
      expect(submitted?.events.map((e) => e.name)).toEqual(['exception']);
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'i1' }), expect.any(String));

      process.advance.mockRejectedValueOnce(new ConflictException('The item changed since it was read; read it again'));
      await capture.submit('team-a', 'wt', { data: { title: 'x' } }, 'alice');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
      warn.mockRestore();
      await provider.shutdown();
      trace.disable();
    }
  });

  // GWP#21: a version is immutable, so its patterns are compiled on its first submit and reused after.
  it('two submits on the same version compile its patterns once; a new version compiles its own', async () => {
    const { capture, workTypes, build } = service();
    const patterned = { ...workType, version: { ...workType.version, definition: { ...definition(), fields: [{ key: 'title', label: 'T', type: 'text' as const, required: true, pattern: '[A-Z]{3}-\\d+' }] } } };
    workTypes.get.mockResolvedValue(patterned);
    await capture.submit('team-a', 'wt', { data: { title: 'ABC-1' } }, 'alice');
    await expect(capture.submit('team-a', 'wt', { data: { title: 'abc' } }, 'alice')).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(build).toHaveBeenCalledTimes(1);
    workTypes.get.mockResolvedValue({ ...patterned, version: { ...patterned.version, id: 'v3', version: 3 } });
    await capture.submit('team-a', 'wt', { data: { title: 'XYZ-2' } }, 'alice');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('an invalid item is 422 `{ errors }` keyed by field and creates nothing', async () => {
    const { capture, items } = service();
    const error = await rejection(capture.submit('team-a', 'wt', { data: { other: 1 } }, 'alice'));
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toEqual({ errors: { title: ['Required'], other: ['Unknown field'] } });
    expect(items.create).not.toHaveBeenCalled();
  });

  it('an archived work type is 409 and creates nothing (GWP#55)', async () => {
    const { capture, workTypes, items } = service();
    workTypes.get.mockResolvedValue({ ...workType, archivedAt: 'yesterday' });
    const error = await rejection(capture.submit('team-a', 'wt', { data: { title: 'x' } }, 'alice'));
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('This work type is archived');
    expect(items.create).not.toHaveBeenCalled();
  });

  it('a body that is not an object of data is a 400 from the controller', () => {
    const { controller } = service();
    expect(() => controller.submit('team-a', 'wt', { subject: 'alice' }, { data: 'x' })).toThrow(/Invalid request body/);
  });

  it('another team\'s work type is not found, for submit and list', async () => {
    const { capture, workTypes, items } = service();
    workTypes.get.mockRejectedValue(new NotFoundException());
    await expect(capture.submit('team-b', 'wt', { data: { title: 'x' } }, 'alice')).rejects.toBeInstanceOf(NotFoundException);
    await expect(capture.list('team-b', 'wt')).rejects.toBeInstanceOf(NotFoundException);
    expect(items.listForWorkType).not.toHaveBeenCalled();
  });

  it('lists a page of the work type\'s items, after the cursor given; a repeated cursor is 400', async () => {
    const { controller, items } = service();
    expect(await controller.list('team-a', 'wt')).toEqual(page);
    expect(items.listForWorkType).toHaveBeenCalledWith('team-a', 'wt', { cursor: undefined, status: undefined });
    await controller.list('team-a', 'wt', 'next');
    expect(items.listForWorkType).toHaveBeenLastCalledWith('team-a', 'wt', { cursor: 'next', status: undefined });
    expect(() => controller.list('team-a', 'wt', ['a', 'b'])).toThrow(BadRequestException);
  });

  // GWP#54: one item status, beside the cursor.
  it('passes one valid ?status= on; anything else, or a repeated one, is 400 `Invalid status`', async () => {
    const { controller, items } = service();
    await controller.list('team-a', 'wt', 'next', 'failed');
    expect(items.listForWorkType).toHaveBeenLastCalledWith('team-a', 'wt', { cursor: 'next', status: 'failed' });
    for (const status of ['nope', '', ['failed', 'open'], 'Failed']) {
      expect(() => controller.list('team-a', 'wt', undefined, status), JSON.stringify(status)).toThrow('Invalid status');
    }
    expect(items.listForWorkType).toHaveBeenCalledTimes(1);
  });

  it('a valid definition becomes the next version, parsed once by the controller (defaults filled in)', async () => {
    const { controller, workTypes } = service();
    const withoutRequired = { key: 'title', label: 'Next', type: 'text' };
    expect(await controller.addVersion('team-a', 'wt', { definition: { ...definition('Next'), fields: [withoutRequired] } })).toBe(workType);
    expect(workTypes.reviseDefinition).toHaveBeenCalledWith('team-a', 'wt', { ...definition('Next'), fields: [{ ...withoutRequired, required: false }] });
  });

  it('an invalid definition is 422 keyed by path, and a body that is not an object is a form error; nothing is written', () => {
    const { controller, workTypes } = service();
    const unsafe = { ...definition(), fields: [{ key: 'title', label: 'T', type: 'text', pattern: '(a|b)*' }] };
    const thrown = (body: unknown) => {
      try {
        void controller.addVersion('team-a', 'wt', body);
      } catch (error) {
        return error;
      }
      throw new Error('expected a 422');
    };
    const error = thrown({ definition: unsafe });
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toEqual({ errors: { 'definition.fields.0.pattern': ['Pattern could take too long to check: a repeated group contains an alternation'] } });
    expect((thrown([]) as UnprocessableEntityException).getResponse()).toEqual({ errors: { _form: [expect.any(String)] } });
    expect(workTypes.reviseDefinition).not.toHaveBeenCalled();
  });
});
