<h1 align="center">Agent Bridge</h1>

<p align="center">
  <img src="src/web/favicon.svg" alt="Agent Bridge logo" width="128" height="128" />
</p>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <strong>Connect your agents to WeChat, Enterprise WeChat, Feishu, and DingTalk.</strong>
</p>

`@yanjijinxiao/agent-bridge` forwards messages to Codex or a Herdr-managed terminal on the selected device and returns progress and results to the originating chat. The npm distribution includes Gateway and the Codex and Herdr TUI/App Connectors. Browser editing, Git, integrated terminals, and refresh/reconnect have been verified on both Mac and Linux. Codex desktop and CLI-only environments use one standard App Server interface. Every Gateway execution path uses an outbound Connector, which reuses the existing local and remote host connections.

Herdr uses an explicitly configured Connector endpoint, with catalog, terminal lifecycle, durable input handoff, read-only recovery, IM/Web observation, files, sharing, and a full IDE on local or App remote machines. Its APIs expose status and turn-related counters, but output reads cannot select the text belonging to one conversation turn. A terminal card may include earlier exchanges still in the read window. Native approvals, model settings, and queue receipts are separate capabilities and are not emulated with terminal keystrokes. See the [Herdr configuration guide](docs/herdr-connector-guide.md) and the source checkout’s four-layer audit for the exact validation boundaries. Release changes and upgrade notes belong in the [changelog](CHANGELOG.md); tutorials do not pin an installation version.

Passive follow quietly establishes a screen baseline and does not replay an unchanged idle screen merely because its status counter increases. Observed activity and fast completions with changed output remain visible; results belonging to Gateway inputs retain their own delivery obligations.

| Execution location | Connection |
| --- | --- |
| Gateway machine | An independently running Connector on the same machine connects to its configured native App Server |
| An SSH host registered with Connector | The same Connector reuses the target host identity and SSH configuration; another Connector on each remote host is unnecessary |
| A user's computer or server | A Connector dials Gateway; the user pairs and selects a session in IM, without opening inbound ports on the device |

The local administration console binds to `127.0.0.1` and is not a multi-user login portal. Administrators separately enable Connector WSS and project IDE HTTPS endpoints; do not expose the management port. Gateway retains channel configuration and forwarding state. Native sessions, model credentials, and Connector pairing receipts stay on their respective devices.

## Choose your setup

| Goal | Start here |
| --- | --- |
| Connect your computer to someone else's Gateway | “Connect to an existing Gateway” below and the [Connector guide](./docs/gateway-peers.md) |
| Use the Tantan DingTalk deployment | [Tantan user tutorial (Chinese)](./docs/tantan-connector-guide.md), including pairing, commands, group behavior, and administrator prerequisites |
| Host your own bots and Gateway | “Deploy your own Gateway” below and [channel setup](./docs/channel-setup.md) |
| Enable browser editing, Git, and a terminal | [Web IDE configuration and access modes](./docs/web-ide.md) |
| Review architecture, requirements, and verification | [Architecture](./docs/architecture/README.md) and [requirement/case coverage](./docs/architecture/gateway-case-coverage.md) |

## Core capabilities

- **One gateway for multiple channels**: Personal WeChat, Enterprise WeChat, Feishu, and DingTalk run in parallel with account-isolated projects, sessions, approvals, and notifications.
- **One native Codex interface**: Desktop, Gateway and CLI clients use the selected host’s App Server for execution, following, interactions and remote projects. Connection failure never selects another executor.
- **Connector devices**: Each device has separate credentials and locally confirms the requesting person and chat. A single Connector can reach its local and registered remote hosts. Paired users can select native projects and sessions and exchange attachments through IM.
- **Project and session management**: Connector discovers registered hosts and queries each host's native project and session catalog; bind, switch, create, resume, queue, and validate archived or missing sessions. Identically named projects on different hosts stay distinct.
- **Long-running agent tasks**: Accepted tasks have no fixed overall timeout. Channels receive readable progress, tool state, and elapsed time while the final answer remains intact.
- **Media, approvals, and notifications**: Handle images, voice, video, and files according to channel capabilities. Command, file-change, and permission approvals return to the originating account and conversation.
- **Async question recovery**: Suspend Codex widgets when their connection drops, then verify the same native question and answer records after reconnecting. Accepted or uncertain answers are never replayed automatically.
- **Local management and extensions**: Manage channels, projects, sessions, models, and notifications from a Web console. An embedded Taskboard and declarative Skill capabilities can extend the channel workbench.
- **Optional full Web IDE**: code-server provides file editing, Git, and a terminal for local, SSH, or explicitly enabled Connector hosts, subject to the access conditions below.

