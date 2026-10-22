/**
 * Uptime Kuma monitor history — the last N heartbeats of one monitor, read
 * from Kuma's SQLite database over SSH, read-only.
 *
 * Kuma has no REST endpoint for heartbeat history. The two ways in are:
 *
 * 1. **The socket.io API the web UI uses.** It needs the instance's login,
 *    and Kuma has exactly one kind of user: an administrator. Any credential
 *    that can read history can also delete monitors, change notifiers and
 *    read their secrets. The API is internal and undocumented, its event
 *    shapes changed between 1.x and 2.x, and an account with 2FA cannot log
 *    in unattended at all.
 *
 * 2. **The SQLite database** (`kuma.db`), which is what this model reads. It
 *    needs SSH to the host and nothing from Kuma, and the read-only property
 *    is enforced by SQLite itself rather than by the caller's good behaviour:
 *    the database is opened with `mode=ro` and `PRAGMA query_only=ON`, so a
 *    write fails inside the engine even if the query were wrong. The `heartbeat`
 *    and `monitor` tables have kept their core columns from 1.x into 2.x.
 *
 * What it will not return: `kuma.db` also holds the notifier configurations
 * (webhook URLs, bot tokens), the user's password hash and 2FA secret, and API
 * keys. This model selects named columns from two tables only. From `monitor`
 * it returns id, name, type, active and interval, never `url`, `hostname`
 * or headers, which can carry basic-auth credentials or tokens. From
 * `heartbeat` it never returns `response`, which Kuma 2.x can fill with an
 * HTTP response body. The database file is never copied off the host.
 *
 * The query runs as a small Python script sent over SSH stdin, using the
 * host's `python3` and its built-in `sqlite3` module, so the host needs no
 * `sqlite3` CLI and the container is never entered with `docker exec`.
 * Parameters travel as one JSON literal inside the script; the remote command
 * line is fixed, so no caller-supplied value reaches a shell.
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Pure helpers. Exported for tests: none of them touch the network or a host.
// ---------------------------------------------------------------------------

/** Kuma's heartbeat status codes. */
export const STATUS_NAMES: Record<number, string> = {
  0: "down",
  1: "up",
  2: "pending",
  3: "maintenance",
};

export function statusName(code: unknown): string {
  return typeof code === "number" && code in STATUS_NAMES
    ? STATUS_NAMES[code]
    : "unknown";
}

/**
 * Kuma stores times as UTC strings without a zone, `2026-01-02 03:04:05.678`.
 * Return ISO-8601 with a `Z`, or the input unchanged if it does not look like
 * one (never throws: an odd row must not sink the read).
 */
export function kumaTimeToIso(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const m = raw.trim().match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/,
  );
  if (!m) return raw;
  const frac = m[3] ? m[3].slice(0, 4) : "";
  return `${m[1]}T${m[2]}${frac}Z`;
}

/** Heartbeat columns this model may read, in output order. Never `response`. */
export const HEARTBEAT_COLUMNS = [
  "status",
  "time",
  "msg",
  "ping",
  "duration",
  "important",
  "retries",
  "down_count",
  "end_time",
] as const;

/** Monitor columns this model may read. Never `url`, `hostname` or headers. */
export const MONITOR_COLUMNS = [
  "id",
  "name",
  "type",
  "active",
  "interval",
] as const;

/** What the remote script is asked to do. */
export interface QueryParams {
  db: string;
  id: number | null;
  name: string | null;
  limit: number;
  importantOnly: boolean;
  msgMax: number;
}

/**
 * The Python program sent over SSH stdin. Parameters are embedded as a JSON
 * string literal (double-encoded, so it is both valid JSON and a valid Python
 * string literal) and parsed with json.loads; nothing is interpolated into SQL.
 */
