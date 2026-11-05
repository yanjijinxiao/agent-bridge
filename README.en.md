<h1 align="center">Codex IM Gateway</h1>

<p align="center">
  <img src="src/web/favicon.svg" alt="Codex IM Gateway logo" width="128" height="128" />
</p>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <strong>Use local or remote OpenAI Codex from WeChat, Enterprise WeChat, Feishu, and DingTalk.</strong>
</p>

`codex-im-gateway` forwards messages to Codex on the selected device and returns progress, approvals, and results to the originating chat. Desktop and CLI-only environments use one standard Codex App Server interface, reached locally, over SSH, or through an outbound Connector.

| Execution location | Connection |
| --- | --- |
| Gateway machine | Its configured native App Server |
| Registered SSH host | The existing host identity and SSH configuration |
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
- **Connector devices**: Each device has separate credentials and locally confirms the requesting person and chat. Paired users can select native projects and sessions and exchange attachments through IM.
- **Project and session management**: Discover local and remote projects from Codex Desktop and Codex session data; bind, switch, create, resume, queue, and validate archived or missing sessions.
- **Long-running agent tasks**: Accepted tasks have no fixed overall timeout. Channels receive readable progress, tool state, and elapsed time while the final answer remains intact.
- **Media, approvals, and notifications**: Handle images, voice, video, and files according to channel capabilities. Command, file-change, and permission approvals return to the originating account and conversation.
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
  <img src="docs/images/screenshots/web-session-management.png" alt="Codex IM Gateway Web session management" width="100%" />
</p>

The screenshot is a historical UI example, not current layout or capability verification.

The console adds and controls channels, authorizes senders, binds projects, displays sessions and running tasks, resumes conversations, and configures models, reasoning effort, progress, and completion notifications.

The optional Web IDE runs on the project host. Active AI cards and final replies can show the same fixed project entry. Hosts and access must be explicitly enabled; an unassigned session does not automatically receive a project IDE.

Default browser access reuses personal admission: confirm the browser once, then automatically trust permitted projects. An administrator can instead explicitly enable possession-of-link access: a new browser enters without a confirmation command or DingTalk SSO, and link holders can use files, Git, and the terminal. Access lasts at most 90 days and is not renewed by visits or restarts.

**Link access currently has one authority source per channel account.** That source must have a valid grant for the target Connector. Pairing a new user's device does not automatically enable that user's no-confirmation IDE. Verify each onboarding case; the console is not a multi-user portal and a full IDE is not an operating-system directory sandbox. See [Web IDE](./docs/web-ide.md) and the [current access contract](./docs/architecture/modules/ide-access.md).

## Connect to an existing Gateway

You do not need to deploy another Gateway or register a bot application. Ask its administrator for personal IM admission and enabled device enrollment. Configure the Gateway URL; Connector creates and stores its own identity. Pair once through /connect and local confirmation. No manually distributed device.token is required; existing tokenFile configurations remain compatible.

1. Prepare a working Codex installation, Node.js, and Git on your device. A CLI-only server does not need a desktop GUI.
2. Download the project source and run the install/build commands below in its repository directory, or use a prebuilt Connector supplied by the administrator.
3. Start from the [Connector example](./examples/peer-client.json), fill in the administrator's Gateway URL, and save it outside the repository. New devices omit nodeId and tokenFile: Connector creates and stores its identity. Select one native service explicitly; daemon mode does not switch executors after a disconnect.
4. Start Connector in an interactive terminal. Send its complete `/connect PAIRING_CODE` command to the bot; mention the bot when using a group.
5. Verify the requesting person, chat, and scope in the device terminal, then enter `yes`. Pairing codes last five minutes and are single-use.
6. Select a session from the returned list and use `/status` to check the device and directory. Pair again when moving to another chat.

Install dependencies:

```bash
npm ci
```

Build the Gateway / Connector programs:

```bash
npm run build:bridge
```

Start command template; replace the configuration path with your actual file:

