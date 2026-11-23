# The deploy role could rotate and describe every app's RDS master secret

Resolved in GWP#169. The bootstrap is GWP#43's. Its branch review caught this on 2026-10-25, but the fix (commit 0cce0df) was pushed to `agent/43-infra-deploy-add-the-sandbox-bootstrap-d` seven minutes after PR #44 merged, so it never reached `main`. It was found again on 2026-11-06 while merged branches were being cleaned up. Nothing was rotated and nothing was exposed.

The deploy role's `RdsManagedMasterSecret` statement allowed `secretsmanager:CreateSecret`, `TagResource`, `RotateSecret` and `DescribeSecret` on `rds!*` with no condition. That pattern matches every RDS-managed master secret in the sandbox account, not only those of `getworkdone-*` instances. A deploy run, or anything holding its session, could therefore force a rotation of another app's master password or read that secret's metadata. No `Deny` limited it: `NoOidcSessions` belongs to the permissions boundary, and the deploy role has no boundary (D-073).

Neither grant was needed. The RDS user guide ("Permissions required for Secrets Manager integration") says a create, modify or restore with a managed master password needs only `kms:DescribeKey`, `secretsmanager:CreateSecret` and `secretsmanager:TagResource`, and that `RotateSecret` is needed only for a modify that rotates the password. No stage, workflow or script rotates. RDS rotates on its own seven-day schedule, and the manual check after a rotation (`docs/deploy/sandbox.md`) is the owner's, never run from a session or as the deploy role. The app stage reads the master secret's ARN from `aws_db_instance.master_user_secret`, which is an RDS call, not Secrets Manager.

Why no test caught it: the bootstrap tftest pinned the `GetSecretValue` scope on `rds!*` (`ReadRdsMasterSecret` is already conditioned on the instance tag) but asserted nothing about the other `rds!*` grants.

Fix: the statement is split. `RdsManagedMasterSecretCreate` keeps `CreateSecret` and `TagResource` on `rds!*` without a condition, because the secret does not exist yet and carries no tag. `RdsManagedMasterSecretDescribe` allows `DescribeSecret` only with `secretsmanager:ResourceTag/aws:rds:primaryDBInstanceArn` like `…:db:getworkdone-*`, the same condition as `ReadRdsMasterSecret`. `RotateSecret` is dropped. The rollout is the owner's: apply the bootstrap from the PR branch before merging. The plan should change only `aws_iam_role_policy.deploy`, in place.

Regression test (the `tofu-test` gate, `bash scripts/tofu-test.sh`):

- `deploy/sandbox/bootstrap/tests/bootstrap.tftest.hcl`, run "regression_rds_secret_grants_are_app_scoped": every `Allow` on `rds!*` with an action beyond `CreateSecret` and `TagResource` carries the `getworkdone-*` instance condition, and no `Allow` grants `secretsmanager:RotateSecret`, `secretsmanager:*` or `*`.
