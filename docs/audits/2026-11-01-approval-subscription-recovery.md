# Pending native request subscription recovery

## Reproduced failures

1. IPC initialization succeeds, but the first follow broadcast has no owner or
   no snapshot response. The existing monitor retries interactions it already
   knows about, but never retries the missing initial snapshot. A later owner
   and its pending approvals therefore remain invisible until reconnect.
2. A state patch received without a base snapshot is applied to an invented
   empty requests list. This can present and answer an approval before the
   observer has received the authoritative source state.

Both regressions failed in isolated IPC fixtures before the implementation
change. They establish defects, not attribution for every historical missed
request; historical client logs do not retain all dropped frame payloads.

## Boundary and recovery

- Missing initial snapshots have host/thread-scoped read-only follow probes,
  exponential backoff capped at 30 seconds, and at most four probes per tick.
- A valid snapshot, including an empty one, stops these probes. Unfollow,
  shutdown and disconnect clear them; initialization rebuilds live targets.
- Patches require an existing base. A missing base requests a full snapshot
  with a rate limit and cannot establish a new actionable approval.
- Recovery never resumes a thread, starts inference, changes permissions,
  fabricates a human request, or repeats a permission decision.

`interaction-health.desktopRequestMonitor` distinguishes socket readiness
from receipt of the initial snapshot for each Desktop target. This is a
Desktop-specific diagnostic, not a claim about the separate App Server
execution owner's approval callbacks or continuous upstream liveness.

## Validation

The permission-request regression exercises native IPC, the production IM
approval controller, exact displayed commands, explicit session scope,
the native decision RPC, and its acknowledgement. It also verifies no
grant on mere observation and no duplicate notice/decision on snapshot replay.
Other cases cover empty, invalid and unrelated snapshots, local/remote twins,
unfollow, shutdown, reconnect, and patches arriving before initialization.

Existing approval, question, route and receipt regressions remain required.
No synthetic approval is sent to a production chat for testing. These fixtures
do not establish that native execution-owner handoff is fixed; that is a
separate cross-client lifecycle constraint.
