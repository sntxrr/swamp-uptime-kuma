# @sntxrr/uptime-kuma

Read-only Uptime Kuma monitor history for triage: the last N heartbeats of one
monitor, with a summary of the current status and since when.

## Why SQLite, not the socket.io API

Kuma has no REST endpoint for heartbeat history. There are two ways in:

| | socket.io (what the web UI uses) | `kuma.db` over SSH (this model) |
|---|---|---|
| credential | the Kuma login, which is always an **administrator** | SSH read access to the data directory |
| what the credential can also do | delete monitors, change notifiers, read their secrets | read the file (its holder could already) |
| read-only enforced by | the caller's code | SQLite: `mode=ro` + `PRAGMA query_only=ON` |
| 2FA on the account | blocks unattended login | not involved |
| API stability | internal, undocumented; event shapes changed 1.x -> 2.x | `heartbeat` / `monitor` core columns stable 1.x -> 2.x |
| works on a MariaDB-backed Kuma 2.x | yes | no |

The SQLite route adds no new credential and cannot write. Its costs are that it
depends on Kuma's schema rather than an API, needs shell access to the host,
and does not work if Kuma 2.x is configured for MariaDB.

## What it never returns

`kuma.db` also holds notifier configurations (webhook URLs, bot tokens), the
user's password hash and 2FA secret, and API keys. The model selects named
columns from two tables only:

- `monitor`: `id`, `name`, `type`, `active`, `interval`. Never `url`,
  `hostname` or headers, which can carry basic-auth credentials or tokens.
- `heartbeat`: `status`, `time`, `msg`, `ping`, `duration`, `important`, and
  where present `retries`, `down_count`, `end_time`. Never `response`, which
  Kuma 2.x can fill with an HTTP response body.

Messages are cut at 500 characters. The database is never copied off the
host, and the container is never entered.

## Method

| method | effect |
|---|---|
| `monitor` | Read-only. Last `limit` (1-500, default 20) heartbeats of one monitor, by `id` or `name`. `importantOnly: true` returns only status changes. |

`name` matches exactly first, then as a unique case-insensitive substring. An
ambiguous name fails and lists the candidates.

## Usage

```bash
swamp extension pull @sntxrr/uptime-kuma
swamp model create @sntxrr/uptime-kuma/db kuma \
  --global-arg sshHost=kuma-host.example.com --global-arg sshUser=ops \
  --global-arg dbPath=/srv/uptime-kuma/data/kuma.db

swamp model method run kuma monitor --input id=16 --input limit=10 --json
# the flap history: state changes only
swamp model method run kuma monitor --input name=frontend --input importantOnly=true --json
```

`dbPath` is the path **on the host** (the bind-mounted data directory), not
`/app/data/kuma.db` inside the container.

## Output

```json
{
  "monitor": { "id": 16, "name": "Web frontend", "type": "http", "active": true, "interval": 60 },
  "returned": 10,
  "storedHeartbeats": 1440,
  "summary": {
    "current": "up",
    "currentSince": "2026-01-01T00:04:00Z",
    "currentSinceIsWindowStart": false,
    "transitions": 2,
    "counts": { "up": 9, "down": 1 }
  },
  "heartbeats": [
    { "status": "up", "statusCode": 1, "time": "2026-01-01T00:05:00Z", "msg": "OK", "pingMs": 12, "important": false }
  ]
}
```

Times are UTC. Status codes: 0 down, 1 up, 2 pending, 3 maintenance.

## Global arguments

| argument | default | meaning |
|---|---|---|
| `sshHost` | (required) | Host holding the Kuma data directory. |
| `sshUser` | `root` | Needs read access to `kuma.db` and its `-wal`/`-shm`. |
| `dbPath` | (required) | Path to `kuma.db` on the host. `~` is expanded. |
| `python` | `python3` | Interpreter on the host; its stdlib `sqlite3` is used. |
| `strictHostKeyChecking` | `accept-new` | `no` is never the default. |
| `knownHostsFile` | (unset) | Optional `UserKnownHostsFile` override. |

## Subprocess

The model spawns one subprocess, `ssh`, with an argument array (no shell).
`sshHost`, `sshUser` and `python` are validated against plain-name patterns,
so none can start with `-` or be read as an ssh option, and
`strictHostKeyChecking` is an enum. The remote command is `<python> -`; the
Python script is fixed in the model and sent over stdin, with `dbPath`, the
monitor selector and the limit passed as JSON-encoded values inside it.

## Requirements

- `ssh` with non-interactive (`BatchMode`) access to the host.
- `python3` on the host (no `sqlite3` CLI needed).
- Kuma on its default SQLite backend.