export function buildScript(p: QueryParams): string {
  const literal = JSON.stringify(JSON.stringify(p));
  const hbCols = JSON.stringify([...HEARTBEAT_COLUMNS]);
  const monCols = JSON.stringify([...MONITOR_COLUMNS]);
  return `import json, os, pathlib, sqlite3, sys
P = json.loads(${literal})
HB = ${hbCols}
MON = ${monCols}
def out(o, code=0):
    sys.stdout.write(json.dumps(o))
    sys.exit(code)
path = pathlib.Path(os.path.expanduser(P["db"]))
if not path.is_file():
    out({"error": "database not found", "db": str(path)}, 2)
con = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
con.execute("PRAGMA query_only=ON")
def cols(table, wanted):
    have = {r[1] for r in con.execute("PRAGMA table_info(" + table + ")")}
    return [c for c in wanted if c in have]
mcols = cols("monitor", MON)
sel = ", ".join('"' + c + '"' for c in mcols)
if P["id"] is not None:
    rows = con.execute("SELECT " + sel + " FROM monitor WHERE id = ?", (P["id"],)).fetchall()
else:
    rows = con.execute("SELECT " + sel + " FROM monitor WHERE name = ?", (P["name"],)).fetchall()
    if not rows:
        rows = con.execute("SELECT " + sel + " FROM monitor WHERE lower(name) LIKE '%' || lower(?) || '%' ORDER BY id", (P["name"],)).fetchall()
if not rows:
    out({"error": "no such monitor", "id": P["id"], "name": P["name"]}, 3)
if len(rows) > 1:
    out({"error": "monitor name is ambiguous", "candidates": [dict(zip(mcols, r)) for r in rows][:20]}, 4)
monitor = dict(zip(mcols, rows[0]))
hcols = cols("heartbeat", HB)
hsel = ", ".join('"' + c + '"' for c in hcols)
where = "monitor_id = ?" + (" AND important = 1" if P["importantOnly"] else "")
beats = []
for r in con.execute("SELECT " + hsel + " FROM heartbeat WHERE " + where + " ORDER BY time DESC LIMIT ?", (monitor["id"], P["limit"])):
    b = dict(zip(hcols, r))
    if isinstance(b.get("msg"), str) and len(b["msg"]) > P["msgMax"]:
        b["msg"] = b["msg"][: P["msgMax"]] + "..."
    beats.append(b)
total = con.execute("SELECT count(*) FROM heartbeat WHERE monitor_id = ?", (monitor["id"],)).fetchone()[0]
out({"monitor": monitor, "heartbeats": beats, "storedHeartbeats": total, "sqlite": sqlite3.sqlite_version})
`;
}

/** One heartbeat, as this model reports it. */
export interface Heartbeat {
  status: string;
  statusCode: number | null;
  time: string;
  msg: string;
  pingMs: number | null;
  important: boolean;
  retries: number | null;
  downCount: number | null;
  endTime: string | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Normalise one raw heartbeat row from the script. */
export function normaliseBeat(raw: Record<string, unknown>): Heartbeat {
  const code = num(raw.status);
  return {
    status: statusName(code),
    statusCode: code,
    time: kumaTimeToIso(raw.time),
    msg: typeof raw.msg === "string" ? raw.msg : "",
    pingMs: num(raw.ping),
    important: raw.important === 1 || raw.important === true,
    retries: num(raw.retries),
    downCount: num(raw.down_count),
    endTime: raw.end_time == null ? null : kumaTimeToIso(raw.end_time),
  };
}

/**
 * Summarise heartbeats (newest first): counts by status, and when the current
 * status began within the window, which is the "since when" a triager wants.
 */
export function summarise(beats: Heartbeat[]) {
  const counts: Record<string, number> = {};
  for (const b of beats) counts[b.status] = (counts[b.status] ?? 0) + 1;
  const current = beats[0]?.status ?? null;
  let run = 0;
  while (run < beats.length && beats[run].status === current) run++;
  let transitions = 0;
  for (let i = 1; i < beats.length; i++) {
    if (beats[i].status !== beats[i - 1].status) transitions++;
  }
  return {
    current,
    // The oldest beat of the unbroken run at the head of the window. If the
    // whole window is one status, the run may have begun earlier still.
    currentSince: run > 0 ? beats[run - 1].time : null,
    currentSinceIsWindowStart: beats.length > 0 && run === beats.length,
    transitions,
    counts,
  };
}

/** Build the argument list for an SSH invocation. Host key checking stays on. */
export function sshArgs(
  host: string,
  user: string,
  command: string,
  opts: { strictHostKeyChecking?: string; knownHostsFile?: string } = {},
): string[] {
  const args = [
    "-o",
    `StrictHostKeyChecking=${opts.strictHostKeyChecking ?? "accept-new"}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
  ];
  if (opts.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${opts.knownHostsFile}`);
  }
  args.push(`${user}@${host}`, command);
  return args;
}

