import type { ReactNode } from 'react';
import { browserNavigator, linkProps, type KnownRoute } from './routing.js';

/**
 * A view the address names but nobody can show (GWP#98): an unknown path, a team the person is not in or
 * an unknown work type. Never a blank page: a message and a link back.
 */
export function NotFound({ testId = 'not-found', to = { kind: 'teams' }, linkText = 'Go to your teams', children }: { testId?: string; to?: KnownRoute; linkText?: string; children?: ReactNode }) {
  return (
    <section role="alert" data-testid={testId}>
      <h2>Not found</h2>
      {children && <p>{children}</p>}
      <p><a {...linkProps(browserNavigator(), to)}>{linkText}</a></p>
    </section>
  );
}
