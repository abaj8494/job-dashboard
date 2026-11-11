/**
 * @jest-environment node
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  prefilter,
  redactedExcerpt,
  buildStage1Prompt,
  buildStage2Prompt,
  createMailClassifier,
  EXCERPT_CHARS,
} = require("../scripts/lib/mail-classifier");
const server = require("../scripts/lib/server-sync");
const { unclassifiedQuery, unsentJobQuery } = require("../scripts/jobsync-mail-classify");

const BODY_MARKER = "ZZBODYMARKERZZ";

function mail(overrides = {}) {
  return {
    messageId: "abc123@mail.example",
    from: "talent@acme.com",
    fromName: "Acme Talent",
    to: "owner@example.com",
    subject: "Your application",
    date: new Date("2026-11-02T23:30:00Z"),
    isOutbound: false,
    isList: false,
    textBody: `Hello ${BODY_MARKER}. Call +61 400 123 456 or see https://acme.example/jobs/1 or write to hr@acme.com.\n> quoted old text\nOn Mon, someone wrote:\nolder thread`,
    ...overrides,
  };
}

function runnerFrom(responses) {
  const calls = [];
  const runner = jest.fn(async (params) => {
    calls.push(params);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected call ${calls.length}`);
    if (next.fail) return { ok: false, error: "boom", retryable: false, usage: { cost_usd: 0 } };
    return { ok: true, data: next, usage: { cost_usd: 0.01, duration_ms: 1000, stage: params.stage } };
  });
  return { runner, calls };
}

const s1 = (o) => ({ category: "other", confidence: 0.95, reason: "r", company: null, jobTitle: null, location: null, ...o });
const s2 = (o) => ({ ...s1(o), advertised: null, ...o });

function classifier(responses, extra = {}) {
  const r = runnerFrom(responses);
  const c = createMailClassifier({ runner: r.runner, usageFile: null, retries: 0, threshold: 0.8, ...extra });
  return { c, calls: r.calls };
}

describe("prefilter (stage 0, no Claude)", () => {
  test("tags from earlier hook steps mean other", () => {
    expect(prefilter(mail(), ["inbox", "Finance"])).toMatchObject({ type: "other", source: "tag:Finance" });
  });

  test("transactional sender domains, including subdomains, mean other", () => {
    expect(prefilter(mail({ from: "info@join.netflix.com" }))).toMatchObject({ type: "other", source: "sender-domain" });
    expect(prefilter(mail({ from: "x@notnetflix.com" }))).toBeNull();
  });

  test("outbound mail is never domain-filtered", () => {
    expect(prefilter(mail({ from: "owner@paypal.com", isOutbound: true }))).toBeNull();
  });

  test("job-board confirmation rule marks an application", () => {
    const r = prefilter(mail({ from: "noreply@s.seek.com.au", subject: "Your application was successfully submitted" }));
    expect(r.type).toBe("job_application");
  });
});

describe("privacy of prompts", () => {
  test("stage 1 carries headers only, never body text", () => {
    const p = buildStage1Prompt(mail());
    expect(p).not.toContain(BODY_MARKER);
    expect(p).toContain("Subject: Your application");
    expect(p).toContain("List mail: no");
  });

  test("stage 2 excerpt drops quotes and history, redacts links, addresses and numbers", () => {
    const ex = redactedExcerpt(mail().textBody);
    expect(ex).toContain(BODY_MARKER);
    expect(ex).not.toMatch(/https?:|hr@acme|400 123|quoted old text|older thread/);
    expect(ex).toContain("[link]");
    expect(ex).toContain("[email]");
    expect(ex).toContain("[number]");
  });

  test("stage 2 excerpt is capped", () => {
    expect(redactedExcerpt("word ".repeat(5000)).length).toBeLessThanOrEqual(EXCERPT_CHARS);
    expect(buildStage2Prompt(mail({ textBody: "x".repeat(10000) })).length).toBeLessThan(EXCERPT_CHARS + 2000);
  });
});

describe("staging", () => {
  test("prefiltered mail makes no Claude call", async () => {
    const { c, calls } = classifier([]);
    const r = await c.classify(mail(), { tags: ["alpaca"] });
    expect(r).toMatchObject({ type: "other", stage: 0 });
    expect(calls).toHaveLength(0);
  });

  test("confident stage 1 is final; body never sent", async () => {
    const { c, calls } = classifier([s1({ category: "job_response", confidence: 0.92 })]);
    const r = await c.classify(mail());
    expect(r).toMatchObject({ type: "job_response", stage: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).not.toContain(BODY_MARKER);
  });

  test("unsure stage 1 escalates to the excerpt", async () => {
    const { c, calls } = classifier([s1({ category: "follow_up", confidence: 0.5 }), s2({ category: "interview", confidence: 0.9 })]);
    const r = await c.classify(mail());
    expect(r).toMatchObject({ type: "interview", stage: 2 });
    expect(calls[1].prompt).toContain(BODY_MARKER);
    expect(calls[1].stage).toBe(2);
  });

  test("application with company and title in the headers stays at stage 1", async () => {
    const { c, calls } = classifier([s1({ category: "job_application", confidence: 0.95, company: "Acme", jobTitle: "Analyst", location: "Sydney NSW" })]);
    const r = await c.classify(mail());
    expect(calls).toHaveLength(1);
    expect(r.extractedData).toEqual({ company: "Acme", jobTitle: "Analyst", location: "Sydney NSW", advertised: null });
  });

  test("application missing a title escalates for extraction", async () => {
    const { c, calls } = classifier([
      s1({ category: "job_application", confidence: 0.95, company: "Acme" }),
      s2({ category: "job_application", confidence: 0.95, company: "Acme", jobTitle: "Analyst", advertised: false }),
    ]);
    const r = await c.classify(mail());
    expect(calls).toHaveLength(2);
    expect(r.extractedData).toMatchObject({ company: "Acme", jobTitle: "Analyst", advertised: false });
  });

  test("rule-matched confirmation without details skips stage 1 and keeps the rule's type", async () => {
    const { c, calls } = classifier([s2({ category: "other", confidence: 0.6, company: "Canva", jobTitle: "Data Engineer" })]);
    const r = await c.classify(mail({ from: "noreply@s.seek.com.au", subject: "Your application was successfully submitted", textBody: "thanks" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].stage).toBe(2);
    expect(r).toMatchObject({ type: "job_application", stage: 2 });
    expect(r.extractedData).toMatchObject({ company: "Canva", jobTitle: "Data Engineer" });
  });

  test("other never carries extracted details", async () => {
    const { c } = classifier([s1({ category: "other", confidence: 0.99, company: "Acme" })]);
    const r = await c.classify(mail());
    expect(r.extractedData).toEqual({ company: null, jobTitle: null, location: null, advertised: null });
  });

  test("a failed call returns null (mail left for retry) and the breaker trips", async () => {
    const { c, calls } = classifier([{ fail: true }, { fail: true }], { maxConsecutiveFailures: 2 });
    expect(await c.classify(mail({ messageId: "a" }))).toBeNull();
    expect(await c.classify(mail({ messageId: "b" }))).toBeNull();
    expect(await c.classify(mail({ messageId: "c" }))).toBeNull();
    expect(calls).toHaveLength(2);
    expect(c.totals.tripped).toBe(true);
  });

  test("invalid structured output is a failure", async () => {
    const { c } = classifier([{ category: "nonsense", confidence: 2 }]);
    expect(await c.classify(mail())).toBeNull();
  });
});

describe("server sync", () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-outbox-"));
    file = path.join(dir, "server-outbox.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = (o = {}) => ({ type: "rejection", confidence: 0.9, stage: 1, extractedData: { company: "Acme", jobTitle: "Analyst", location: null, advertised: null }, ...o });

  test("an import carries extracted fields only: no subject, sender or body", () => {
    const imp = server.toImport(mail({ messageId: "<abc@x>" }), result());
    expect(imp).toEqual({
      messageId: "abc@x",
      emailDate: "2026-11-02T23:30:00.000Z",
      classification: "rejection",
      confidence: 0.9,
      isOutbound: false,
      reviewRequired: false,
      extractedData: { company: "Acme", jobTitle: "Analyst", location: null },
      classifier: "claude",
      classificationStage: 1,
    });
    const wire = JSON.stringify(imp);
    for (const leak of [BODY_MARKER, "Your application", "talent@acme.com", "Acme Talent", "owner@example.com"]) expect(wire).not.toContain(leak);
  });

  test("other is never sent; below the threshold asks for review unless the owner set the type", () => {
    expect(server.toImport(mail(), result({ type: "other" }))).toBeNull();
    expect(server.toImport(mail(), result({ confidence: 0.5 }), { threshold: 0.8 }).reviewRequired).toBe(true);
    expect(server.toImport(mail(), result({ confidence: 0.5 }), { threshold: 0.8, ownerSet: true }).reviewRequired).toBe(false);
  });

  test("config: env or ~/.jobsync/config, root or full URL, https only except localhost", () => {
    const cfgFile = path.join(dir, "config");
    const none = path.join(dir, "none");
    fs.writeFileSync(cfgFile, 'export JOBSYNC_API_KEY="k1"\nexport JOBSYNC_API_URL="https://jobs.example/api/email-sync"\n# export JOBSYNC_API_URL="http://localhost:3000"\n');
    expect(server.loadServerConfig({ env: {}, configFile: cfgFile })).toMatchObject({ ok: false, off: true });
    fs.appendFileSync(cfgFile, "export JOBSYNC_SERVER_SYNC=1\n");
    expect(server.loadServerConfig({ env: {}, configFile: cfgFile })).toMatchObject({ ok: true, url: "https://jobs.example/api/email-sync", origin: "https://jobs.example", key: "k1" });
    const on = { JOBSYNC_SERVER_SYNC: "1", JOBSYNC_API_KEY: "k" };
    expect(server.loadServerConfig({ env: { ...on, JOBSYNC_API_URL: "http://localhost:3000" }, configFile: none }).url).toBe("http://localhost:3000/api/email-sync");
    expect(server.loadServerConfig({ env: { ...on, JOBSYNC_API_URL: "http://jobs.example" }, configFile: none }).ok).toBe(false);
    expect(server.loadServerConfig({ env: { JOBSYNC_SERVER_SYNC: "1" }, configFile: none }).ok).toBe(false);
  });

  function fakeServer(handler) {
    const calls = [];
    const fetchImpl = jest.fn(async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method, body, key: init.headers["x-api-key"] });
      const [status, json] = handler({ url, method: init.method, body });
      return { status, ok: status < 400, json: async () => json };
    });
    return { fetchImpl, calls };
  }
  const cfg = { url: "https://jobs.example/api/email-sync", key: "k" };

  test("confirmed imports leave the outbox and are reported; server failures stay queued", async () => {
    server.enqueue("import", "a@x", server.toImport(mail({ messageId: "a@x" }), result()), file);
    server.enqueue("import", "b@x", server.toImport(mail({ messageId: "b@x" }), result()), file);
    server.enqueue("import", "a@x", server.toImport(mail({ messageId: "a@x" }), result({ type: "interview" })), file);
    expect(server.loadOutbox(file).items).toHaveLength(2);

    const { fetchImpl, calls } = fakeServer(() => [200, { processed: 1, filed: 1, pending: 0, failedMessageIds: ["b@x"] }]);
    // The deployed build before auto-filing answers without filed/failedMessageIds: nothing counts as sent.
    const old = fakeServer(() => [200, { processed: 0, skipped: 0, errors: ["subject missing"] }]);
    expect(await server.flush(cfg, { fetchImpl: old.fetchImpl, file })).toMatchObject({ sent: 0, error: "POST 200" });
    expect(server.loadOutbox(file).items).toHaveLength(2);
    const sent = [];
    const r = await server.flush(cfg, { fetchImpl, file, onSent: async (i) => sent.push(i.messageId) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", key: "k" });
    expect(calls[0].body.imports.map((i) => i.classification).sort()).toEqual(["interview", "rejection"]);
    expect(r).toMatchObject({ sent: 1, filed: 1, failed: 1 });
    expect(sent).toEqual(["a@x"]);
    expect(server.loadOutbox(file).items.map((i) => [i.messageId, i.attempts])).toEqual([["b@x", 2]]);
  });

  test("no confirmation (auth error, outage, network) keeps everything", async () => {
    server.enqueue("import", "a@x", server.toImport(mail(), result()), file);
    const down = fakeServer(() => [401, { error: "Unauthorized" }]);
    expect(await server.flush(cfg, { fetchImpl: down.fetchImpl, file })).toMatchObject({ sent: 0, error: "POST 401 Unauthorized" });
    const offline = jest.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    expect(await server.flush(cfg, { fetchImpl: offline, file })).toMatchObject({ sent: 0, error: "ECONNREFUSED" });
    expect(server.loadOutbox(file).items).toHaveLength(1);
  });

  test("a correction is posted and then patched; a delete is sent by messageId", async () => {
    server.enqueue("correct", "c@x", server.toImport(mail({ messageId: "c@x" }), result({ type: "offer" }), { ownerSet: true }), file);
    server.enqueue("delete", "d@x", null, file);
    const { fetchImpl, calls } = fakeServer(({ method }) =>
      method === "POST" ? [200, { processed: 0, filed: 0, pending: 0, failedMessageIds: [] }] : method === "PATCH" ? [200, { updated: 1, filed: 1 }] : [200, { deleted: 0, kept: true }]
    );
    const r = await server.flush(cfg, { fetchImpl, file });
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH", "DELETE"]);
    expect(calls[1].body.updates[0]).toMatchObject({ messageId: "c@x", classification: "offer", reviewRequired: false });
    expect(calls[2].url).toBe("https://jobs.example/api/email-sync?messageId=d%40x");
    expect(r).toMatchObject({ sent: 2, filed: 1, kept: 1 });
    expect(server.loadOutbox(file).items).toEqual([]);
  });

  test("a corrupt outbox is an error, not silently emptied", () => {
    fs.writeFileSync(file, "{oops");
    expect(() => server.enqueue("delete", "x", null, file)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{oops");
  });
});

describe("query", () => {
  test("unclassified query covers monitored addresses, excludes spam/trash and every jobsync tag", () => {
    const q = unclassifiedQuery(["a@x", "b@y"], "2026-10-09");
    expect(q).toContain("date:2026-10-09..");
    expect(q).toContain("(from:a@x OR to:a@x) OR (from:b@y OR to:b@y)");
    expect(q).toContain("NOT tag:spam");
    for (const t of ["job_application", "job_response", "interview", "rejection", "offer", "follow_up", "other"]) {
      expect(q).toContain(`tag:jobsync/${t}`);
    }
  });

  test("refile query finds job mail not yet sent to the server", () => {
    const q = unsentJobQuery(["a@x"], "2026-10-09");
    expect(q).toContain("date:2026-10-09..");
    expect(q).toContain("tag:jobsync/rejection");
    expect(q).not.toContain("tag:jobsync/other");
    expect(q).toContain("NOT tag:jobsync-server");
  });
});
