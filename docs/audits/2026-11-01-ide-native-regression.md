# Native migration: retained-feature review and IDE regression

Baseline: `485e3262e42ba700314097707e952fa3163a0bb6`. Scope: Gateway, its native protocol boundary, existing user-facing contracts, static UI/configuration and publication. Farming's implementation and the independent Taskboard application are outside scope; multi-root workspace access and Gateway's Taskboard integration are included.

## What went wrong

The previous release verified build identity, account connection, exact IM binding edges, browser grant fingerprints, TTL and endpoint readiness. Those checks did **not** exercise native project response parsing through IDE link generation. The report's four headings and passing suite were insufficient evidence for preserving that end-to-end behavior.

Two failures were reproduced independently:

1. `parseThreadState` retained the wire `projectId` but omitted `projectMembership`. Native presentation and IDE identity reconciliation require the `assigned` discriminator. Consequently an existing project task could execute normally, retain its IM binding and grants, and still lose its progress/final IDE link. Existing IDE tests supplied already-normalized states, bypassing the faulty boundary.
2. `AccountManager.ideWorkspace` synchronously consulted Desktop-only membership after the asynchronous native observation. This created a second authority: an absent/stale GUI registry could override a confirmed native assignment, particularly on a CLI-only host. Existing coverage replaced that private observer in a test instead of exercising the actual native-to-IDE path.

The fixes normalize assigned/null/omitted/invalid wire membership at the protocol boundary and remove the Desktop-only authority from synchronous IDE projection. Browser entry, HTTP proxy and WebSocket authorization still await the existing native membership refresh. Unknown reads retain stored grants/bindings but cannot authorize access. Explicit native removal invalidates the project entry. No cwd-based grant, permission expansion, alternate executor or task replay was added.

The screenshot's separate progress record and final participant-mention card are an existing channel delivery rule, not a newly started Codex task. The user's earlier requests explicitly require acknowledged answer/steer segmentation, queue segmentation on actual execution, and a final answer with all participants. This fix preserves those rules rather than deleting them to conceal a missing footer.

## Historical requirements reviewed

The three available rotations of this chat, beginning 2026-08-27, were streamed locally. User messages were extracted chronologically, including the later clarifications that supersede earlier preferences; system/plugin envelopes and repeated private-knowledge preambles were excluded from the readable request view. Historical text requirements were reread. Old image-only complaints are not treated as newly inspected screenshots; the current supplied screenshot was actually opened. Raw history and private deployment details remain outside the repository.

Important supersessions: ordinary busy-session input defaults to steer, explicit queue uses Codex's durable queue; one standard native App Server implementation supersedes Desktop/CLI business routing; IDE browser grants are 90 days; useful reply commands retain independent copy controls while reference paths and enum values do not.

## Four-layer review coverage

| Layer | Responsibility checked | Evidence and limits |
| --- | --- | --- |
| Architecture | Native execution/project facts, Gateway access/binding facts and channel presentation remain distinct; Desktop preferences cannot become native access authority | Both reproduced defects crossed these boundaries. Read IDE entry/refresh/proxy paths, project alias reconciliation, native state parsing, production adapter factories and result decoration |
| Modules | Project membership → stable entry → progress/final footer, with local/remote and CLI-only operation; unknown/moved/projectless, source revocation, restart and multi-alias behavior | Real isolated native tests plus membership, IDE access/authorization/endpoints, follow, audience and forwarding regression suites |
| Files/functions | Parser callers (inspection, catalog, follow snapshot, unarchive), native presentation, AccountManager resolution/reconciliation, WorkspaceIDEManager identity/reference/refresh, access-server HTTP/WS boundaries, result/mention decoration | `native-project-membership.test.ts` traverses raw wire fixtures; `shared-app-server-integration.test.ts` traverses real native responses. Existing lower-level tests remain, with the private Desktop-observer replacement removed |
| Static/configuration/publication | Single backend field in settings, transport selection, portable IDE profile, per-host origin/IP selection, copy controls, asset packaging, authorization TTL, release artifact/grant/binding checks and current architecture documentation | Read the changed settings/config paths and relevant existing scripts/assets; run complete regression and typecheck before an isolated release. Correct stale transport/follow documentation. Production acceptance additionally checks fresh local/remote IDE entries, which the previous readiness-only release missed |

This is a review of retained contracts and the migration's affected boundaries, **not** a claim that every unchanged repository file has been reread line by line in this run. Earlier file inventories remain historical evidence, not fresh coverage. Test success is not a proof that no hidden defects exist. Real phone rendering/reachability and third-party provider behavior cannot be certified by local fixtures.

## Retained feature matrix

