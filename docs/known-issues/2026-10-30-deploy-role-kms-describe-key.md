# The deploy role could not describe KMS keys, so RDS refused to create the database

Resolved in GWP#75. The bootstrap is GWP#43's; its grants were never exercised against AWS before the owner first applied it on 2026-10-30. Nothing was created and nothing was exposed.

The first `data-dev` run after that apply (run 41063230799, `main` at ca05730) failed creating `getworkdone-dev`: `CreateDBInstance` answered `KMSKeyNotAccessibleFault: The specified KMS key [null] either doesn't exist, isn't enabled, or isn't accessible by the current user`. The data stage's database sets `storage_encrypted = true` and `manage_master_user_password = true` with no `kms_key_id` (`deploy/sandbox/data/rds.tf`), so RDS uses the AWS-managed keys `aws/rds` and `aws/secretsmanager`, which it resolves as the caller. The `aws/rds` key policy gives `kms:DescribeKey` to every principal only through RDS, and directly only to the account root; a root grant takes effect only when the caller's IAM policy allows the action too. The deploy role's `Read` statement had `rds:Describe*` and `ec2:Describe*` but no KMS action, and `aws iam simulate-principal-policy` answered `implicitDeny` for `kms:DescribeKey`. request-4-change-private's deploy role, which creates its database the same way, has had `kms:DescribeKey` and `kms:ListAliases` in its `Read` statement since its bootstrap was written; this bootstrap left them out.

Why no test caught it: the bootstrap tftest runs against a mock provider and pins what the role must not do (one assertion even forbade every `kms:` action). Nothing checks a grant the stages need against AWS, and `whoami.yml` calls no API after assuming the role.

Fix: the `Read` statement allows `kms:DescribeKey` and `kms:ListAliases` on `*`. Both return key metadata only; neither can use, change or schedule a key, and the role still holds no other KMS allow. The rollout is the owner's: apply the bootstrap from the PR branch before merging (the plan changes only `aws_iam_role_policy.deploy` in place), then the merge's `data-dev` creates the instance.

Regression tests (the `tofu-test` gate, `bash scripts/tofu-test.sh`):

- `deploy/sandbox/bootstrap/tests/bootstrap.tftest.hcl`, run "regression_rds_default_key_describe": some `Allow` grants `kms:DescribeKey` on `*`, and the role's only KMS allows are `kms:DescribeKey` and `kms:ListAliases`.
- The same file, run "regression_no_other_secret_value": its "no `kms:` allow" assertion now exempts exactly those two metadata reads, and still fails on any other KMS allow or a bare `*`.
