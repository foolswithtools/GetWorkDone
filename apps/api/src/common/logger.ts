// The API's logger: the redacting pino logger from @getworkdone/telemetry (stdout JSON plus OTel log
// records, D-044), and an adapter so Nest's own messages go through it too. stdout carries the lines at
// LOG_STDOUT_LEVEL and above (GWP#58, @getworkdone/telemetry's createLogger).

import { hostname } from 'node:os';
import type { LoggerService } from '@nestjs/common';
import { createLogger, otelOptionsFromEnv, type Logger } from '@getworkdone/telemetry';

/**
 * Every line's bindings (GWP#58): the four resource attributes main.ts gives setupOtel, named as Loki
 * promotes them (dots to underscores), so a CloudWatch line and a Loki line carry the same field names.
 * The OTel record leaves the last three to its resource attributes.
 */
export function apiLoggerBindings(env: NodeJS.ProcessEnv, host: string = hostname()): Record<string, string> {
  const resource = otelOptionsFromEnv('getworkdone-api', env, host);
  return {
    service: resource.serviceName,
    service_version: resource.serviceVersion,
    deployment_environment: resource.deploymentEnvironment,
    prebutton_instance: resource.instanceName,
  };
}

export const apiLogger: Logger = createLogger(apiLoggerBindings(process.env));
// LOG_LEVEL (default info); the test configs set `silent`. An unknown value falls back to info rather
// than stopping the API from starting.
const level = process.env.LOG_LEVEL || 'info';
apiLogger.level = level in apiLogger.levels.values || level === 'silent' ? level : 'info';

function text(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message);
}

export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger = apiLogger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, text(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({ context, stack }, text(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, text(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, text(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, text(message));
  }
}
