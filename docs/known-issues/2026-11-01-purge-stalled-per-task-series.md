# Session purge stalled would warn twice after every deploy with per-task series

Resolved in GWP#116, found while building GWP#86 before either shipped. No run hit it; the two warnings are inferred from the series identity and Prometheus `increase()` semantics, not seen live.

GWP#86 gives each API task its own `service.instance.id`, which Grafana Cloud maps to the `instance` label, so each task writes its own `session_purge_runs_total` series. `<env> session purge stalled` was `increase(session_purge_runs_total{deployment_environment="<env>",status="ok"}[50m]) == bool 0`, which evaluates each series alone. In a rolling deploy the new task's series is born at 1 by its startup purge and reads flat until its second run 15 minutes later, so its `increase()` is 0 and the rule warns; and from about 35 to 50 minutes after the old task stops, the old series' remaining samples in the window are flat, so it warns again.

Fix: the rule is `sum(increase(session_purge_runs_total{deployment_environment="<env>",status="ok"}[50m])) == bool 0` (`observability/signals/definitions.ts`), so it warns only when no task of the environment finished a run in 50 minutes. A missing series stays the heartbeat's: the empty sum is NoData, kept `Normal` by `noDataState: OK`. A new environment's first deploy can still warn once for about 15 minutes (one series, born at 1), as before.

Regression tests (partition: unit):

- `tests/scripts/signal-rules.test.ts`, "session purge stalled sums across tasks: quiet at every minute of a rolling deploy, fires when every task is flat for 50 minutes (#116)": evaluates the rule every minute of the hour after a deploy over an old task's stopped series and a new task's series born at 1, and over two flat series.
- `observability/test/definitions.test.ts`, "purge stalled and database unreachable compare with == bool 0, never a bare == 0": the exact summed expression.
