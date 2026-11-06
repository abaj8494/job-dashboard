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
const feed = require("../scripts/lib/jobs-feed");
const { unclassifiedQuery } = require("../scripts/jobsync-mail-classify");

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

describe("jobs feed", () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-feed-"));
    file = path.join(dir, "jobs-feed.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("ids are stable per Message-ID, with or without angle brackets", () => {
    expect(feed.feedIdFor("<a@b>")).toBe(feed.feedIdFor("a@b"));
    expect(feed.feedIdFor("a@b")).not.toBe(feed.feedIdFor("c@d"));
    expect(feed.feedIdFor("a@b")).toMatch(/^mail-[0-9a-f]{16}$/);
  });

  test("feedItem uses the local mail date and defaults advertised to true", () => {
    const item = feed.feedItem(mail(), { company: "Acme", jobTitle: "Analyst", location: null, advertised: null });
    expect(item).toMatchObject({ title: "Analyst", company: "Acme", location: "", advertised: true });
    expect(item.date).toBe(feed.localDate(new Date("2026-11-02T23:30:00Z")));
    expect(feed.feedItem(mail(), { company: null, jobTitle: null })).toBeNull();
  });

  test("adding the same message twice makes one job; remove takes it out", () => {
    const item = feed.feedItem(mail(), { company: "Acme", jobTitle: "Analyst" });
    expect(feed.addToFeed([item], file)).toBe(1);
    expect(feed.addToFeed([item], file)).toBe(0);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.jobs).toHaveLength(1);
    expect(feed.removeFromFeed("<abc123@mail.example>", file)).toBe(1);
    expect(feed.loadFeed(file).jobs).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual(["jobs-feed.json"]);
  });

  test("a missing feed is empty; a corrupt feed is an error, not silently replaced", () => {
    expect(feed.loadFeed(file).jobs).toEqual([]);
    fs.writeFileSync(file, "{oops");
    expect(() => feed.addToFeed([feed.feedItem(mail(), { company: "A", jobTitle: "B" })], file)).toThrow(/cannot read feed/);
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
});
