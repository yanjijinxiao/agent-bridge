# Connector connection and native host routing

The Connector transports the existing Codex backend contract. It does not own a
second project/session implementation. One authenticated Connector profile may
reach local and registered remote native hosts through the existing backend.

## Invariants

- The connection identity (device/profile) and execution identity (native host)
  are different. Selection lists devices; catalogs expand the selected device's
  explicitly exported hosts. Session bindings retain the exact host and thread.
- Every backend method uses the same host binding adapter. New facade methods
  must declare how they carry host identity; a compile-time exhaustive contract
  prevents an accidentally local default.
- Host channels multiplex one authenticated socket. Only exported channels have
  handlers. A channel cannot select arbitrary SSH destinations or another host.
- Managed migration aliases retain existing logical host IDs and grant IDs.
  Several aliases may use one device. Personal/fixed-thread grants remain scoped;
  connecting a device does not grant unrelated participants access.
- Receipts, recovery journals, interaction leases and file leases are separated
  by target host. Disconnect never resubmits input or changes executors.
- Files, workspace validation and IDE run on the execution host, using existing
  host transports. A remote directory is never checked against the Connector's
  local filesystem. Missing/offline hosts produce partial-catalog warnings.
- Desktop registration is discovery metadata. Native project/thread lists are
  queried on each corresponding host; registration is not fabricated as a native
  project or used to infer project identity from its display name.

## Regression acceptance

One Mac Connector must list local and remote projects, including empty projects;
same thread/project names on different hosts must remain distinct. History,
creation, lifecycle, queues, approvals, receipt recovery, attachments and IDE
must retain the selected host. Unknown channels, wrong grants and stale
connections must fail closed. Legacy single-host peers must still work.

The deployment test keeps the Linux Connector disabled and existing native Codex
processes alive. Binding IDs, grants and fixed IDE workspace identities must be
compared before and after deployment. Test evidence is recorded separately;
this design document alone is not evidence of completed validation.
