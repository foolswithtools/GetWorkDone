import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESCALATION_CHAIN_NAME, ONCALL_TEAM_NAME, oncallDefinitions } from '../oncall/definitions.js';

const observability = fileURLToPath(new URL('../', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' || name === 'node_modules' ? [] : sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('OnCall definitions (D-042)', () => {
  it("the escalation chain's only target is the prebutton-maintainers OnCall team", () => {
    const { team, escalationChain } = oncallDefinitions();
    // The team mirrors the GitHub CODEOWNER team @foolswithtools/prebutton-maintainers.
    expect(ONCALL_TEAM_NAME).toBe('prebutton-maintainers');
    expect(team.name).toBe(ONCALL_TEAM_NAME);
    expect(escalationChain.name).toBe(ESCALATION_CHAIN_NAME);
    expect(escalationChain.steps).toEqual([{ type: 'notify_team_members', team: ONCALL_TEAM_NAME, important: true }]);
  });

  it('routes by severity: critical pages through the chain, anything else lands in OnCall without paging', () => {
    const { integration, routes } = oncallDefinitions();
    expect(integration.type).toBe('grafana_alerting');
    expect(routes).toEqual([
      { routing_type: 'jinja2', routing_regex: '{{ payload.commonLabels.severity == "critical" }}', escalationChain: ESCALATION_CHAIN_NAME },
    ]);
    expect(integration.defaultEscalationChain).toBeNull();
  });

  it('no definition names an individual user handle', () => {
    const text = JSON.stringify(oncallDefinitions());
    expect(text).not.toMatch(/person|user|login|@/i);
    for (const file of sources(observability)) {
      const source = readFileSync(file, 'utf8');
      // No individual notify targets and no handles; the owner's login arrives at apply time.
      expect(source, file).not.toMatch(/persons_to_notify|notify_persons|users_to_notify|['"]@[\w-]+['"]/);
    }
  });
});