/** Validate method arguments; returns an error string or null. */
export function validateSelector(
  id: number | undefined,
  name: string | undefined,
): string | null {
  const hasId = id !== undefined;
  const hasName = name !== undefined && name.trim() !== "";
  if (hasId === hasName) return "pass exactly one of `id` or `name`";
  return null;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Host and user reach ssh as one `user@host` argument. Refusing a leading `-`
 * and anything but plain name characters keeps either from being read as an
 * ssh option such as `-oProxyCommand=...`.
 */
export const SSH_HOST_RE = /^[A-Za-z0-9\[][A-Za-z0-9.:\[\]_-]*$/;
export const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const GlobalArgsSchema = z.object({
  sshHost: z.string().regex(SSH_HOST_RE, "not a plain hostname or IP").describe(
    "Host that holds the Kuma data directory.",
  ),
  sshUser: z.string().regex(SSH_USER_RE, "not a plain user name").default(
    "root",
  ).describe(
    "SSH user. Needs read access to the database file, nothing more.",
  ),
  dbPath: z.string().describe(
    "Path to kuma.db ON THE HOST (the bind-mounted data directory), not the path inside the container. `~` is expanded.",
  ),
  python: z.string().regex(/^[\w./-]+$/).default("python3").describe(
    "Python interpreter on the host. Its stdlib sqlite3 module is used.",
  ),
  strictHostKeyChecking: z.enum(["yes", "accept-new", "no"]).default(
    "accept-new",
  ).describe("OpenSSH StrictHostKeyChecking. `no` is never the default."),
  knownHostsFile: z.string().optional().describe(
    "Optional UserKnownHostsFile override.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const HeartbeatSchema = z.object({
  status: z.string(),
  statusCode: z.number().nullable(),
  time: z.string(),
  msg: z.string(),
  pingMs: z.number().nullable(),
  important: z.boolean(),
  retries: z.number().nullable(),
  downCount: z.number().nullable(),
  endTime: z.string().nullable(),
});

const HistorySchema = z.object({
  monitor: z.object({
    id: z.number(),
    name: z.string(),
    type: z.string().nullable(),
    active: z.boolean(),
    interval: z.number().nullable(),
  }),
  limit: z.number(),
  importantOnly: z.boolean(),
  returned: z.number(),
  storedHeartbeats: z.number(),
  summary: z.object({
    current: z.string().nullable(),
    currentSince: z.string().nullable(),
    currentSinceIsWindowStart: z.boolean(),
    transitions: z.number(),
    counts: z.record(z.string(), z.number()),
  }),
  heartbeats: z.array(HeartbeatSchema),
  timestamp: z.string(),
});

interface Context {
  globalArgs: GlobalArgs;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  writeResource: (
    resource: string,
    instance: string,
    attributes: unknown,
  ) => Promise<unknown>;
}

interface MonitorArgs {
  id?: number;
  name?: string;
  limit: number;
  importantOnly: boolean;
}

/**
 * The `@sntxrr/uptime-kuma/db` model: read-only monitor history from one
 * Uptime Kuma instance's SQLite database.
 */
export const model = {
  type: "@sntxrr/uptime-kuma/db",
  description:
    "Read-only Uptime Kuma monitor history: the last N heartbeats of one monitor (status, time, message, ping), read from kuma.db over SSH with the database opened mode=ro and query_only. Needs no Kuma login. Never returns notifier settings, credentials, monitor URLs or response bodies. Has no write method.",
  version: "2026.10.22.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    history: {
      description:
        "The newest heartbeats of one monitor (instance `monitor-<id>`), with a summary: current status, since when, and status transitions in the window.",
      schema: HistorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    monitor: {
      description:
        "Read-only. Last `limit` heartbeats of one monitor, by `id` or `name` (exact, else a unique case-insensitive substring). `importantOnly: true` returns state changes only. Returns status, time (UTC ISO), message and ping per beat.",
      arguments: z.object({
        id: z.number().int().positive().optional().describe("Monitor id."),
        name: z.string().max(200).optional().describe(
          "Monitor name: exact match first, else a unique case-insensitive substring.",
        ),
        limit: z.number().int().min(1).max(500).default(20).describe(
          "How many heartbeats, newest first.",
        ),
        importantOnly: z.boolean().default(false).describe(
          "Only beats Kuma marked important, i.e. status changes.",
        ),
      }),
      execute: async (args: MonitorArgs, context: Context) => {
        const g = context.globalArgs;
        const problem = validateSelector(args.id, args.name);
        if (problem) throw new Error(problem);

        const script = buildScript({
          db: g.dbPath,
          id: args.id ?? null,
          name: args.id === undefined ? (args.name ?? "").trim() : null,
          limit: args.limit,
          importantOnly: args.importantOnly,
          msgMax: 500,
        });
        // @ts-ignore - Deno is provided by the swamp extension runtime
        const proc = new Deno.Command("ssh", {
          args: sshArgs(g.sshHost, g.sshUser, `${g.python} -`, {
            strictHostKeyChecking: g.strictHostKeyChecking,
            knownHostsFile: g.knownHostsFile,
          }),
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const child = proc.spawn();
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(script));
        await writer.close();
        const out = await child.output();
        const stdout = new TextDecoder().decode(out.stdout).trim();
        const stderr = new TextDecoder().decode(out.stderr).trim();

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = stdout ? JSON.parse(stdout) : null;
        } catch {
          parsed = null;
        }
        if (out.code !== 0 || !parsed || "error" in parsed) {
          const detail = parsed && "error" in parsed
            ? JSON.stringify(parsed)
            : stderr.slice(-400) || "(no output)";
          throw new Error(
            `kuma history read on ${g.sshHost} failed (exit ${out.code}): ${detail}`,
          );
        }

        const mon = parsed.monitor as Record<string, unknown>;
        const beats = (parsed.heartbeats as Record<string, unknown>[]).map(
          normaliseBeat,
        );
        const result = {
          monitor: {
            id: Number(mon.id),
            name: String(mon.name ?? ""),
            type: typeof mon.type === "string" ? mon.type : null,
            active: mon.active === 1 || mon.active === true,
            interval: num(mon.interval),
          },
          limit: args.limit,
          importantOnly: args.importantOnly,
          returned: beats.length,
          storedHeartbeats: Number(parsed.storedHeartbeats ?? 0),
          summary: summarise(beats),
          heartbeats: beats,
          timestamp: new Date().toISOString(),
        };
        context.logger.info(
          "monitor {id} '{name}': {returned} beats, current {current} since {since}",
          {
            id: result.monitor.id,
            name: result.monitor.name,
            returned: result.returned,
            current: result.summary.current,
            since: result.summary.currentSince,
          },
        );
        // One instance per monitor, so asking about monitor B does not replace
        // the record of monitor A that another reader may be relying on.
        await context.writeResource(
          "history",
          `monitor-${result.monitor.id}`,
          result,
        );
        return result;
      },
    },
  },
};
