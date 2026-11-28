# #251: Retain the ACP checkpoint when sidecar publication fails

## TL;DR

If the final capabilities rename fails, restore the previous ID and
sidecar and return a clear launch error.

## Test plan

- Inject an error at the final rename and verify that the previous
  checkpoint is still resumable and the launch reports the failure.

## Log

- 2026-11-26: Defined the regression against the rollback-compatible
  checkpoint pair described in the ACP Slice 3 spec.
- 2026-11-26: Retained both previous files until publication completes and
  verified that final rename failure restores Resume and releases the lock.
  All five selected checkpoint tests passed.
