# Native permission review and human approval are distinct

## Confirmed defect

`waitingOnApproval` is a native runtime flag. It can accompany automatic
approval review without any outstanding human approval request. Both the
compact progress renderer and a restored legacy card previously told the
recipient that their action was required. The flag alone cannot establish
that a human request exists, has been delivered, or can be answered.

The generic status now waits for an approval result without claiming the
recipient must act. Real native command, file, permission and MCP requests
still use the existing request-specific controller and exact scoped choices.
The change does not grant permissions, change sandbox settings, switch the
reviewer, resubmit input, or restart an executor.

## Automatic review notifications

The installed native client handles `item/autoApprovalReview/started` and
`item/autoApprovalReview/completed` with a `reviewId`, `threadId`, `turnId`
and `review.status`. Gateway now reports their closed status values for its
current observed turn: in progress, approved, denied, timed out or aborted.
Approval is not reported as successful execution. Denial is not presented as
a pending human approval or as proof that the entire task has stopped.

Foreign or completed turns and metadata/history observers cannot deliver
these notices. Generic notices omit action arguments and reviewer payloads.
They never create approval IDs, offer approval commands, or send decisions.

## Verification boundary

- Restored compact and legacy cards retain the original card, native activity,
  and one exact stop command; waiting-input and running transitions are intact.
- Protocol fixture verifies automatic review progress, no synthetic human
  approval or receipt, no payload leakage, and rejection of foreign/late events.
- Existing native approval, Desktop follower, IM choice, durable receipt and
  restart tests remain required. These protocol tests do not prove DingTalk
  mobile rendering or establish who changed a native client's permissions.

A recorded turn's effective policy is evidence of what was applied to that
turn, not an audit of who selected it or when a queued request captured it.
Attribution must use the originating request and client logs, not infer an
actor from a policy change or a nearby Gateway restart.
