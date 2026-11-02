# Codex App Server architecture

Gateway has one production implementation: `Channel / Web / AccountManager → CodexBridgeBackend → CodexAppServerGateway → AppServerCodexRunner → native App Server`. Desktop and Gateway are peer clients of the same native core. A CLI-only server runs the same native service and exposes the same operations. There is no Desktop follower execution path, exec fallback, owner discovery selector, or Desktop-specific disabled capability set in this facade.

## Service identity and deployment

`codexBackend` is `app-server`. Loading older `auto`/`exec` values migrates this selector; loading/saving removes the retired `codexExecutionOwner` field. Direct construction with the retired exec adapter is rejected before execution. Legacy runner names reexport the same class for source compatibility; they do not construct another adapter.

Each host has one selected transport and native core. On shared daemon transports, bounded metadata/status and bulk history have independent relay connections to the same endpoint. `server/diagnostics.process.id` identifies the native core; relay PIDs do not. On explicit private stdio, restricted read views share the execution connection instead of spawning reader cores. Stdio remains Gateway-owned and cannot provide independent task survival across Gateway shutdown. There is no fallback on daemon connection failure.

Desktop must itself attach to the selected native service. The installed Desktop build supports `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` when its native compatibility and configuration checks pass. Its previous private stdio core cannot be hot-migrated by restarting Gateway. Reconnect Desktop only after native work is idle, then verify that Desktop and Gateway use the same core. Keep existing thread IDs, source receipts, project aliases, browser grants and native permissions. Never force a writer lock, kill active work, or replay an input to move it. A CLI-only host needs the service and transport, not a Desktop installation.

Old execution classes and private IPC DTO readers remain only as compatibility/test and migration material; production factories instantiate `CodexAppServerGateway` directly. They cannot be selected by runtime configuration. Historical audit documents describe their former behavior, not current deployment guarantees.

Taskboard AI and issue automation use `taskboard/server/native-backend.mjs` and the same `CodexAppServerGateway` contract. Embedded services borrow AccountManager's adapter without owning its core; standalone services load the adjacent root build and use the configured native endpoint. Neither path falls back to CLI `exec`. Observation close, exact turn interruption, durable native receipts and answer flushing are separate operations. The remaining unknown-handoff, concurrent-consumer and real-device boundaries are listed in [Taskboard native execution](architecture/modules/taskboard-native-execution.md) and [remaining work](architecture/remaining-work.md).

## Interface conformance

| Responsibility | Native contract | Verification |
| --- | --- | --- |
| New and existing sessions | thread/start, thread/resume; turn/start | Two real clients create/continue the same thread; unopened continuation works |
| Ordinary input and strict intervention | turn/steer with expectedTurnId and stable source ID | No new turn/queue fallback; stale scope and unknown/cross-thread receipts rejected |
| Stop and lifecycle | turn/interrupt; thread archive/unarchive/delete | Same selected host/core; no private IPC takeover |
| Goals | thread/goal get/set/clear | Real paused goal creation, read and clear |
| Queues | thread/queue add/list/delete/start | Native FIFO and exact client/turn receipts; one accepted input after reconnect |
| Approvals and permissions | Native server request ID, offered decisions, serverRequest/resolved | Pending request replays after client restart with identical typed ID; absent local route never generates a denial |
| Structured questions | tool requestUserInput, MCP typed forms, agent message questions | Native form types preserved; async reply uses guarded steering and exact accepted-answer evidence |
| Dynamic tools and structured helpers | item/tool/call, ephemeral thread and output schema | Real isolated native tool call and structured model output |
| Status, catalogs and history | Bounded thread/read, native lists and paged turns | Separate shared-core reader connections; no owner-discovery or stale-runtime substitution |
| Restart | Durable native acceptance and read-only observation | Same native core and active turn continue after Gateway relay disconnect; input appears once |

Existing native threads inherit their sandbox, reviewer, cwd and approval policy. A Gateway callback is not authorization to change native policy. New-thread defaults and explicit per-input overrides are separate. Read-only helpers explicitly use an ephemeral read-only thread. UI project aliases and pin/manual ordering are a presentation view over explicit native membership; stale Desktop assignments cannot revive removed membership or supply runtime authority.

