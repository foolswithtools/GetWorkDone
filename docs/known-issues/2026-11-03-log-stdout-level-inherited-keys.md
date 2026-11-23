# LOG_STDOUT_LEVEL accepted inherited keys, and fatal or silent kept error lines off stdout

Resolved in GWP#134. Found in the whole-branch review of PR #132 (GWP#58), which added `LOG_STDOUT_LEVEL`.

`stdoutLevelFromEnv` in `packages/telemetry/src/logger.ts` checked the value with `chosen in LEVEL_VALUES`, and `in` also matches keys inherited from `Object.prototype`. `LOG_STDOUT_LEVEL=constructor` (or `toString`) was accepted, `teeDestination` then took `LEVEL_VALUES.constructor`, a function, as its threshold, every `value >= threshold` comparison was false, and no line reached stdout, error lines included (reproduced in the review). Separately, `fatal` was a valid level, so `LOG_STDOUT_LEVEL=fatal` dropped error lines from stdout on purpose; `silent`, not among pino's level values, fell back to the default. Nothing set the variable in a deployed task, so no line was lost.

Fix: levels are looked up by own key only (`Object.hasOwn`), in `stdoutLevelFromEnv` and in `teeDestination`, so an inherited key falls back to the default; and `fatal` or `silent` gives `error`, so error and fatal lines always reach stdout, which CloudWatch keeps. The app stage's input `log_stdout_level` refuses anything but `trace`, `debug`, `info`, `warn` and `error`.

Regression tests: `packages/telemetry/src/logger.test.ts` "LOG_STDOUT_LEVEL=constructor (an inherited key) falls back to the default, and error lines stay on stdout", "LOG_STDOUT_LEVEL fatal and silent cap at error, so error and fatal lines always reach stdout" and "teeDestination treats an inherited key as no stdoutLevel, writing every line"; `deploy/sandbox/app/tests/app.tftest.hcl` runs `refuses_a_log_stdout_level_above_error` and `refuses_an_unknown_log_stdout_level`.
