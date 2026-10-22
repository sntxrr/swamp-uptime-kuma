import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  buildScript,
  HEARTBEAT_COLUMNS,
  kumaTimeToIso,
  model,
  MONITOR_COLUMNS,
  normaliseBeat,
  type QueryParams,
  sshArgs,
  statusName,
  summarise,
  validateSelector,
} from "./kuma_history.ts";

const params = (over: Partial<QueryParams> = {}): QueryParams => ({
  db: "/srv/kuma/kuma.db",
  id: 7,
  name: null,
  limit: 10,
  importantOnly: false,
  msgMax: 500,
  ...over,
});

// --- the read-only boundary ------------------------------------------------

Deno.test("the script opens the database read-only with query_only", () => {
  const s = buildScript(params());
  assert(s.includes('"?mode=ro"'));
  assert(s.includes("PRAGMA query_only=ON"));
});

Deno.test("the script contains no write or attach statement", () => {
  const s = buildScript(params()).toUpperCase();
  for (
    const verb of [
      "INSERT",
      "UPDATE ",
      "DELETE",
      "DROP",
      "ATTACH",
      "VACUUM",
      "REPLACE",
    ]
  ) {
    assertFalse(s.includes(verb), verb);
  }
});

Deno.test("secret-bearing columns are never selectable", () => {
  for (const c of ["response"]) {
    assertFalse((HEARTBEAT_COLUMNS as readonly string[]).includes(c));
  }
  for (
    const c of ["url", "hostname", "headers", "basic_auth_pass", "push_token"]
  ) {
    assertFalse((MONITOR_COLUMNS as readonly string[]).includes(c));
  }
});

Deno.test("a hostile name stays inside a string literal", () => {
  const evil = `x"); import os; os.system("touch /tmp/pwn"); ("`;
  const s = buildScript(params({ id: null, name: evil }));
  const line = s.split("\n").find((l) => l.startsWith("P = json.loads("))!;
  // The whole parameter block is one double-encoded JSON literal.
  const literal = line.slice("P = json.loads(".length, -1);
  assertEquals(JSON.parse(JSON.parse(literal)).name, evil);
  assertEquals(s.split("\n").filter((l) => l.includes("os.system")).length, 1);
});

Deno.test("the type exposes exactly one method, monitor", () => {
  assertEquals(Object.keys(model.methods), ["monitor"]);
});

// --- pure helpers ----------------------------------------------------------

Deno.test("statusName maps Kuma's codes", () => {
  assertEquals(
    [0, 1, 2, 3, 9, "1"].map(statusName),
    ["down", "up", "pending", "maintenance", "unknown", "unknown"],
  );
});

Deno.test("kumaTimeToIso converts Kuma's zone-less UTC strings", () => {
  assertEquals(
    kumaTimeToIso("2026-01-02 03:04:05.678"),
    "2026-01-02T03:04:05.678Z",
  );
  assertEquals(kumaTimeToIso("2026-01-02 03:04:05"), "2026-01-02T03:04:05Z");
  assertEquals(kumaTimeToIso("garbage"), "garbage");
  assertEquals(kumaTimeToIso(null), "");
});

Deno.test("validateSelector demands exactly one of id or name", () => {
  assert(validateSelector(undefined, undefined));
  assert(validateSelector(1, "web"));
  assert(validateSelector(undefined, "  "));
  assertEquals(validateSelector(1, undefined), null);
  assertEquals(validateSelector(undefined, "web"), null);
});

Deno.test("normaliseBeat shapes a raw row", () => {
  assertEquals(
    normaliseBeat({
      status: 0,
      time: "2026-01-01 00:00:00.000",
      msg: "timeout",
      ping: null,
      important: 1,
      end_time: null,
    }),
    {
      status: "down",
      statusCode: 0,
      time: "2026-01-01T00:00:00.000Z",
      msg: "timeout",
      pingMs: null,
      important: true,
      retries: null,
      downCount: null,
      endTime: null,
    },
  );
});

Deno.test("summarise finds the current run and counts transitions", () => {
  const b = (status: string, time: string) =>
    normaliseBeat({ status: status === "up" ? 1 : 0, time });
  const beats = [
    b("up", "2026-01-01 00:05:00"),
    b("up", "2026-01-01 00:04:00"),
    b("down", "2026-01-01 00:03:00"),
    b("up", "2026-01-01 00:02:00"),
  ];
  const s = summarise(beats);
  assertEquals(s.current, "up");
  assertEquals(s.currentSince, "2026-01-01T00:04:00Z");
  assertFalse(s.currentSinceIsWindowStart);
  assertEquals(s.transitions, 2);
  assertEquals(s.counts, { up: 3, down: 1 });
  assertEquals(summarise([]).current, null);
  assert(summarise(beats.slice(0, 2)).currentSinceIsWindowStart);
});

Deno.test("sshArgs keeps host key checking on and batch mode set", () => {
  const args = sshArgs("kuma.example", "ops", "python3 -");
  assert(args.includes("StrictHostKeyChecking=accept-new"));
  assert(args.includes("BatchMode=yes"));
  assertEquals(args.slice(-2), ["ops@kuma.example", "python3 -"]);
});