| User-facing contract | Relevant regression evidence |
| --- | --- |
| One native protocol in Desktop and CLI deployments; no automatic executor switch | `execution-owner-routing`, `shared-app-server-integration`, `remote-codex-host`, `codex-backend` |
| Continue unopened chats; native lifecycle and inherited permissions/reviewer | `shared-app-server-integration`, `codex-app-server`, `codex-failure-lifecycle` |
| Local/remote project selection, independent chats, explicit unbind, precise Web binding controls | `project-identity`, `full-review-project-identity`, `session-catalog`, `binding-expiry`, `architecture-round3` |
| Session lists omit archived/internal tasks; pins → projects → other tasks; stable pagination/detail identities | `desktop-session-catalog`, `native-project-membership`, `session-catalog-order`, `session-density` |
| Ordinary input steers an active turn; explicit queue is native, durable and consumed once | `native-queue`, `desktop-native-queue`, `shared-app-server-integration`, `session-message-lifecycle` |
| Unknown submissions are retained without replay and cannot freeze later independent inputs forever | `forwarding-inbox`, `session-control`, `turn-submission` |
| Restart protects Gateway handoff/answer/delivery, not an accepted independent Codex task's duration | `restart-ownership`, `release-admission`, `shared-app-server-integration` |
| Follow reconnects the same host/thread/turn; no silence-based task timeout or false success | `thread-event-hub`, `session-follow`, `session-owner-recovery`, `native-turn-lifecycle` |
| Recover eligible systemError with visible progress without repeating user input | `system-error-recovery`, `system-error-lifecycle`, `thread-system-error` |
| Native approvals and scopes reach the correct IM destination; no fabricated decision | `channel-approval`, `app-server-request-monitor`, `interactions`, `shared-app-server-integration` |
| Question siblings, peer answers and pending requests survive observation reconnect without resubmission | `native-async-questions`, `interaction-routing`, `bridge-user-input` |
| Remote human admission approvals are exact to request, actor/group scope and administrator | `admission`, `admission-web`, `access` |
| All turn participants are mentioned, including accepted steer inputs, with complete final answer | `completion-mentions`, `turn-audience`, `dingtalk-mentions` |
| Answer/steer segments follow native acceptance; queue segments follow actual turn start | `turn-presentation`, `presentation-input-lifecycle`, `late-queue-presentation` |
| Progress/commentary/tools remain visible; native loading stops/starts with actual activity | `progress`, `turn-status`, `compact-progress-design`, `dingtalk-progress-layout` |
| Useful stop/answer commands have separate inert copy controls; native forms do not duplicate enum replies | `copyable`, `dingtalk-code-blocks`, `intent-review-channel-forms`, `intent-review-channel-forms`, `dingtalk-markdown` |
| Full final text is paginated rather than silently truncated; uncertain delivery is not replaced by another send | `result-pages`, `result-delivery-lifecycle`, `stream-bootstrap`, `completion-mentions` |
| Inbound images/quotes/files and outbound attachments preserve host/source identity | `dingtalk`, `inbound-references`, `inbound-files`, `full-review-output-ownership` |
| One Gateway-owned stable project/worktree IDE link in progress and final result, never stale projectless footer | `ide-membership`, `native-project-membership`, real native IDE integration cases |
| Local code-server stays local, remote code-server stays remote; configured fixed host endpoints and local selected-interface discovery | `ide-endpoints`, `ide-hotplug`, `ide-local-address`, `remote-codex-host` |
| Full multi-root project workspace and worktree isolation; no inference from a nearby cwd | `ide-membership`, `ide`, `ide-membership`, `project-identity` |
| Personal IM admission is reused for browser pairing; group permission alone does not grant personal IDE access | `ide-approval`, `ide-approval`, `admission`, `ide-authorization` |
| 90-day browser authorization, exact scope/trust and revocation persist across restart; copied URLs are not credentials | `ide-authorization`, `ide`, `ide-endpoints` |
| No extra code-server password; approved browser redirects directly; workspace trust remains scoped | `ide`, `ide-approval`, `ide-membership` |
| Portable theme/icon/font/line-height preferences, Emacs extension checks and default closed Chat | `ide-profile`, `ide`, `ide-web` |
| Optional Taskboard/knowledge operations do not own native execution or block core UI/save paths | `intent-review-web`, `intent-review-taskboard`, `channel-adapters`, `llm-wiki` |
| Settings/static references, config validation/migration, build identity and publication preserve actual capabilities | `config`, `intent-review-build`, `intent-review-web`, `release-local`, `update-manager` |

Names above identify test families, including prefixed variants; the release's tests log contains the exact executed files/cases. This matrix states preserved requirements and their verification sources, not real-provider or real-phone acceptance for every row.

## Evidence and publication

Private local evidence records the original native assigned-state failure, the CLI-only IDE failure after the parser fix, and the corrected native runs. Intermediate fixture errors (missing project-create idempotency key, native path canonicalization, and the native empty-string project-clear encoding) were corrected and are not counted as product defects.

The fixed-version native tests cover stable old project IDs/URLs, local CLI-only operation, explicit native project removal, no extra model request, and raw assigned/null/omitted/invalid membership across metadata, snapshots, lifecycle and filtered catalog reads. Release prepare/seal/verify logs remain authoritative for final commit, full regression and deployment status. No synthetic task or approval was submitted to a production conversation for this review.
