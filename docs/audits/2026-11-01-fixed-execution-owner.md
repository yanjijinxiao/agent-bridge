> Historical review. The desktop/headless routing design below was superseded by the single native App Server adapter; see `2026-11-01-single-app-server.md`.

# Fixed execution owner review

Scope: deployment configuration, both router construction sites, execution and control routing, Desktop local/remote IPC, metadata/history boundaries, native queue admission and result reconciliation, settings assets, documentation and upgrade compatibility.

## Architecture and intent

The previous router used writer-lock rejection and live discovery to select between independent and Desktop runtimes. A disappearing Desktop owner permitted a second native resume. That behavior is retained only for old configurations with no execution selection, not used by either fixed deployment profile.

The new explicit desktop/headless choice fixes execution authority across disconnection and Gateway restart. CLI-only deployments have a complete native App Server implementation and need no desktop application. Desktop-connected remote hosts stay on Desktop's exact host route. No process, native lock, policy, sandbox permission or input is forcibly migrated.

The installed Desktop IPC method/version map was inspected read-only. It exposes existing-thread follower operations and remote host envelopes, not generic app-server RPC, creation or thread loading. The app also contains an opt-in shared-daemon launch condition; enabling that would require changing/relaunching Desktop and is not performed. Unsupported follower operations are disclosed and rejected rather than emulated with a second writer.

## Modules, files and overlooked cases

- Configuration/API/UI: explicit selection, invalid-value rejection, no socket-based auto detection, preserve old installations without silently migrating writers, invalidate observation keys when the selection changes. Fix an inaccurate existing daemon-failure fallback hint.
- Router: local/remote starts, ordinary input, strict steering, guarded stop, capacity continuation and queue consumption obey the selected execution authority. No private goal/lifecycle mutation or ephemeral classifier in Desktop mode. Read-only catalog/history and accepted result evidence remain separate.
- Headless catalog: ignore stale Desktop catalog/project files; use native storage and membership. Do not contact Desktop to refresh after a native start.
- Desktop transport: host-scoped discovery, following, snapshot filters and versioned follower writes. Remote completion uses the same native turn's snapshot. Restart detaches observation without interrupt or replay.
- Queue/restart: external native enqueue-only, no private consumption of a Desktop thread, accepted result reconciliation without requiring the Desktop window to be open. Durable source identity survives disconnection/restart and reaches the recovered owner once.
- Static/config files: update settings fields, submission payload, displayed selection and backend reference docs consistently. Existing access lists, browser grants, project bindings and sandbox defaults are untouched.

## Validation

Tests include real framed Unix IPC for remote host isolation, one acknowledged start, exact result identity, expected-turn interruption envelope, local same-ID rejection and restart detachment. Router tests cover absent owner, transport failure, uncertain submission, forbidden private mutations, explicit headless execution and no exec fallback. A real persisted transport inbox and receipt journal cover Desktop outage, Gateway restart, eventual one-time dispatch and provider redelivery. Configuration tests cover missing/explicit/invalid choices and upgrade preservation. Native catalog tests retain stale Desktop state while asserting headless results/membership do not consume it.

Full-suite and deployment evidence is recorded in the release manifest. Tests verify these contracts; they do not establish unsupported Desktop methods or prove all historical incidents shared one cause.

References: [native App Server](https://learn.chatgpt.com/docs/app-server), [Desktop remote connections](https://learn.chatgpt.com/docs/remote-connections).