## Supported channels

All four channels share the same project and session lifecycle. Native interaction follows each platform's capabilities.

| Channel | Connection | Input and interaction | Channel-specific experience |
| --- | --- | --- | --- |
| Personal WeChat | QR login / iLink | Text, images, voice, video, files | Voice transcription, native media transfer, typing state |
| Enterprise WeChat | Official smart-bot long connection | Text and bot messages | No public callback, approvals, task notifications |
| Feishu | Enterprise app long connection | Text, menus, cards, buttons, forms | Native project/task workbench and in-place card updates |
| DingTalk | Internal app in Stream mode | Text, images, rich text, AI Cards | Thinking state, in-place streaming card updates, file delivery |

Platform capabilities and setup requirements may change with official APIs. See [channel setup](./docs/channel-setup.md).

## Web management

<p align="center">
  <img src="docs/images/screenshots/web-session-management.png" alt="Agent Bridge Web session management" width="100%" />
</p>

The screenshot is a historical UI example, not current layout or capability verification.

The console adds and controls channels, authorizes senders, binds projects, displays sessions and running tasks, resumes conversations, and configures models, reasoning effort, progress, and completion notifications.

The optional Web IDE runs on the project host. Active AI cards and final replies can show the same fixed project entry. Hosts and access must be explicitly enabled; an unassigned session does not automatically receive a project IDE.

Default browser access reuses personal admission: confirm the browser once, then automatically trust permitted projects. An administrator can instead explicitly enable possession-of-link access: a new browser enters without a confirmation command or DingTalk SSO, and link holders can use files, Git, and the terminal. Access lasts at most 90 days and is not renewed by visits or restarts.

**Link access currently has one authority source per channel account.** That source must have a valid grant for the target Connector. Pairing a new user's device does not automatically enable that user's no-confirmation IDE. Verify each onboarding case; the console is not a multi-user portal and a full IDE is not an operating-system directory sandbox. See [Web IDE](./docs/web-ide.md) and the [current access contract](./docs/architecture/modules/ide-access.md).

## Connect to an existing Gateway

You do not need to deploy another Gateway or register a bot application. Ask its administrator for personal IM admission and enabled device enrollment. Configure the Gateway URL; Connector creates and stores its own identity. Pair once through /connect and local confirmation. No manually distributed device.token is required; existing tokenFile configurations remain compatible.

1. Prepare a working Codex installation, Node.js, and Git on your device. A CLI-only server does not need a desktop GUI.
2. Install the npm package below. It contains both commands; only run Connector when joining someone else’s Gateway.
3. Start from the [Connector example](./examples/peer-client.json), fill in the administrator's Gateway URL, and save it outside the repository. New devices omit nodeId and tokenFile: Connector creates and stores its identity. Select one native service explicitly; daemon mode does not switch executors after a disconnect.
4. Start Connector in an interactive terminal. Send its complete `/connect PAIRING_CODE` command to the bot; mention the bot when using a group.
5. Verify the requesting person, chat, and scope in the device terminal, then enter `yes`. Pairing codes last five minutes and are single-use.
6. Select a session from the returned list and use `/status` to check the device and directory. Pair again when moving to another chat.

A Connector appears once in `/connect`; its `/sessions` and `/project` catalogs can include local and registered remote projects. Execution, attachments, and IDE use the selected session's actual host. Remote registrations and SSH settings come from Connector's Codex data directory. Restart Connector after adding a remote host registration to refresh its exported hosts. A CLI-only server can also run Connector directly using the same App Server interface.

Install the prebuilt package:

```bash
npm install -g @yanjijinxiao/agent-bridge
```

