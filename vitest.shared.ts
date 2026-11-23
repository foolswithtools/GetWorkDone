import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import type { ViteUserConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Shared by every vitest partition. Workspace packages resolve to their sources, so tests need no
// build first. SWC compiles the NestJS code: esbuild cannot emit decorator metadata, which Nest's
// constructor injection reads.
export const shared: ViteUserConfig = {
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
  test: {
    // The API's logger stays quiet in tests; tests that check log output build their own logger.
    // Sign-in uses the fake identity provider, which the API accepts only under NODE_ENV=test (vitest's
    // default); oidc.provider.test.ts and the e2e sign-in run the real one against a mock issuer.
    env: { LOG_LEVEL: 'silent', IDENTITY_PROVIDER: 'fake' },
  },
  resolve: {
    alias: {
      '@getworkdone/telemetry': here('./packages/telemetry/src/index.ts'),
      '@getworkdone/contracts': here('./packages/contracts/src/index.ts'),
      '@getworkdone/db': here('./packages/db/src/index.ts'),
    },
  },
};
