# Local Grist deployment

This deployment runs the fully open-source Grist Community image independently
from Workbench. A localhost-only gateway makes Workbench the account source;
Grist never receives or stores Workbench passwords. Documents and Grist's own
authorization data remain under the ignored `storage/grist/` directory.

```sh
./deploy/grist-local.sh start
./deploy/grist-local.sh status
./deploy/grist-local.sh logs
./deploy/grist-local.sh gateway-logs
./deploy/grist-local.sh stop
```

`./deploy/grist-local.sh gateway` runs only the gateway in the foreground for
debugging or supervision.

Provision the empty personal workspace for the current Workbench account and
create the requirement-pool document with:

```sh
node --no-warnings=ExperimentalWarning ./deploy/grist-provision-requirement-pool.mjs
```

When Workbench contains multiple accounts, set `GRIST_OWNER_EMAIL` explicitly.
The command is idempotent and backs up `home.sqlite3` before changing ownership.
It creates an empty `需求池` document with a `需求列表` view and automatic
`REQ-0001` identifiers, workflow status and priority choices, ownership,
release, scoring, source, date, link, and tag fields. Runtime document metadata
is written to the ignored `storage/grist/requirement-pool.json` file.

Use `./deploy/grist-local.sh recreate` after changing `storage/grist/grist.env`.
This replaces the container without deleting persisted documents.

Workbench must be running at `http://localhost:3000` before a user can sign in.
Set `WORKBENCH_ORIGIN` when starting the script if Workbench uses another
origin. Grist is exposed through the gateway at `http://localhost:8484`; its
raw container port is `127.0.0.1:8485` and must not be exposed to other hosts.

The gateway checks the browser's Workbench session and passes only the verified
email address to Grist's forward-auth endpoint. It strips every caller-supplied
identity header. Signing out of Grist also signs out of Workbench. Grist's
language directory contains only English and Simplified Chinese, with Simplified
Chinese as the default. On every start, the deployment merges the tracked
Simplified Chinese overrides and verifies that no client entry falls back to
English.

This local HTTP profile must remain bound to `127.0.0.1`. Before exposing it to
a LAN or public network, use HTTPS for both origins and run the gateway under a
real process supervisor or container orchestrator. Later project membership and
document provisioning should use the Grist REST API rather than sharing either
application's database.

The image is pinned by repository digest. Upgrade it deliberately after checking
the Grist release notes and backing up `storage/grist/persist/`.