Start Connector (replace the configuration path):

```bash
agent-bridge-connector --config /absolute/path/peer-client.json
```

Connector generates and privately stores its device credential. The first restricted connection offers a pairing code; enrollment completes only after the admitted chat user and local device confirm. Reconnects reuse saved grants. `/connect` lists only devices granted to the current person in the current bot account and chat. See [connection setup](./docs/gateway-peers.md) for configuration and lifecycle details, or the [step-by-step Tantan tutorial (Chinese)](./docs/tantan-connector-guide.md).

### Web IDE settings and extensions

Once the device's Web IDE is enabled, use the editor's own settings and extension panels to change appearance or install and uninstall extensions. Gateway no longer limits this to a fixed checkbox list. Extensions such as GitLens still depend on registry and runtime compatibility.

Administrators can import settings.json / JSONC, .vscode/extensions.json, or an exported .code-profile in Gateway's Web IDE page to define the initial baseline shared by enabled hosts. Import fills the form; saving applies the configuration. A profile imports only settings and enabled extensions, with warnings for omitted sections. After initial installation succeeds, reopening preserves the user's extension removals. See [settings, extensions, and profiles](./docs/web-ide.md#profile).

Preserve configuration and stateDir across upgrades: they contain device identity, grants, and receipts. Existing configurations keep their original nodeId and tokenFile; deleting them is not a migration. Administrators must explicitly enable enrollment; ordinary onboarding does not require sharing device secrets.

## Deploy your own Gateway

### Requirements

- Node.js `^22.13.0 || >=23.4.0`
- Git
- An installed and authenticated Codex CLI and an independently running Connector on the execution device; a Gateway-only server does not need Codex

```bash
npm install -g @openai/codex
```

```bash
codex --version
```

### Install and run

Install and start the prebuilt npm distribution:

```bash
npm install -g @yanjijinxiao/agent-bridge
```

```bash
agent-bridge
```

For source development:

```bash
git clone https://github.com/yanjijinxiao/agent-bridge.git
```

```bash
cd agent-bridge
```

```bash
npm ci
```

```bash
npm run build
```

```bash
node dist/server/index.js
```

Before starting Gateway, point `CODEX_IM_GATEWAY_PEER_CONFIG` to the Connector listener configuration and start Connector on the execution device, even for same-machine deployments. Without a configured device the management console remains available, but execution reports no connection; Gateway does not start local Codex. See [migration with preserved identities](./docs/architecture/connector-only-execution.md) for existing local/SSH bindings.

The service opens [http://127.0.0.1:8787](http://127.0.0.1:8787) by default. The npm artifact includes Web assets and embedded Taskboard. Installing never starts services or Codex.

To prepare the embedded Taskboard, `taskctl`, and bundled Skills as well:

```bash
npm run install:local
```

```bash
node dist/server/index.js
```

See the [local run guide](./docs/local-run.md) for background services, updates, and shutdown instructions.

## Add a channel and start chatting

1. Open the management page and select **Add Channel**.
2. Choose Personal WeChat, Enterprise WeChat, Feishu, or DingTalk, then scan or enter the required application credentials.
3. Send one message to the bot. If the channel requires authorization, allow the sender or conversation in the console.
4. Send `/sessions` to browse accessible unarchived sessions from the current source, then `/session R1` (or click a card) to bind directly. Connector users pair first and select a device through `/connect` when necessary.
5. Send a regular message to continue. Use `/new` for the current project, `/new P2` or `/new C1` for a selected project, or `/new --standalone` for an independent session on the current device; check the source first. The next message starts Codex. `/project add` remains a compatibility alias.

### Groups and permissions

**A group has one shared current binding, not a separate binding per member or an exclusive lock for the first binder.** Admitted participants can ordinarily unbind or switch; choosing their own Connector session still requires their own device grant. Switching changes where subsequent group messages go. It does not stop the previous task or transfer another person's device permissions. Resource-sharing guests also have a binding path for entering/leaving their permitted resources; roles are not an ownership lock.

Personally admitted users default to controller unless an explicit personal chat role overrides it. `/role` shows the current role; `/access` shows personal/current-chat admission. Admission administrators must explicitly use `/access all` in a bot direct message for an account-wide view, not in a group. Use separate direct messages or dedicated groups for independent tasks; replies already posted to a group are visible to its members.

### Combine messages and attachments

`/prompt start` opens a buffer, `/prompt done` submits the combined content, and `/prompt cancel` discards content that has not been submitted. Cancelling the buffer does not stop an accepted task. `/prompt` does not display system instructions.

Common commands:

| Command | Purpose |
| --- | --- |
| `/help` | Show all commands |
| `/status` | Show project, session, backend, model, and task status |
| `/sessions` | Pinned, project folders with sessions (including empty folders), then others; 50 items per page |
| `/sessions size 50` | Set page size (5-50, saved per conversation and user) |
| `/sessions detail R1` | Read title, host, workspace and ID without switching |
| `/sessions more` | Next page (prev for previous, page 3 to jump) |
| `/sessions search words` | Search titles, content, directories or IDs |
| `/sessions unbound` | Only sessions without a project |
| `/sessions project` | Only current-project sessions |
| `/session R1` | Bind and resume a session |
| `/session THREAD_ID` | Bind directly (append --host HOST_ID for remote) |
| `/project` | Optional project view; selection binds and switches |
| `/project C1` | Select a discovered project (old add C1 still works) |
| `/project P1` | Switch to a bound project |
| `/new` | Create a session in the current project |
| `/new P2` | Create and switch in a selected project (also C codes or full names) |
| `/new --standalone` | Create an independent session on the selected device; check the source first |
| `/session new ...` | Alias for /new ... |
| `/model` | Inspect or switch model |
| `/effort` | Inspect or switch reasoning effort |
| `/stream` | Configure process progress |
| `/stop` | Interrupt the current task |
| `/connect` | Show your authorized devices in this chat, selection and connection status |
| `/connect use C2` | Save the current Connector for /sessions and /project without changing the conversation binding |
| `/connect use local` | Select the administrator-configured logical local Connector; requires existing admission and rejects an absent route |
| `/sessions all` | Explicitly list all accessible sources; `--host ID` is a temporary filter |
| `/access` | Show personal/current-chat admission |
| `/ide` | Open the current project IDE if enabled |
| `/unbind` | Unbind this chat without stopping the task |

Model, reasoning effort and Plan controls update the bound native Codex thread. Gateway does not persist execution overrides or reapply old choices on continuation/restart. Later changes in Codex App remain authoritative. Legacy `/model default` and `/effort default` only refresh native settings; progress preferences, bindings and forwarding receipts stay Gateway-owned.

DingTalk quoted text and downloadable attachments are separate reference material; quoted slash commands do not execute as current Gateway controls. The adapter supports text, rich text, and visible card text. An unreadable quote is reported without assuming the provider omitted its body. The local reference cache is not a complete chat history, and automatic retrieval of original messages is not implemented. Manual history lookup through another authorized interface is a separate capability.

Messages and attachments use the current conversation binding; changing the `/connect` catalog selection alone does not change that target. Gateway downloads and validates attachments, then Connector stages them on the session's actual host, including same-machine deployments. Plain text never enters file staging. An attachment-preparation notice saying the input was not submitted is separate from the original task's outcome; inspect `/inbox` for saved records and available actions. Old inputs are not automatically replayed.

Remote projects reuse the registered `hostId` and SSH configuration on the Connector machine. Gateway never stores SSH passwords or private-key contents. See the [channel project workbench](./docs/channel-project-modes.md) for projects, modes, and Taskboard interaction.

Session lists also hide explicitly classified probe records and report the hidden count. Normal conversations are never filtered merely for a `READY` title or CLI source, and no records are deleted or archived. See [session-purpose filtering and restoration](./docs/codex-backends.md#probe-records-versus-user-conversations).

## Codex backends

Every Gateway execution path uses a Connector, including work on the same machine. Gateway does not start Codex or fall back to local/SSH execution. Configure `CODEX_IM_GATEWAY_PEER_CONFIG` and supervise Gateway and Connector separately. Each Connector can carry multiple authorized native hosts, so it need not be installed on every reachable remote host. Existing bindings can retain their logical host IDs through explicit deployment routes; see [migration and invariants](./docs/architecture/connector-only-execution.md) and [host routing](./docs/architecture/connector-host-routing.md).

Gateway implements one standard App Server interface for project, session, execution, history, approval, queue, goal and status operations. Desktop and CLI-only deployments differ only in connection and service deployment. GUI installation is not required on a CLI-only host.

The configured host and transport select one native core. Shared daemon readers and execution connections attach to that same core. A connection failure does not fall back to exec or private Desktop IPC, and accepted or uncertain inputs are never replayed. Old auto/exec configuration values migrate to app-server; native sandbox and reviewer policies are inherited.

A Desktop client still using private stdio must reconnect to the shared service while its work is idle. Restarting Gateway cannot merge existing cores. Explicit private stdio uses the same protocol but is Connector-owned: restarting that Connector can stop its private core; restarting Gateway only disconnects observation. See [Codex backend architecture](./docs/codex-backends.md).

The Taskboard AI panel and issue automation also use this native adapter. Embedded services borrow Gateway's instance; standalone services load the root build and use the configured native connection, without a CLI `exec` fallback. Closing observation does not interrupt work accepted by an independent core; explicitly selected private stdio still has a host-owned lifecycle. See [Taskboard native execution](./docs/architecture/modules/taskboard-native-execution.md) and the [remaining verification boundaries](./docs/architecture/remaining-work.md).

Lists preserve native pin order, then native project order, then other sessions. Groups use native manual or activity order. Page numbers remain stable until refresh/search or a 15-minute expiry. App includes sessions from known remote hosts, with explicit partial-results warnings for unavailable hosts. Archived, internal child and unavailable sessions are excluded.

Old App conversations whose native project membership has not yet synchronized can retain their current explicitly registered and published App display group. Details distinguish display grouping from native membership. This does not grant project IDE access, change membership, or restore a conversation explicitly removed from its project.

After a cold Codex server restart, Connector restores permissions from that thread's latest complete native record, including networking, extra writable roots, temporary-directory rules, and named permission profiles. Loaded threads keep their current native settings. Unverifiable evidence fails before submitting input rather than replaying older broader permissions. Device-side fixes require restarting Connector; restarting Gateway alone does not update it.

## Long tasks, progress, and session lifecycle

- Work accepted by an independent native core continues through a Gateway observation disconnect; inputs are not replayed and task lifetime does not depend on activity renewal. Private stdio has a host-owned lifecycle and does not provide the independent core's restart guarantee.
- The gateway shows readable Codex reasoning summaries, commentary, tool/command/file state, and recent results. Hidden raw reasoning is never forwarded.
- Phase entries preserve bullets, tool/thought icons, and multiline indentation. Once native execution ends, a result still awaiting delivery is shown separately with no stop control and with the IDE link retained; unrelated historical receipts cannot block an exactly acknowledged current result.
- Running AI cards retain commentary in phase order, while tool activity and public summaries use a bounded live window. A phase ends with a brief activity summary. At the card length budget, a new card continues the same task with copy controls and the project IDE link. Session recovery to idle does not mark a failed task as completed.
- During an active turn, ordinary IM messages follow the saved policy (steer by default); explicit queue uses the native backend queue. Web submissions retain single-writer validation. Unsupported operations are rejected explicitly.
- Active, running, archived, missing, and system-error session states pass through the backend lifecycle contract. Archived sessions are omitted from the resumable list and return a clear error when addressed.
- Native progress cards update in place. Failures retain the original handle and delivery evidence, without automatically creating replacement cards or text. Text-only progress uses merged updates. Card or text delivery is selected from the channel's capabilities before sending; a card rejection does not trigger a second delivery route.

## Codex Desktop integration

After building and starting the gateway, run this command from the repository root:

```bash
npm run taskboard:codex
```

It launches Codex with local debugging flags and adds **Channel Configuration** and **Taskboard** entries to the native sidebar. It does not modify Codex application files. Keep the launcher terminal running while using the integration. See the [embedded Taskboard guide](./docs/taskboard-module.md) for installation, data, and rollback details.

## Local data and migration

New installations default to:

Paths under `~/.codex-im-gateway/`:

| Path | Contents |
| --- | --- |
| `accounts/` | Channel credentials |
| `runtime/<account-id>/` | Authorization, projects, sessions, handoff state |
| `inbound/<account-id>/` | Inbound attachments |
| `config.json` | Codex, backend, and workspace configuration |
| `logs/` | Local service logs |
| `taskboard/` | Embedded Taskboard data |

Long-term memory is managed by Codex. Gateway does not store or inject personal memories; `/memory` and its aliases have been removed. Attachment delivery and explicitly configured llm-wiki knowledge bases remain available.

If the canonical directory does not exist, the gateway reuses an existing `~/.codex-channel-bridge/` or `~/.codex-weixin/` installation automatically. Legacy `CODEX_CHANNEL_BRIDGE_*`, `CODEX_WEIXIN_*`, request headers, and action blocks remain accepted compatibility interfaces.

Never commit or share the state directory. The management API redacts channel secrets, tokens, and webhook URLs.

Startup overrides:

| Variable | Example |
| --- | --- |
| `CODEX_IM_GATEWAY_PORT` | 8787 |
| `CODEX_IM_GATEWAY_STATE_DIR` | /absolute/private/path |
| `CODEX_IM_GATEWAY_OPEN` | 0 |

## Security boundaries

- The administration service binds to loopback and validates Host, Origin, and an in-memory request token. Separately enabled Connector and IDE endpoints must not expose the whole management API.
- Device authentication, IM admission, chat roles, and browser IDE authorization are separate checks. Pairing does not grant management access; a group binding does not share device permissions.
- Channel credentials never reach the management page. Unknown senders and conversations are denied by default.
- Projects come from backend discovery and cannot be injected as arbitrary paths from chat.
- Approval IDs retain the channel account, conversation and exact native request. An owned local notice selects denial on timeout or failed delivery under its existing policy, then awaits native resolution. A missing local route never answers another client’s request. An uncertain submitted decision is never replayed.
- `danger-full-access` bypasses the Codex filesystem sandbox and should be enabled only after accepting full-machine access risk.
- Concurrent accounts share local compute resources and Codex quotas.

## Documentation

- [Connector setup and remote device pairing](./docs/gateway-peers.md)
- [Tantan Connector and user tutorial (Chinese)](./docs/tantan-connector-guide.md)
- [Web IDE access modes and multi-user limitations](./docs/web-ide.md)
- [Architecture and module documentation](./docs/architecture/README.md)
- [Requirements and case coverage](./docs/architecture/gateway-case-coverage.md)
- [Channel and task-notification setup](./docs/channel-setup.md)
- [Codex backend architecture](./docs/codex-backends.md)
- [Unified IM channel interface and capability matrix](./docs/im-channel-architecture.md)
- [Channel projects, modes, and Taskboard workbench](./docs/channel-project-modes.md)
- [Embedded Taskboard installation, migration, and rollback](./docs/taskboard-module.md)
- [Local operation and updates](./docs/local-run.md)
- [Changelog](./CHANGELOG.md)

## Development and verification

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

## Origin and license

Project lineage:

XavierJiezou/codex-weixin → lsiten/codex-channel-bridge → yanjijinxiao/codex-im-gateway

Existing copyright notices and the [MIT License](./LICENSE) are preserved. See [NOTICE](./NOTICE) for attribution. The WeChat iLink integration shape references the MIT-licensed `Tencent/openclaw-weixin`; no AGPL source code was copied.

This is an unofficial community project and is not affiliated with or endorsed by OpenAI, Tencent, WeCom, ByteDance, Feishu, Alibaba, DingTalk, or the upstream maintainers.

## Versions and releases

Gateway, Connector, `--version`, and runtime productVersion use the root package.json version. The Git tag is v plus that same version. Protocol and log compatibility versions remain independent. Devices can upgrade separately: an online Connector is not proof of an updated build. See [npm release instructions](./docs/npm-release.md). Existing CODEX_IM_GATEWAY_* variables, private state paths, and device identities remain compatible; renaming does not require pairing again.