// --- the script against a real SQLite fixture --------------------------------
// Runs the generated Python locally against a throwaway database with Kuma's
// table shapes. Skipped when python3 or the permissions are unavailable.

const canRun = (() => {
  try {
    return Deno.permissions.querySync({ name: "run" }).state === "granted" &&
      Deno.permissions.querySync({ name: "write" }).state === "granted";
  } catch {
    return false;
  }
})();

async function py(script: string): Promise<{ code: number; out: string }> {
  const child = new Deno.Command("python3", {
    args: ["-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(script));
  await w.close();
  const o = await child.output();
  return { code: o.code, out: new TextDecoder().decode(o.stdout) };
}

async function fixture(): Promise<string> {
  const dir = await Deno.makeTempDir();
  const db = `${dir}/kuma.db`;
  const r = await py(`import sqlite3
c = sqlite3.connect(${JSON.stringify(db)})
c.execute("PRAGMA journal_mode=WAL")
c.execute("CREATE TABLE monitor (id INTEGER PRIMARY KEY, name TEXT, type TEXT, active INTEGER, interval INTEGER, url TEXT, basic_auth_pass TEXT)")
c.execute("CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, important INTEGER, monitor_id INTEGER, status INTEGER, msg TEXT, time DATETIME, ping INTEGER, duration INTEGER, response TEXT)")
c.execute("INSERT INTO monitor VALUES (7, 'Web frontend', 'http', 1, 60, 'https://user:SECRETPW@web.example', 'SECRETPW')")
c.execute("INSERT INTO monitor VALUES (8, 'Web backend', 'http', 1, 60, '', '')")
for i in range(30):
    c.execute("INSERT INTO heartbeat (important, monitor_id, status, msg, time, ping, duration, response) VALUES (?,?,?,?,?,?,?,?)",
              (1 if i in (10, 20) else 0, 7, 0 if 10 <= i < 20 else 1, "x" * 600 if i == 29 else "OK", "2026-01-01 00:%02d:00.000" % i, 12, 60, "SECRETBODY"))
c.commit()
`);
  assertEquals(r.code, 0);
  return db;
}

Deno.test({
  name: "the script reads a fixture database and returns no secret",
  ignore: !canRun,
  fn: async () => {
    const db = await fixture();
    const before = (await Deno.stat(db)).mtime?.getTime();
    const r = await py(buildScript(params({ db, id: 7, limit: 10 })));
    assertEquals(r.code, 0);
    const o = JSON.parse(r.out);
    assertEquals(o.monitor, {
      id: 7,
      name: "Web frontend",
      type: "http",
      active: 1,
      interval: 60,
    });
    assertEquals(o.heartbeats.length, 10);
    assertEquals(o.storedHeartbeats, 30);
    assertEquals(o.heartbeats[0].time, "2026-01-01 00:29:00.000");
    assert(
      o.heartbeats[0].msg.endsWith("...") && o.heartbeats[0].msg.length === 503,
    );
    assertFalse(r.out.includes("SECRET"));
    assertEquals((await Deno.stat(db)).mtime?.getTime(), before);
  },
});

Deno.test({
  name: "the script resolves names, refuses ambiguity, and filters important",
  ignore: !canRun,
  fn: async () => {
    const db = await fixture();
    const exact = JSON.parse(
      (await py(buildScript(params({ db, id: null, name: "Web frontend" }))))
        .out,
    );
    assertEquals(exact.monitor.id, 7);
    const sub = JSON.parse(
      (await py(buildScript(params({ db, id: null, name: "FRONT" })))).out,
    );
    assertEquals(sub.monitor.id, 7);
    const amb = await py(buildScript(params({ db, id: null, name: "web" })));
    assertEquals(amb.code, 4);
    assertEquals(JSON.parse(amb.out).candidates.length, 2);
    const none = await py(buildScript(params({ db, id: 99 })));
    assertEquals(none.code, 3);
    const imp = JSON.parse(
      (await py(buildScript(params({ db, importantOnly: true })))).out,
    );
    assertEquals(imp.heartbeats.map((h: { status: number }) => h.status), [
      1,
      0,
    ]);
    const missing = await py(buildScript(params({ db: db + ".nope" })));
    assertEquals(missing.code, 2);
  },
});

Deno.test("ssh host and user refuse anything ssh could read as an option", async () => {
  const { SSH_HOST_RE, SSH_USER_RE } = await import("./kuma_history.ts");
  for (
    const ok of [
      "dockerhost",
      "host.example.com",
      "192.0.2.10",
      "[2001:db8::1]",
    ]
  ) {
    assert(SSH_HOST_RE.test(ok), ok);
  }
  for (const bad of ["-oProxyCommand=sh", "host name", "h;id", ""]) {
    assertFalse(SSH_HOST_RE.test(bad), bad);
  }
  assert(SSH_USER_RE.test("ops"));
  assertFalse(SSH_USER_RE.test("-l"));
  assertFalse(SSH_USER_RE.test("a b"));
});
