# Stuck state lock

**Who:** the owner, by hand. An agent never does any step that writes here: it never deletes a lock, never deploys and never re-runs a deploy (D-020, P3). An agent that meets this error reports it and stops.

## Trigger

A `deploy` or `destroy` run's data job fails when OpenTofu takes the lock (plan, apply or destroy) with:

```
Error: Error acquiring the state lock
```

followed by a **Lock Info** block (`ID`, `Path`, `Operation`, `Who`, `Version`, `Created`).

Every infrapipe config here sets `use_lockfile` (D-054 rule 1), so an apply of an instance's data stage holds a `.tflock` object beside that instance's state while it runs. The state key, from the maintainers' private deploy notes, is `env:/GetWorkDone-private-main/getworkdone/data-<instance>.tfstate`, so the lock is `env:/GetWorkDone-private-main/getworkdone/data-<instance>.tfstate.tflock`, in the state bucket the `SANDBOX_AWS_TFSTATE_S3_BUCKET` variable names. A job that was cancelled or timed out while it held the lock leaves the object behind, and every later run of that instance then fails with this error. infrapipe has no force-unlock.

The lock is the safety net, not the queue: the concurrency groups in `deploy.yml` and `destroy.yml` keep two runs of one instance from overlapping (D-006, D-054). A run that waits in its group shows as queued, not as this error.

## First checks

1. **Which instance.** The failed job is `deploy`'s `data-dev` or `data-prod`, or `destroy`'s `data-dev-destroy`; the Lock Info `Path` names the same instance's state.
2. **No run holds the lock.** In the repository's Actions tab, check that no run of `deploy` or `destroy` is in progress or queued for that instance (`gh run list --workflow deploy.yml` and `gh run list --workflow destroy.yml` show each run's status). If one is running, wait for it: it holds the lock and releases it when it ends.
3. **Where the lock came from.** Find the earlier run whose data job had started (it has steps and a log) and then ended `cancelled` or timed out, around the Lock Info `Created` time. A job that shows `cancelled` because a newer run replaced it while it was still queued never started and never held the lock. A lock with no such run is unexplained: stop and find out who else ran OpenTofu against that state (the Lock Info `Who`) before deleting anything.

## What to do

With the owner's own AWS profile (the deploy role is not used by hand), delete only the lock object, never the state:

```
aws s3api head-object --bucket <state bucket> --key 'env:/GetWorkDone-private-main/getworkdone/data-<instance>.tfstate.tflock'
aws s3 rm 's3://<state bucket>/env:/GetWorkDone-private-main/getworkdone/data-<instance>.tfstate.tflock'
```

`<state bucket>` is the value of the `SANDBOX_AWS_TFSTATE_S3_BUCKET` variable; it is not written in this repo (D-035). If `head-object` finds nothing, the lock is already gone: do not delete anything else. The key must end in `.tflock`; the `.tfstate` object without it is the state itself.

## How to confirm

- `aws s3api head-object` on the same key now answers 404 (Not Found).
- The owner re-runs the failed job, or dispatches the workflow again, and it gets past init and plan. The interrupted apply may have left changes half made: read that run's plan before it applies.