## Native interactions

The native control connection also owns interaction subscriptions. `AppServerRequestMonitor` supervises bounded native resume subscriptions; it does not instantiate another runner or submit inputs. Native resume replays outstanding server requests, including requests created by another subscribed client. Register the observer before subscribing so replay cannot precede routing setup. A disconnect retains subscription intent, clears connection-specific request tombstones and resubscribes with backoff; it does not resend decisions or user messages.

Missing routes, malformed schemas and stale source leases leave native requests unanswered and surface safe diagnostics. A local routing failure never means the user declined. Typed MCP forms and native permission/scope objects retain their original response semantics. `serverRequest/resolved` proves that a request ended; in a multi-client race it does not prove which client won or that a persistent grant was stored.

Async questions are keyed by host, thread, turn and native question identity, including sibling index. A native item update, peer answer, turn end, binding revocation or disconnect invalidates obsolete UI. A successful steering RPC alone is not an answered-widget receipt; matching native canonical question/answer evidence confirms it. An unknown submitted answer is not automatically reoffered or replayed. Tool payloads and full conversation history are not cached to render question controls.

## Scoped approvals share one authority

`src/codex/approval.ts` normalizes native requests into explicit choices with exact native response payloads. The single native App Server adapter uses this model; channel cards, complete IM reply commands and Web UI → **待审批** project the same live controller. Gateway does not execute tasks through `codex exec --json` or a private Desktop approval protocol.

- Command and file requests can offer once/session decisions. `availableDecisions`, when present, restricts the choices. Command rules retain the complete native argument prefix; network rules retain the offered host and allow/deny action.
- Extra-permission responses retain the requested permission object and native `turn`/`session` scope. They do not acquire arbitrary persistent grants.
- Empty MCP confirmation forms are once-only unless their native metadata explicitly declares `codex_approval_kind: mcp_tool_call` and a `persist` array containing `session` or `always`. Only those declared scopes are then offered and returned as `_meta.persist`; unknown persistence declarations remain unsupported. Computer Use treats accept without `_meta.persist` as session scope, so these forms must not display a misleading approve-once alternative. The installed implementation advertises session/always capabilities per target app. The native tool owns permission storage and revocation; prompt text and server names cannot invent persistence.
- Nonempty forms, OAuth/verification challenges and unsupported interactions retain their existing typed or secure flow; they are never flattened into an always-allow button.

Approval identity includes the execution host, native connection and typed native request ID. For MCP, a subsequently filled-in `turnId` is correlation, not a new request. Repeated pending snapshots do not create a second card. Choices are snapshotted before display; Web decisions include the account, original conversation, approval ID and scope version. IM/Web races, stale versions and unsupported choices cannot consume a different request. Receipts return to the original route even if the primary binding changes.

Selecting a choice records **unconfirmed**, not success. App Server requires `serverRequest/resolved` after submission; this confirms request completion rather than a persistent-grant guarantee. Transport loss or turn completion without a receipt cannot claim persistence and never retries a possibly accepted decision. Per-account `runtime/<account>/approvals.json` is an atomic, private audit of choice/receipt/identity hashes only: it stores neither tool arguments nor a reusable permission rule, and restarting Gateway never replays approval history. Native Codex/MCP remains the sole grant authority. Existing Web IDE browser grants are separate and are not reset or extended by this feature.

