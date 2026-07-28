# Workbench Runtime Provider-State Rollout And Alerts

## Scope And Ownership

This runbook is the operational source of truth for the Provider State projection version 2 rollout, Runtime liveness telemetry, and Knowledge tool visibility controls. It defines the required phase order, evidence boundary, rollback posture, alert ownership, and release-gate behavior; no separate remediation specification is required to execute it.

| Area | Primary owner | Required independent reviewer |
|---|---|---|
| Projection schema, backfill, repair | Data | Operations |
| Worker canary, liveness, alerts | Operations | Release |
| Knowledge visibility | Security | Operations |
| Candidate and image binding | Release | Security |

No operator may manufacture an observation or receipt. A rollout receipt records already collected, sanitized evidence; it is not approval and does not make a staging or production gate pass by itself.

## Rollout Sequence

The only supported order is:

1. Expand the schema without deleting legacy data.
2. Run the bounded backfill and verify 100% coverage.
3. Run `shadow-verify` long enough to satisfy the independently approved observation reference, with zero mismatch and zero invariant errors.
4. Deploy the same candidate and immutable Worker image to a canary in `shadow-verify` mode.
5. Switch the canary to `projection-required` and observe it.
6. Roll the same immutable image and configuration to all Workers, with zero legacy Worker count and zero legacy-read traffic.

Record each completed phase with `scripts/workbench-runtime-provider-state-rollout.mjs`. Run without `--execute` first. For staging and production, `--receipts-dir` must be an access-controlled location outside the repository. The command rejects a missing predecessor, a changed candidate/environment, non-zero mismatch/lag/P2028 counts, mutable image references, incomplete readiness, receipt tampering, and residual legacy traffic.

```sh
node scripts/workbench-runtime-provider-state-rollout.mjs \
  --phase shadow \
  --candidate-sha "$WORKBENCH_SOURCE_COMMIT" \
  --environment-id "$WORKBENCH_ENVIRONMENT_ID" \
  --environment-kind staging \
  --observation /restricted/evidence/runtime-shadow.json \
  --receipts-dir /restricted/receipts/runtime-provider-state
```

After review, repeat with `--execute`. Never put a database URL, token, prompt, provider text, payload, external ID, Run ID, attempt ID, or principal ID in the observation, evidence descriptor, metric label, or receipt.

## Rollback And Forward Repair

Do not roll back schema or delete projections/events. Stop Runtime queue producers and consumers, retain the append-only inbox, and keep the last schema-compatible candidate available. Before cutover, return Workers to `shadow-verify` or `legacy-read` only under the approved change. After cutover, prefer forward repair: fence affected attempts, repair or rebuild the projection with the migrator role, re-run coverage and shadow verification, then issue a new receipt chain. A previous Worker may be used only when it understands projection version 2 and the expanded schema.

## Provider-State P2028

Owner: Operations, with Data escalation. Stop canary/full rollout immediately. Capture only candidate, image digest, environment, stable error code, operation, counts, and UTC. Check projection lag and invariant alerts, database saturation, and the backfill receipt chain. Do not increase the transaction timeout as the remedy. Fence affected attempts and use forward repair; resume only after PostgreSQL coverage and shadow verification are clean.

## Projection Invariant

Owner: Data. Any missing/version/hash/gap/draft/CAS error is fail-closed. Stop the affected Worker cohort, preserve the inbox and projection rows, hash the controlled evidence file, and identify the last valid sequence. Never fall back silently to historical replay in `projection-required`. Repair with the migrator role and restart the receipt chain at backfill.

## Projection Lag

Owner: Operations. Confirm the alert is not delayed telemetry by checking the current projection and attempt sequence through the approved read-only query. Sustained lag blocks cutover. Stop the cohort if lag grows, inspect lease ownership and database health, and escalate to Data for projection repair.

## Backfill Conflict

Owner: Data. The operator must stop on pending events, a sequence gap, payload hash mismatch, draft conflict, invalid finalization, or unknown projection version. Do not skip the attempt. Drain Runtime participants, repair the append-only history or projection through an approved forward migration, resume from the last sanitized checkpoint, and re-run verify-only coverage.

## Wall Clock

Owner: Operations. The warning threshold is tied to the approved `1800000 ms` deployment value and must change with that configuration. On submission, stream-idle, or wall-clock timeout, verify that I/O was aborted, provider cancellation/reconciliation was bounded, leases were released/fenced, the queue job terminalized, and the Run converged. Keep the independent 900-second finding open until same-candidate staging kill/restart and long-duration evidence passes.

The OTLP duration instrument uses unit `ms`. With the standard suffix-enabled Prometheus translation, its histogram series is `workbench_runtime_liveness_duration_milliseconds_bucket`. A collector configured to suppress unit suffixes must update this alert rule and its contract test in the same candidate.

## Terminal Run Drift

Owner: Operations. Stop new Runtime submissions if a terminal job leaves a Run active. Record the stable state tuple without IDs, inspect the execution reconciler and lease, and converge the Run atomically before resuming. Escalate repeated drift to Release because it blocks G8/G10.

## Lease Takeover

Owner: Operations. A small number of successful takeovers is recovery; a burst suggests Worker death, heartbeat delay, or database contention. Compare heartbeat and lease durations, check SIGTERM/SIGKILL events, and ensure the expired owner cannot write. Do not lengthen the lease without capacity evidence.

## Knowledge Visibility

Owner: Security. An unauthorized execution attempt means the request-scoped catalog or middleware boundary failed. Disable the affected Runtime cohort, preserve only stable error-code/count evidence, and verify null-release requests expose no Knowledge tool to the main agent or subagents. Do not treat a missing capability token error as an adequate visibility control.

## Evidence And Gate Boundary

The repository can prove schemas, deterministic tests, alert syntax, receipt chaining, redaction, and isolated PostgreSQL behavior. Linux CI, staging observation, production deployment, restore/kill drills, alert delivery, G0 approvals, formal G10, and G12 remain `NOT RUN` or `BLOCKED` until independent evidence exists. Never convert a local or mocked result into those approvals.
