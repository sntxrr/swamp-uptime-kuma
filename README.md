# swamp-uptime-kuma

A [swamp](https://github.com/systeminit/swamp) extension that reads Uptime Kuma
monitor history read-only: the last N heartbeats of a monitor, from `kuma.db`
over SSH, with no Kuma login and no write path.

**The full documentation, including why it reads SQLite rather than the
socket.io API, is [`extensions/models/README.md`](extensions/models/README.md)**,
which is also what ships with the extension.

## Install

```bash
swamp extension pull @sntxrr/uptime-kuma
```

## Development

```bash
~/.swamp/deno/deno check extensions/models/kuma_history.ts
~/.swamp/deno/deno lint extensions/models/
~/.swamp/deno/deno test -A extensions/models/   # -A runs the SQLite fixture tests
```