```bash
npm run peer -- --config /absolute/path/peer-client.json
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
- An installed and authenticated Codex CLI

```bash
npm install -g @openai/codex
```

```bash
codex --version
```

### Install and run

The project is distributed as GitHub source and is not published as an npm package.

```bash
git clone https://github.com/yanjijinxiao/codex-im-gateway.git
```

```bash
cd codex-im-gateway
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

The service opens [http://127.0.0.1:8787](http://127.0.0.1:8787) by default. npm only installs locked dependencies and builds the project; it does not globally install or publish the service.

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
| `/connect use local` | Return to the Gateway local catalog; existing admission is required |
| `/sessions all` | Explicitly list all accessible sources; `--host ID` is a temporary filter |
| `/access` | Show personal/current-chat admission |
| `/ide` | Open the current project IDE if enabled |
| `/unbind` | Unbind this chat without stopping the task |

Remote projects reuse the `hostId` stored by Codex Desktop and the local SSH configuration. The gateway never stores SSH passwords or private-key contents. See the [channel project workbench](./docs/channel-project-modes.md) for projects, modes, and Taskboard interaction.

Session lists also hide explicitly classified probe records and report the hidden count. Normal conversations are never filtered merely for a `READY` title or CLI source, and no records are deleted or archived. See [session-purpose filtering and restoration](./docs/codex-backends.md#probe-records-versus-user-conversations).

## Codex backends

Every Gateway execution path now uses a Connector, including work on the same machine. Gateway does not start Codex or fall back to local/SSH execution. Configure `CODEX_IM_GATEWAY_PEER_CONFIG`, run the Connector independently on each execution device, and keep both services supervised separately. Existing bindings can retain their logical host IDs through explicit deployment routes; see [migration and invariants](./docs/architecture/connector-only-execution.md).

Gateway implements one standard App Server interface for project, session, execution, history, approval, queue, goal and status operations. Desktop and CLI-only deployments differ only in connection and service deployment. GUI installation is not required on a CLI-only host.

The configured host and transport select one native core. Shared daemon readers and execution connections attach to that same core. A connection failure does not fall back to exec or private Desktop IPC, and accepted or uncertain inputs are never replayed. Old auto/exec configuration values migrate to app-server; native sandbox and reviewer policies are inherited.

A Desktop client still using private stdio must reconnect to the shared service while its work is idle. Restarting Gateway cannot merge existing cores. Explicit private stdio uses the same protocol but is Connector-owned: restarting that Connector can stop its private core; restarting Gateway only disconnects observation. See [Codex backend architecture](./docs/codex-backends.md).

The Taskboard AI panel and issue automation also use this native adapter. Embedded services borrow Gateway's instance; standalone services load the root build and use the configured native connection, without a CLI `exec` fallback. Closing observation does not interrupt work accepted by an independent core; explicitly selected private stdio still has a host-owned lifecycle. See [Taskboard native execution](./docs/architecture/modules/taskboard-native-execution.md) and the [remaining verification boundaries](./docs/architecture/remaining-work.md).

Lists preserve native pin order, then native project order, then other sessions. Groups use native manual or activity order. Page numbers remain stable until refresh/search or a 15-minute expiry. App includes sessions from known remote hosts, with explicit partial-results warnings for unavailable hosts. Archived, internal child and unavailable sessions are excluded.

## Long tasks, progress, and session lifecycle

- Work accepted by an independent native core continues through a Gateway observation disconnect; inputs are not replayed and task lifetime does not depend on activity renewal. Private stdio has a host-owned lifecycle and does not provide the independent core's restart guarantee.
- The gateway shows readable Codex reasoning summaries, commentary, tool/command/file state, and recent results. Hidden raw reasoning is never forwarded.
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

A single Connector profile can route to its local and registered remote native hosts through the existing Codex backend. `/connect` selects the device; `/sessions` and `/project` include its authorized hosts. Session bindings, files and IDE keep their exact target host. See [host routing](docs/architecture/connector-host-routing.md).
