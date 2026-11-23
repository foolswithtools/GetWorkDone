# A deploy that brought dev back and then failed left its alert rules paused

Resolved in GWP#112, found by the fresh-context whole-branch review of GWP#85 before it shipped. No run hit it.

GWP#85 makes `destroy.yml` pause all 11 `getworkdone-dev` alert rules after it destroys `dev` (`observability/apply.ts --pause`), and relies on the next `deploy.yml` `app-dev` run's "Apply observability" step to unpause them (`alertRuleBody` sends `isPaused: false`). That step runs late: after the migrate, "Apply the app stage", the second migrate, the digest check and the HTTPS probe. If any of those failed after the app stage had brought `dev` back, the job stopped before "Apply observability", and `dev` ran with every rule paused, the telemetry heartbeat and the fast burns included. Nothing said so, and a broken `dev` paged nobody until a later run got through.

Fix: `app-dev` sets up Node and installs the workspace before the app stage. On a failure after "Apply the app stage" succeeded, when "Apply observability" never ran, it reads the stack token through `.github/actions/read-deploy-secret` and runs `apply.ts --environment getworkdone-dev` ("Unpause the getworkdone-dev alert rules"). When no apply succeeded after the app stage, it warns that the rules may still be paused. A run that fails before the app stage leaves them as they are, and a green run applies observability once, after the probe, as before. A fallback was chosen over moving "Apply observability" up so the success path stays as it was: observability is applied only once the digest check and the probe have passed.

Regression test, in `tests/workflows/deploy-guards.test.ts` (partition: unit):

- "unpauses the getworkdone-dev rules once the app stage applied, even when a later step fails (GWP#112)": the fallback apply comes after the probe, runs on `failure()` only when the app stage succeeded and the primary apply was skipped, reads the token through `read-deploy-secret` under the same condition, Node and the install come before the app stage, and `deploy.yml` references no `secrets.`.
