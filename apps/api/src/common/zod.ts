import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { FORM_ERROR_KEY, type CaptureErrors } from '@getworkdone/contracts';
import type { z } from 'zod';

/** Parse a request body with a contracts schema; a mismatch is a 400 listing each issue's path and message. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException({ message: 'Invalid request body', issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return result.data;
}

/** A failed parse as CaptureErrors keyed by each issue's dotted path (`definition.fields.0.pattern`). */
export function errorsByPath(error: z.ZodError): CaptureErrors {
  const errors: CaptureErrors = {};
  for (const issue of error.issues) (errors[issue.path.length > 0 ? issue.path.join('.') : FORM_ERROR_KEY] ??= []).push(issue.message);
  return errors;
}

/**
 * Parse a body that carries a work type definition (GWP#21, docs/capture.md): a mismatch is 422
 * `{ errors }` keyed by path, the shape the builder shows beside each setting, on every definition route.
 */
export function parseDefinitionBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new UnprocessableEntityException({ errors: errorsByPath(result.error) });
  return result.data;
}
