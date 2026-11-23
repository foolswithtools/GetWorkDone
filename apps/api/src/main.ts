// The API process: telemetry first, then the Nest app on PORT (default 8080). On SIGTERM (ECS stop)
// or SIGINT the app closes, then telemetry flushes what it buffered, then the process exits.
// service.instance.id is the ECS task id when the task metadata endpoint gives one (GWP#86).
import { ecsTaskId, otelOptionsFromEnv, setupOtel, shutdownOtel, startProfiling } from '@getworkdone/telemetry';
import { createApp } from './app.js';
import { apiLogger } from './common/logger.js';

const otel = { ...otelOptionsFromEnv('getworkdone-api', process.env), serviceInstanceId: await ecsTaskId(process.env) };
setupOtel(otel);
await startProfiling(otel);

const app = await createApp();
const port = Number(process.env.PORT || 8080);
await app.listen(port, process.env.HOST || '0.0.0.0');
// startup: true keeps the line on stdout whatever LOG_STDOUT_LEVEL is (GWP#58); the bindings carry the version.
apiLogger.info({ port, startup: true }, 'listening');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    apiLogger.info({ signal }, 'shutting down');
    void app.close()
      .finally(() => shutdownOtel())
      .finally(() => process.exit(0));
  });
}
