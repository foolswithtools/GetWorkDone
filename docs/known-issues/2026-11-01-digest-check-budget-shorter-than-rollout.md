# The running-digests check gave up before a normal task rollout finished

Resolved in GWP#109. The check is #8's (`deploy/sandbox/check-digests.sh`), run by `deploy.yml`'s `app-dev` and `promote` jobs after the app stage. Nothing was exposed and nothing was rolled back: the new task definition was running, and the check failed the job early.

Deploy run 41257316668 (`main` at 0f7bbc9, #107's merge, 2026-11-01) failed `app-dev` at "Check the running digests": `waiting (1/12) … has 2 deployments, not one`, and after 12 polls 10 s apart, `deployment is not a completed primary with its task running`. ECS reported "deployment completed" and steady state 17 s later, on task definition `:17`, with edge serving `v0.2.0`. The live smoke, verify-live and coverage steps never ran.

Cause: the check waited about 2 minutes. Every push changes the task definition, so every `app-dev` and `promote` run rolls the task. The old task stops only after the target groups' `deregistration_delay` (30 s, `ecs-paas-v0.3.0`) and up to the `app` container's `stopTimeout` (60 s), and ECS then takes a while longer to mark the rollout `COMPLETED`. The stopped tasks show `:16` stopping in 105 s, then 41 s more to `COMPLETED` (2 min 16 s; failed), and `:15` stopping in 85 s on the deploy before (passed). Every container exited 0. The budget sat at the edge of a normal rollout, so the step failed about half the time.

Why no test caught it: every case in `tests/scripts/check-digests-sh.test.ts` set the attempts, so nothing pinned the default against a real rollout's length.

Fix: the default is 36 attempts, 10 s apart, 6 minutes, more than twice the longest rollout seen. A rolled-back deployment still fails at once: it completes on the old task definition, whose digests the check refuses on the first poll.

Regression tests, in `tests/scripts/check-digests-sh.test.ts` (partition: unit):

- "waits through a rollout that outlasts the old two-minute budget, with the default attempts": the rollout completes on the 20th poll; it failed with the old default of 12.
- "the default budget is at least 300 seconds": the default attempts times the default wait.
