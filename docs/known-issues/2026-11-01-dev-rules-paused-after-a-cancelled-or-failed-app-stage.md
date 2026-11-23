# A cancelled deploy, or a failed app stage, after a destroy left dev's alert rules paused with no warning

Resolved in GWP#114, found by the fresh-context whole-branch review of GWP#112 before it shipped. No run hit it.

GWP#112 makes `deploy.yml`'s `app-dev` run `apply.ts --environment getworkdone-dev` ("Unpause the getworkdone-dev alert rules") on `failure()` after "Apply the app stage" succeeded and "Apply observability" did not run, and warn `alert rules may still be paused` when no apply succeeded. Two paths still left `dev` running with every rule paused (after a `destroy.yml` pause, GWP#85) and said nothing:

- A job cancelled after the app stage, by hand or by its 75-minute `timeout-minutes` (a timeout cancels the job). `failure()` is false on a cancel, so neither the unpause nor the warning ran.
- "Apply the app stage" failing after the ECS service was already up. Both the unpause and the warning required that step's `outcome == 'success'`.

Fix: the warning step ("Warn when the rules may still be paused") runs on `failure() || cancelled()`, so a cancelled run after a successful app stage with no successful apply writes `alert rules may still be paused` to its log and job summary. The unpause stays on `failure()`: a cancelled run is not extended with a Grafana apply. A new step, "Warn when the app stage did not finish", runs when "Apply the app stage" failed or was cancelled and writes that `dev` may be running with its alert rules paused to the log and job summary. It runs no unpause, since the instance's state is unknown (the issue's first option). A green run applies observability once, after the probe, as before.

Regression tests, in `tests/workflows/deploy-guards.test.ts` (partition: unit):

- "warns when app-dev is cancelled after the app stage, or the app stage itself fails (GWP#114)": the warning's `if` covers `cancelled()` after a successful app stage, the unpause does not, a step after the fallback warns (log and summary, no apply) when the app stage's outcome is `failure` or `cancelled`, and `deploy.yml` references no `secrets.`.
- "unpauses the getworkdone-dev rules once the app stage applied, even when a later step fails (GWP#112)": its exact warning condition now starts `(failure() || cancelled())`.
