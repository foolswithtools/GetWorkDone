import { captureValidator, type CaptureField, type CaptureResult, type CaptureValidator } from '@getworkdone/contracts';

/**
 * How many versions' validators are kept. Each holds its compiled patterns, at most
 * MAX_DEFINITION_PATTERN_STATES matcher states (capture.ts), so the cache's memory is bounded too.
 */
export const MATCHER_CACHE_SIZE = 256;

/**
 * The compiled capture validator of each work type version (GWP#21, docs/capture.md), so a submit does
 * not rebuild the matchers for the definition's patterns. Keyed by workTypeVersionId: a version is
 * immutable (a database trigger rejects any UPDATE), so an entry never goes stale and needs no
 * invalidation. Least recently used versions are evicted past `capacity`.
 */
export class MatcherCache {
  private readonly validators = new Map<string, CaptureValidator>();

  constructor(private readonly capacity = MATCHER_CACHE_SIZE, private readonly build: (fields: CaptureField[]) => CaptureValidator = captureValidator) {
    if (!(capacity >= 1)) throw new Error('MatcherCache capacity must be at least 1');
  }

  get size(): number {
    return this.validators.size;
  }

  /** Validate an item's data against `version`'s fields, compiling them on the version's first use. */
  validate(version: { id: string; definition: { fields: CaptureField[] } }, input: unknown): CaptureResult {
    let validator = this.validators.get(version.id);
    if (validator) {
      this.validators.delete(version.id); // re-inserted below, as the most recently used
    } else {
      validator = this.build(version.definition.fields);
      if (this.validators.size >= this.capacity) this.validators.delete(this.validators.keys().next().value as string);
    }
    this.validators.set(version.id, validator);
    return validator(input);
  }
}
