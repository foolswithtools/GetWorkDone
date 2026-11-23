# Runbooks

What to do when an alert fires or an operation needs a person. For whoever is on call for an instance and for the owner; the people running a team use the [guides](../guide/first-team.md) instead.

Agents read runbooks but do not carry out the steps that change an instance: they never deploy or re-run a deploy (D-020), and AWS changes are a person's ([CLAUDE.md](../../CLAUDE.md)). Each runbook says who does each step.

## Convention

One file per alert or operation, named after it in lower kebab case (`state-lock.md`). Each has these parts, in this order:

1. **Name**: the heading, the alert's or operation's name.
2. **Trigger**: the alert, error text or request that sends someone here, quoted exactly so a search finds it.
3. **First checks**: what to look at before changing anything, and how to tell this case from a similar one.
4. **What to do**: the steps, each with who does it.
5. **How to confirm**: what shows it worked.

A runbook links the docs that hold the rules (for example `docs/observability.md`) instead of copying them, says in prose when a step is in the maintainers' private deploy notes (a published doc links no unpublished path, `docs/publishing.md`), cites decisions by number, and names no account id, hostname or token (D-035). An alert's runbook link points at its file in the private repository's `main`, which on-call maintainers can open.

## Runbooks

| Runbook | For | Status |
|---|---|---|
| [state-lock.md](state-lock.md) | A deploy or destroy fails with "Error acquiring the state lock": a stuck `.tflock` | written |
| [alert-drill.md](alert-drill.md) | The alert fault-injection drill (GWP#9) | written |
| [api-availability-burn.md](api-availability-burn.md), [api-latency-burn.md](api-latency-burn.md), [capture-availability-burn.md](capture-availability-burn.md) | The SLO burn-rate alerts, one per SLO; each rule's `runbook_url` points here (GWP#9) | written |
| [telemetry-heartbeat.md](telemetry-heartbeat.md) | `<env> telemetry heartbeat` (pages) and `<env> session purge stalled` (GWP#53) | written |
| [delivery-failed.md](delivery-failed.md) | `<env> delivery failed` and `<env> delivery backlog` (GWP#53) | written |
| [database-unreachable.md](database-unreachable.md) | `<env> database unreachable` (pages) and a 503 from `/readyz` (GWP#53) | written |
| `deploy-failed.md` | A failed app deploy or promote (GWP#8) | planned |

The issue that writes a planned runbook links it here and moves its row to written.
