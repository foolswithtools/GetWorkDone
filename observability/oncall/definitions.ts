// OnCall as code (GWP#7, D-042). OnCall pages the owner as the only member of a team mirroring the
// GitHub CODEOWNER team @foolswithtools/prebutton-maintainers. No definition names a person: the owner's
// Grafana login arrives at apply time (GRAFANA_ONCALL_OWNER) and further members are added by hand.
//
// OnCall teams are Grafana teams that IRM syncs; apply.ts creates the Grafana team and reads the
// synced OnCall team. The integration receives Grafana Alerting's notifications. Critical alerts (fast
// burn) route to the escalation chain, which pages the team; anything else lands in OnCall as an alert
// group on the default route and pages nobody.

export const ONCALL_TEAM_NAME = 'prebutton-maintainers';
export const ESCALATION_CHAIN_NAME = 'getworkdone-page';
export const INTEGRATION_NAME = 'getworkdone-alerting';

export interface EscalationStep {
  type: 'notify_team_members';
  team: string;
  important: boolean;
}

/** The escalation chain's single step: notify the team. */
export const ESCALATION_STEP: EscalationStep = { type: 'notify_team_members', team: ONCALL_TEAM_NAME, important: true };

export interface OncallRoute {
  routing_type: 'jinja2';
  routing_regex: string;
  escalationChain: string;
}

export function oncallDefinitions() {
  return {
    team: { name: ONCALL_TEAM_NAME },
    escalationChain: {
      name: ESCALATION_CHAIN_NAME,
      steps: [ESCALATION_STEP],
    },
    integration: { name: INTEGRATION_NAME, type: 'grafana_alerting' as const, defaultEscalationChain: null },
    routes: [
      { routing_type: 'jinja2', routing_regex: '{{ payload.commonLabels.severity == "critical" }}', escalationChain: ESCALATION_CHAIN_NAME },
    ] as OncallRoute[],
  };
}
