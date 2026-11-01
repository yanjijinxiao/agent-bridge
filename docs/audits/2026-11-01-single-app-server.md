# Single native App Server review

This replaces the fixed Desktop/headless business split in the preceding release. The requested boundary is one complete native protocol implementation. Hosts differ by service transport and deployment, not by enabled operations or fallback executor.

## Reviewed scope

- Architecture and factories: `backend.ts`, `runner.ts`, `app-server-gateway.ts`, AccountManager and BridgeService construction. Production constructs one adapter; the old router now only reexports it. No production factory constructs Desktop follower or exec runners. Legacy standalone classes/tests remain compatibility material, not selectable services.
- Protocol and module behavior: App Server runner connection/lease lifecycle, native requests, approvals, permission inheritance, dynamic tools, questions, catalogs/history and queues; native subscription supervision; typed interaction envelopes; shared-core metadata/history readers; local/remote transport and executable resolution.
- File-level edge cases: pre-ack events, typed request ID reuse after reconnect, peer-resolved requests, revoked destinations, sibling/changed/removed questions, lost answer acknowledgement, mismatched steering receipts, source guard after serialization, unknown queue observations, exact turn identity, and permission/reviewer inheritance.
- Static files and configuration: old execution-owner field removed from load/save/API/UI; only one backend appears in settings; current README/backend architecture and historical audit status updated. Exact project aliases/pins decorate native rows without overriding explicit native membership. Existing grant stores and account/session edges are not rewritten by this change.

## Native evidence

`shared-app-server-integration.test.ts` launches a real Codex service in a fresh home against a local fake Responses endpoint. No real account or external model is used. Two peer clients report the same `server/diagnostics.process.id`; relay PIDs differ. Tests cover new and unopened-thread continuation, goals, lifecycle, native catalog/queue, a pending approval replayed to a restarted client with the exact native ID, dynamic tools, structured ephemeral output, and inherited native permissions/reviewer. A Gateway disconnect after acceptance leaves the same core and turn active; after reconnect the original source ID occurs once.

`native-async-questions.test.ts` verifies sibling identity, peer answers, native confirmation, lost acknowledgement, source revocation, changed/removed questions and disconnect/turn-end invalidation. `app-server-request-monitor.test.ts` verifies exact host/thread subscriptions, retry deadline, fanout bound, removal and late shutdown completion. Existing serialization, history isolation, queue receipts, IM controls and narrow restart-gate tests remain covered with unified native semantics.

A full diagnostic run after replacing obsolete routing expectations passed 2188 of 2189 tests, with only the Windows-specific test skipped. Later additions/changes receive the release's final full-suite run; release manifest/logs are the authoritative final count. Passing this suite is evidence for these contracts, not a claim that all hidden application defects have been eliminated.

## Deployment boundary

The installed Desktop currently uses a private stdio core. The selected managed native service is independent. Code changes alone cannot merge their writer ownership. Desktop must reconnect to the shared service at a safe idle boundary; only then can one claim both clients use the same live core. Gateway restart alone neither migrates nor cancels the Desktop task. No force-unlock, raw database modification, task replay or implicit permission change is an acceptable migration.

The installed Desktop build exposes its local-daemon client path under `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, subject to native version/config checks. The native daemon version command confirms the managed service exists. Actual Desktop reattachment and same-core identity must be verified during deployment; until then this is a staged code change, not a completed live migration.