Protocol reference: [App Server approvals](https://learn.chatgpt.com/docs/app-server#approvals), [Computer Use permissions](https://learn.chatgpt.com/docs/computer-use#permissions-and-approvals). The native response mapping was checked against installed CLI 0.164.0 and Desktop bundled CLI 0.164.0-alpha.11.1; Desktop/Computer Use persistence is an observed native capability rather than a universal promise for every MCP server.

## Native execution recovery is not delivery retry

Read-only startup reconciliation is independent of IM/card projection; a delayed card update cannot hold native recovery state open. Uncertain records are rechecked every 30 seconds, with one in-flight check per host/thread and a 25-second observation deadline matching the follow-reader budget. A slow or unavailable backend during startup leaves the record protected for the next check rather than abandoning reconciliation permanently. Stopping invalidates pending observations and clears the timer. These checks only close known accepted terminal turns; they never authorize continuation or replay. Closure and protected-state diagnostics record identity, reason, elapsed time and a bounded error category, without prompts or provider details.

Recovery chains have independent attempt budgets and cancellation state. A newly observed capacity failure cannot inherit an old chain's `cancelFuture` flag or remain permanently blocked by a proved-ended accepted turn. Reconciliation is read-only and coalesced by host/thread: the current loaded native snapshot must match the offered failed tail, while an uncertain old acceptance must have one exact native turn ID (or unique client-message correlation), a terminal status, and a position before that tail. Missing, contradictory, foreign or timed-out evidence preserves the uncertainty and submits nothing. Binding/backend changes, new user input and lifecycle changes invalidate pending reconciliation. Native queue/owner checks still run at the actual empty-input continuation boundary.

Startup may close a previously accepted, proved-ended recovery record read-only; it does not scan historical failures to create new work. New chains durably retain retired native turn IDs and the previous closure evidence, so late old failure events cannot cancel or restart a newer chain, including after restart. Unknown submissions without exact acceptance evidence remain protected.

A new authorized IM or Web message reaching a bound `systemError` session with an explicit native capacity-failed tail enters that same recovery coordinator instead of being sent to Desktop-only guidance. The dedicated request path re-reads the exact tail and binding before claiming recovery; it never relaxes ordinary run/steer preflight, submits the new message, resets an exhausted same-turn budget, or retries other system errors. An already-delivered failure card remains terminal. Only confirmed native acceptance of the continuation can create the next progress card, preserving the original binding, interaction route and audience.

Startup never replays historical acceptance chains. A saved running/uncertain record may restore its accepted mapping only after a fresh snapshot proves that exact native turn is currently active. Finished/cancelled records can only correct an existing false recovery card after read-only evidence of archival or an ended accepted turn. That correction closes only the existing presentation, removes its execution controls and does not create a native terminal receipt, new card, message, or execution. Corrections have their own persisted delivery receipt and remain distinct from task results across restart.

When a result and native mentions are combined into a final card, the source progress card preserves the terminal outcome. Failure summaries include the failure reason and point to failure details; interruption, detachment and continuation use their corresponding wording. Only successful results use the ordinary complete-result summary, and an existing status strip is not repeated as another heading.

The backend normalizes native errors into a closed vocabulary (`CodexFailureCode`), including current camelCase and legacy PascalCase codes. Model capacity (`serverOverloaded` / "model is at capacity") is distinct from rate limits, exhausted usage, authentication and safety refusal. Provider `additionalDetails`, stack traces and arbitrary error bodies are never copied into IM notices.

App Server `error` notifications carry an exact thread/turn identity and `willRetry`. They are **nonterminal observations**: `willRetry=true` means Codex itself is retrying; `false` waits for the final turn receipt, rather than inventing one. `CodexRunnerInput.onRecovery` projects that state into the existing presentation handle. Progress or answer activity clears the notice; only native completion ends the card. Duplicate errors do not produce more notifications, foreign/late errors cannot reopen a completed turn, and errors arriving before the start receipt are drained only after binding the accepted identity.

Read-only follow uses the same normalized recovery metadata, scoped to the active native turn and its loaded runtime. An active Desktop snapshot with an error but no explicit retry signal is shown as waiting for further status, **not** as a promise of automatic retry. Its notice and original card handle survive Gateway restart. Neither the follow hub nor channel transports acquire execution authority or start another turn to recover a model error.

The protocol has no `turn/retry`, but the installed Desktop capacity-retry implementation uses `startEmptyTurn`: a new `turn/start` with `input: []` in the same thread. This is an explicit continuation, not a replay of the original user message or a resurrection of the failed turn. Gateway supports this capability through `resumeAfterCapacity`, separately from ordinary `run`, steering, and delivery retry. Only a confirmed capacity failure in a bound, followed session is eligible; auth, quota, safety errors and unknown submissions never trigger it. The native owner is retained, and native queue entries have priority. A fresh loaded idle state (or `systemError` with that exact capacity-failed tail) and no active turn or pending approval/input must be rechecked immediately before the external write; unsupported or changed owners fail closed, without fallback. This dedicated gate never relaxes ordinary message preflight or recovers arbitrary system errors.

`CapacityRecoveryCoordinator` is global to AccountManager and keyed by host/thread, not channel or binding. It persists a bounded 10/30/120/300-second plan, attempt identities and accepted native IDs before/after writes. Concurrent failure observations share one plan; user input, steering, queue changes, stop and lifecycle changes cancel pending plans. A crash in submitting/running state becomes uncertain and is only observed, never blindly resubmitted. Known accepted IDs and newly confirmed failures can authorize the next bounded attempt. Pending plans resume after restart; old terminal cards are not scanned to start new work.

The follow hub delegates capacity decisions to the coordinator; it never calls execution APIs itself. Early native start/activity/snapshot notifications are held until acceptance is mapped. Accepted continuations transfer the original card checkpoint, participant audience and interaction destination to the new native ID; they do not segment or finalize the card. Terminal completion is emitted once when successful, nonretryable, cancelled, or exhausted. No model or permission override is added. Continuing with existing context avoids replaying the original prompt, but it cannot guarantee that a model will never repeat a tool action; unknown execution outcomes are not retried. This compatibility adapter is verified against the installed Desktop/CLI protocol and mock transports, not a guarantee of public API stability.

Protocol references: [official App Server lifecycle](https://learn.chatgpt.com/docs/app-server) and installed `codex-cli 0.154.0` generated `ErrorNotification` / `TurnError` / `CodexErrorInfo` types. OpenAI API retry guidance is not treated as a capability to replay a partially executed Codex turn.

## Contracts

The shared types live in `src/codex/backend.ts` and `src/codex/interactions.ts`. The facade covers execution, metadata, history, models, limits, goals, lifecycle, queue and native interaction subscriptions. Connection lifecycle and host transport do not choose different business implementations. Native state and expected-turn guards remain authoritative; unknown state is not idle. Only concurrent identical reads share in-flight work; results are not cached as permission to write.

Project-bound new threads resolve the native project ID from the host's project registry; explicit independent threads use `projectId: null`. A cwd is not a membership grant. Bridge-only policy is sent through developer instructions; the channel user's text remains the actual input. Existing thread settings are inherited without implicit approval/reviewer/sandbox overrides.

### Native queue and receipt recovery

`CodexNativeQueue` exposes native add/list/delete/consume operations on the same host and service. Queue admission is an atomic native append with the original source identity. It is separate from consumption and does not authorize resuming a task, changing permissions or selecting another executor.

`NativeQueueCoordinator` is a shared application service, not an IM adapter or a second execution backlog. Codex owns input content, order and pending-item persistence. Gateway stores only account/conversation/actor/message identity and submission/turn/delivery receipts in `runtime/native-submissions.json`, durably before submission. Recovery pages through native queue and history using exact client and turn IDs, never text similarity. Ambiguous writes are not retried; known consumed turns are observed, never started again. Delivery uncertainty stops automatic re-delivery and points to `/history`.

Queue operations use short per-host/backend/thread control locks. Execution observation is separately guarded per thread; different threads recover independently, and controls/approvals do not wait behind a running task. Admission rechecks channel lifecycle, exact binding, actor access and role after preparation and immediately before the native write. A Gateway-owned native item may auto-start on add or resume: retain that execution connection and route approval/user-input events to its original account and actor. An external owner observes native store revisions and consumes its own pending input; the admission connection can exit. Only an idle, verified native head may be explicitly consumed by Gateway. Binding changes do not retarget accepted work, and revoking Gateway access does not cancel already accepted native queue entries; cancellation requires an explicit native delete before consumption.

Private stdio shutdown interrupts active execution. Native pending items and receipts persist, but active work is not transparently migrated to another executor. Closing/recycling waits for the local client process to exit before a replacement lifecycle proceeds; global configuration updates refuse active Gateway work before persisting changes or closing its executor. Shared daemon lifecycle is independent of Gateway clients. Isolated real Codex tests with a local mock model cover idle/busy admission, restart, concurrent external writers, cancellation and one observed execution per accepted input.

### Session discovery is a first-class operation

`listSessionCatalog` returns native paged storage with explicit host/thread identity, persistence, completeness and warnings. It does not select Desktop storage or CLI rollouts on failure. Internal/ephemeral tasks and explicitly classified probes are excluded structurally. UI aliases, pins and manual order may decorate rows without replacing native membership or runtime. Selecting a row always rechecks the native lifecycle. ChatGPT chats are not Codex threads and cannot be bound.

## Routing rules

| Configuration | Connection and failure behavior |
| --- | --- |
| app-server | All operations use the selected host/core; errors are returned without changing executor |
| legacy auto/exec | Configuration migration normalizes to app-server; direct retired exec construction rejects |
| daemon/stdio transport | Deployment choice within the same protocol; stdio has a Gateway-owned lifetime |

Model, effort, runtime and account queries preserve the bound host; model/runtime queries also retain the native cwd and thread. A remote failure never substitutes the local model list or account. A late query cannot apply settings or disclose its result after binding or access changes.

## Follow synchronization boundary

`SessionFollowPort` (`src/bridge/session-follow.ts`) is the application boundary between channel commands and persistent delivery. `BridgeService` handles `/follow`, `/follow on|off|sync` and status presentation; `AccountManager` resolves the account + session binding and verifies it is still active. `ThreadEventHub` owns subscriptions, synchronization health, read cursors and card checkpoints. IM adapters only implement presentation and acknowledge transport delivery. No DingTalk-only synchronization implementation or second binding flow is introduced.

Both background recovery and explicit synchronization use the native adapter's existing read-only `readThreadSnapshot(threadId, hostId)` contract. Desktop and CLI deployments have the same native follow capability; the retired exec runner's limitations are not a selectable production mode. An explicit sync never calls start, resume, steer or stop, does not enable disabled following, and respects `/stream off`. Repeating `/follow on` performs a new synchronization even when the setting is already on.

Targeted reads have a 25-second deadline and do not wait for unrelated subscriptions. Concurrent manual requests for a binding are coalesced; a newer read supersedes late background results, and binding changes invalidate delivery. Persisted health distinguishes successful sync, unconfirmed runtime, backend timeout/failure, and card delivery failure. Runtime `notLoaded`/`unknown` and orphan Desktop UI turns never count as successful synchronization. Safe structured diagnostics include host/thread identity and an error category, never provider payloads or credentials.

Activity cards restore from their saved handles even when all progress entries are already deduplicated. Explicit recovery probes update that same handle; failed updates do not create replacement cards or switch to text. Text-only channels retain native batching without replaying past turns. Completed turns remain terminal and final delivery remains deduplicated across restarts.

## App-server transports

The app-server protocol implementation is independent of its transport:

- `auto`: prefer the managed standalone daemon; otherwise use the configured Codex command's daemon. Legacy custom wrapper commands whose executable name is not `codex` retain their explicit private-stdio compatibility behavior.
- `daemon`: idempotently start the managed or configured daemon, then relay JSONL to its native control WebSocket. An unavailable service fails before a turn starts; it does not create another executor as fallback.
- `stdio`: run `codex app-server` with its default stdio transport.
- remote projects: use the registered Codex Desktop host and an SSH relay to its app-server control socket.

This separation keeps daemon lifecycle and remote transport concerns out of JSON-RPC request handling.

## Native project membership and IDE

Native thread responses normalize `projectId` into assigned, explicit-none, or unknown membership. The discriminator and ID travel together through inspection, catalogs, follow snapshots and lifecycle responses. Desktop presentation can translate an exact migration alias or ordering preference; it cannot restore a native projectless chat.

IDE link enrichment and browser/proxy/upgrade access use the same asynchronous native membership refresh. Their synchronous projection reads the reconciled Gateway edge instead of consulting a second Desktop-only authority. This also works when no Desktop app or GUI registry exists. Existing project/worktree entry identity, browser grants and full-root authorization remain separate from the transport used to read native state.

## Extending the interface

Add a native operation to the shared backend contract and the single adapter, with typed request/response normalization and host/thread/source guards. Cover both a native wire fixture and a real isolated service when execution or persistence is involved. Do not introduce an environment-specific business branch, another backend selector or a fallback to compensate for missing protocol support. Channel rendering stays above this boundary.

## Session intervention and restart recovery

The selected per-conversation session receipt is the binding authority. Project selection is its context projection, not a second condition that can make an existing independent session appear unbound. Startup normalizes legacy context drift from the selected session while preserving native IDs, detached markers, follow state, access roles and idle-clock receipts. Explicit selection of an incompatible project ends the old edge; project-only commands cannot silently choose the first project over an independent binding. Native project-membership reconciliation also repairs the context projection when session metadata itself was already current.

`ThreadEventHub` owns persistent delivery state above the backend facade. Its keys include the account/binding, host, thread, and active turn. `readThreadSnapshot` is the backend's read-only observation API; it uses native thread reads and paginated turns, without resuming or taking writer ownership. Local rollout notifications supply immediate activity; five-second reconciliation repairs missed notifications, supports remote hosts, and closes a card when its turn completed while the gateway was stopped. Only public commentary, progress summaries and answers are forwarded.

`runtime/thread-subscriptions.json` stores the active turn, last observed lifecycle state, delivered-event hashes, completed turn IDs, and streaming card checkpoint. DingTalk declares support for updating a persisted card ID after restart. Transports that cannot restore a saved handle retain an explicit unconfirmed delivery state; card recovery does not silently create a replacement. A failed terminal update remains associated with the same turn and handle.

Historical baselines are separate from confirmed completions. Private App Server reads of `notLoaded` Desktop threads can reconstruct an active turn as completed/interrupted, so these snapshots never finalize a card. Local lifecycle records supply terminal evidence and recover persisted pending turns after restart. The bounded log-tail reader can recover a long turn's identity from explicit context/usage records even when its start marker is outside the tail. Remote recovery needs an authoritative shared runtime; an unloaded, foreign remote writer's terminal state cannot be safely inferred. Card recovery applies to checkpoints created by this implementation, not cards created by older releases that never saved their handles.

Rollout identity and visibility are parsed centrally: `id` identifies the current thread; legacy `session_id` is only a fallback, since it may identify a reviewer's parent. Guardian reviews and subagent sources are excluded before any history-catalog, progress, completion, project-notification or startup-recovery callbacks. Filtering is based on event provenance, not words inside the answer. Progress and completion hints cannot switch an active card to another turn; only a real start event or an authoritative loaded snapshot can advance it. Retired turns stay rejected after restart. Versioned checkpoints discard text saved before this boundary existed while retaining recoverable card handles.

For local replay of an internal rollout, run `TMPDIR=/private/tmp node --import tsx scripts/verify-rollout-isolation.mjs --run /absolute/internal-rollout.jsonl`. It uses a temporary copy and mock delivery, verifies that internal events cause zero sends while the main task still completes, and removes its temporary files. It does not call Codex or IM APIs.

`SessionControlJournal` serializes controls by host/thread and writes receipts before submitting either guarded input or an ordinary thread-scoped message. Both reuse the same receipt format and write-ahead store, not a second queue. Accepted duplicate requests return the recorded result. A request with an unknown transport outcome is never automatically replayed; the user is asked to inspect history. Pending choice cards persist their actor, chat, binding and expected turn, so an old click cannot affect a newly selected session. This does not claim transactional exactly-once delivery across IM APIs: a crash between a remote acknowledgement and the local checkpoint can still leave an uncertain outcome. The gateway does not automatically replay an unconfirmed user action.

Ordinary IM text during an active turn defaults to `steer`. The facade's `submitThreadMessage` freshly identifies the current active native turn and calls standard `turn/steer` with `expectedTurnId`; explicit `/steer` and targeted cards use the same guarded protocol. Binding and access are rechecked immediately before writing. Unknown, idle, orphan or changed targets reject without starting a new task or queueing. Missing and mismatched receipts remain uncertain after restart. No private Desktop follower method chooses or silently changes the receiving turn. The existing follow subscription keeps the same progress card and completion cursor.

Explicit per-session overrides remain intact: `ask` offers only supported guarded actions, and `queue` submits to the native next-turn queue. The native service owns queue persistence and consumption. No implicit policy or backend fallback occurs. The same policy boundary applies to DingTalk, WeChat and Feishu. Binding changes invalidate subscriptions centrally. Switching or leaving does not interrupt Codex; queued work stays attached to its original session, but later progress/results are not delivered into the recipient's new binding. `/leave` remains detached across restart until an explicit selection or `/new`. `/stream off` suppresses followed progress without losing the final result.

### Chat commands

| Command | Behavior |
| --- | --- |
| `/help`, `/help session` | Show all commands, or just the session intervention guide |
| `/sessions` or `/sessions all` | Pinned sessions, then project folders with nested sessions in native order, then other sessions. Empty projects remain visible; unavailable/incomplete catalogs are labeled separately. Pinned sessions appear once. Default 10 items per page (sessions or empty folders); no project prerequisite |
| `/sessions size 50` | Set 5-50 items per page, persisted per account/conversation/actor; project headings do not consume items or R numbers. Re-page a valid snapshot without rediscovery or changing R identities |
| `/sessions detail R1` or `/session detail R1` | Read details from the current actor's catalog snapshot without binding; available to viewers |
| `/sessions more`, `/sessions prev`, `/sessions page 3` | Page within the same snapshot; R codes remain stable for 15 minutes, until refreshed |
| `/sessions search words` | Filter titles, previews, IDs and directories, then paginate matches |
| `/sessions unbound` | Sessions with explicit native projectless membership; cwd does not establish membership |
| `/sessions project` | Optional current-project filter using native membership on the selected host |
| `/session R1` | Bind, replay history, and start following if the backend supports it |
| `/session THREAD_ID [--host HOST_ID]` | Directly inspect and bind without a project; default host is local |
| `/project`, `/project C1`, `/project P1` | Optional project-first workflow; selecting registers and switches; `/project add` is a compatibility alias |
| `/new` | Prepare a new session in the current project; prompt if none is selected, never pick the first saved project implicitly |
| `/new P2`, `/new C1`, `/new --project NAME` | Prepare and switch to a new session in the selected project, using the same selector as `/project` |
| `/new --standalone` | Prepare a local independent session with a unique durable workspace; no inherited project or remote host |
| `/session new ...`, `/s new ...` | Aliases normalized before mode and role checks |
| `/history 10`, `/history more` | Read recent messages, then older pages |
| `/follow on`, `/follow off` | Toggle live delivery for the selected session |
| `/leave` | Persistently detach and stop following, without stopping the task or implicitly resuming on the next message |
| `/policy ask`, `/policy steer`, `/policy queue` | Handle ordinary messages received during an active turn; global default is steer, explicit session overrides are preserved |
| `/steer text` | Submit guarded input to the active turn |
| `/queue text`, `/queue list`, `/queue cancel id` | Submit to native queue, inspect this chat's receipts, or cancel an owned pending native item |
| `/intervene ID steer\|queue\|cancel` | Resolve the originating user's pending choice |
| `/role`, `/role USER viewer\|participant\|controller` | Inspect or configure chat permissions |

Global catalog loading follows every native App Server page; UI page size is not a discovery cap. Internal review/subagent, archived, missing, ephemeral and system-error sessions are excluded. Unavailable remote hosts produce partial-results warnings, not backend fallback. Native card choices carry exact host + thread IDs, so an old card never reinterprets its R code against a newer snapshot. R snapshots are scoped to conversation + actor. Selection rechecks lifecycle and permissions rather than trusting cached rows.

#### Probe records versus user conversations

Health-check conversations are not necessarily archived: `source=exec` and a `READY` title do not prove that a task is a probe. The Gateway therefore uses an optional, deployment-local `session-purposes.json` in its state root (shared by all IM accounts). Administrators may record **confirmed** probe identities:

```json
{"version":1,"entries":[{"hostId":"local","threadId":"confirmed-probe-thread-id","purpose":"probe","reason":"Verified against the health-check script and run record"}]}
```

This is Gateway catalog policy, not a backend lifecycle state. Every native App Server catalog passes through the same filter before counting, grouping, numbering and pagination; all IM renderers receive the same filtered rows. `/sessions`, `all`, `unbound`, `project` and search exclude marked probes and report the hidden count. Unmarked conversations are not removed by this filter because of their titles or `exec` source; Native catalog visibility rules still apply. Host + thread ID matches are exact. A missing file means no classifications; malformed or unreadable files produce an explicit warning and do not silently hide tasks. Keep real host IDs and thread IDs in deployment state, not in source control.

Discovery does not write the registry or modify, archive or delete Codex tasks. Direct `/session <ID> [--host HOST]` access remains available after lifecycle checks. Remove an entry (or set its purpose to `conversation`) and refresh `/sessions` to restore its visibility. Registry changes take effect on refresh; existing page snapshots keep stable R identities until refreshed or expired.

Prevent new probe pollution at the source: use `codex exec --ephemeral` for disposable CLI health checks, or `ephemeral: true` for App-server test threads. Normal Gateway conversations remain persistent. See [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Bindings are identified by host + thread ID within a channel recipient. A project is optional: `ManagedSession.projectBinding: "none"` prevents normalization from creating a fake project from an independent task's cwd, including pending sessions without a thread ID. Existing persisted project bindings are preserved. New-session commands prepare the Gateway record; the next message starts the actual Codex thread. Independent workspaces are allocated under the account state directory at `workspaces/standalone/session-*`, persist across restarts, and are not deleted on switching or completion. Project selection remains useful for project-scoped `/new`, Taskboard and knowledge-base modes, but is no longer required to continue existing tasks or create independent sessions. Derived legacy workspace groups remain presentation hints, never project membership or IDE authorization.

### Native capability coverage

Desktop and CLI-only deployments use the same native capability contract: project/catalog discovery, public history paging, new/existing execution, follow, guarded steering, native queues, stop, models, account limits, goals, lifecycle changes and structured interactions. Experimental methods can explicitly report an unsupported server version; they do not trigger another adapter. Legacy exec capability constants and disk readers exist only for compatibility tests/migration, outside production selection.

Disk history alone does not prove that an execution is active or ended. Native membership is distinct from cwd-based presentation groups. The Gateway does not kill another application's process to acquire a thread.

The existing allowlist still gates access. Explicitly allowed individual users default to controller. Users admitted only by a group allowlist default to participant. An explicit per-user role overrides that default; `/role * viewer` sets the group default without removing individually configured controllers. Viewers can inspect sessions and history; participants can converse and steer; controllers can additionally stop turns, handle approvals, and manage roles. Trusted native card callbacks pass through the same role checks as slash commands; ordinary natural-language text is forwarded rather than interpreted as a control command.

Validation includes a completed-offline turn updating its original card, host isolation, duplicate and ambiguous control receipts across restart, concurrent actors, stale choice rejection, role restrictions, and history cursors. Full live validation additionally requires a running shared App Server and actual IM delivery; mocked tests alone do not establish Desktop compatibility or client-side rendering.

The opt-in `scripts/verify-live-intervention.mjs` creates a separate ephemeral, read-only task and checks that guarded steering changes that same turn's final response. Run with `TMPDIR=/private/tmp node --import tsx scripts/verify-live-intervention.mjs --run /absolute/path/to/codex` on macOS. It never sends to an existing thread or IM account. This test passed with Codex 0.153.4; it verifies the official protocol, not DingTalk client rendering. Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
