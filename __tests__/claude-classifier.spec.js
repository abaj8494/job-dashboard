/**
 * @jest-environment node
 */
const { createClassifier, buildArgs } = require("../scripts/lib/claude-classifier");
const {
  buildSystemPrompt,
  buildStage1Prompt,
  buildStage2Prompt,
  STAGE1_JSON_SCHEMA,
  STAGE2_JSON_SCHEMA,
  SNIPPET_CHARS,
} = require("../scripts/lib/prompts");

const LONG_BODY = "Dear Aayush, " + "we would love to talk about the role. ".repeat(60);

const companyEmail = {
  messageId: "<abc@company.com>",
  subject: "Your application to Acme",
  from: "talent@acme.com",
  fromName: "Acme Talent",
  to: "j@abaj.ai",
  date: new Date("2026-10-01T00:00:00Z"),
  isOutbound: false,
  textBody: LONG_BODY,
};

const seekEmail = {
  messageId: "<seek@seek.com.au>",
  subject: "Your application was successfully submitted",
  from: "noreply@seek.com.au",
  fromName: "SEEK",
  to: "j@abaj.ai",
  date: new Date("2026-10-01T00:00:00Z"),
  isOutbound: false,
  textBody: "Your application for Data Engineer was successfully submitted to Canva.",
};

function fakeRunner(responses) {
  const calls = [];
  const runner = jest.fn(async (params) => {
    calls.push(params);
    const next = responses.shift();
    if (typeof next === "function") return next(params);
    return next;
  });
  runner.calls = calls;
  return runner;
}

// Mirrors the real runner: the usage record carries the stage it was asked for.
const ok = (data, cost = 0.01) => (params) => ({
  ok: true,
  data,
  envelope: {},
  usage: { stage: params.stage, label: params.label, cost_usd: cost, duration_ms: 1000 },
});

describe("prompts", () => {
  test("stage 1 prompt carries metadata and a short snippet, never the full body", () => {
    const p = buildStage1Prompt(companyEmail);
    expect(p).toContain("Subject: Your application to Acme");
    expect(p).toContain("From: Acme Talent <talent@acme.com>");
    expect(p).toContain("RECEIVED");
    expect(p).not.toContain("Body:");
    const snippet = p.split("Snippet: ")[1];
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_CHARS + 1);
    expect(LONG_BODY.length).toBeGreaterThan(SNIPPET_CHARS);
  });

  test("stage 2 prompt carries the body", () => {
    const p = buildStage2Prompt(companyEmail);
    expect(p).toContain("Body:");
    expect(p).toContain(LONG_BODY.substring(0, 500));
  });

  test("system prompt is frozen text plus a deterministic corrections block", () => {
    const corrections = [
      { originalType: "job_response", correctedType: "other", subject: "Newsletter", from: "news@x.com", isOutbound: false },
      { originalType: "job_response", correctedType: "interview", subject: "Chat?", from: "hr@y.com", fromName: "HR", isOutbound: false },
    ];
    const a = buildSystemPrompt(corrections);
    const b = buildSystemPrompt(corrections);
    expect(a).toBe(b);
    expect(a).toContain("was job_response, correct is interview");
    expect(a).toContain("we have received your application");
    expect(buildSystemPrompt([])).not.toContain("Owner corrections");
  });

  test("JSON schemas have no $schema key and constrain the category", () => {
    expect(STAGE1_JSON_SCHEMA.$schema).toBeUndefined();
    expect(STAGE2_JSON_SCHEMA.$schema).toBeUndefined();
    expect(STAGE1_JSON_SCHEMA.properties.category.enum).toContain("job_response");
    expect(STAGE2_JSON_SCHEMA.properties.extractedData.properties.company).toBeDefined();
    expect(STAGE1_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("buildArgs", () => {
  test("headless, tools off, no persistence, budget cap, schema and system prompt", () => {
    const a = buildArgs({
      model: "opus",
      effort: "low",
      maxBudgetUsd: "0.25",
      systemPrompt: "SYS",
      jsonSchema: { type: "object" },
      prompt: "hello",
    });
    expect(a.slice(0, 2)).toEqual(["-p", "hello"]);
    expect(a).toContain("--output-format");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a).toContain("--no-session-persistence");
    expect(a[a.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("0.25");
    expect(a[a.indexOf("--system-prompt") + 1]).toBe("SYS");
    expect(a[a.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
    expect(a[a.indexOf("--effort") + 1]).toBe("low");
  });
});

describe("createClassifier", () => {
  const base = { usageFile: null, retries: 0, retryDelayMs: 0, log: () => {} };

  test("confident 'other' at stage 1 stops without reading the body", async () => {
    const runner = fakeRunner([ok({ category: "other", confidence: 0.97, reason: "job alert" })]);
    const c = createClassifier({ ...base, runner });
    const r = await c.classify(companyEmail);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.calls[0].stage).toBe(1);
    expect(runner.calls[0].effort).toBe("low");
    expect(runner.calls[0].prompt).not.toContain("Body:");
    expect(r).toMatchObject({ type: "other", stage: 1, reviewRequired: false, extractedData: {} });
    expect(c.totals).toMatchObject({ calls: 1, stage1: 1, stage2: 0 });
  });

  test("low stage-1 confidence triggers stage 2 with the body and medium effort", async () => {
    const runner = fakeRunner([
      ok({ category: "job_response", confidence: 0.55, reason: "unsure" }),
      ok({
        category: "interview",
        confidence: 0.93,
        reason: "invites to a call",
        extractedData: { company: "Acme", jobTitle: "Engineer", location: null, applicationUrl: null, recruiterName: "Sam", salaryRange: null, source: null, jobType: null },
      }),
    ]);
    const c = createClassifier({ ...base, runner });
    const r = await c.classify(companyEmail);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.calls[1].stage).toBe(2);
    expect(runner.calls[1].effort).toBe("medium");
    expect(runner.calls[1].prompt).toContain("Body:");
    expect(r.type).toBe("interview");
    expect(r.stage).toBe(2);
    expect(r.reviewRequired).toBe(false);
    expect(r.extractedData).toMatchObject({ company: "Acme", jobTitle: "Engineer", recruiterName: "Sam" });
    expect(r.extractedData.location).toBeUndefined();
    expect(r.stage1.category).toBe("job_response");
  });

  test("still uncertain after stage 2 is flagged reviewRequired", async () => {
    const runner = fakeRunner([
      ok({ category: "follow_up", confidence: 0.5, reason: "?" }),
      ok({ category: "follow_up", confidence: 0.6, reason: "??", extractedData: { company: null, jobTitle: null, location: null, applicationUrl: null, recruiterName: null, salaryRange: null, source: null, jobType: null } }),
    ]);
    const c = createClassifier({ ...base, runner });
    const r = await c.classify(companyEmail);
    expect(r.reviewRequired).toBe(true);
    expect(r.type).toBe("follow_up");
  });

  test("confident job-related mail that rules cannot extract still reads the body for extraction", async () => {
    const runner = fakeRunner([
      ok({ category: "job_response", confidence: 0.95, reason: "ack" }),
      ok({ category: "job_response", confidence: 0.96, reason: "ack", extractedData: { company: "Acme", jobTitle: "Engineer", location: "Sydney", applicationUrl: null, recruiterName: null, salaryRange: null, source: null, jobType: null } }),
    ]);
    const c = createClassifier({ ...base, runner });
    const r = await c.classify(companyEmail);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(r.extractedData.company).toBe("Acme");
    expect(r.reviewRequired).toBe(false);
  });

  test("extraction-only stage 2 can be disabled", async () => {
    const runner = fakeRunner([ok({ category: "job_response", confidence: 0.95, reason: "ack" })]);
    const c = createClassifier({ ...base, runner, stage2ForExtraction: false });
    const r = await c.classify(companyEmail);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(r.stage).toBe(1);
  });

  test("confident SEEK confirmation with rule extraction does not need stage 2; rule values win", async () => {
    const runner = fakeRunner([
      ok({ category: "job_application", confidence: 0.98, reason: "seek" }),
    ]);
    const c = createClassifier({ ...base, runner });
    const r = await c.classify(seekEmail);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(r.type).toBe("job_application");
    expect(r.extractedData).toMatchObject({ company: "Canva", jobTitle: "Data Engineer", source: "SEEK" });
  });

  test("CLI failure returns null and counts a failure (mail stays untagged)", async () => {
    const runner = fakeRunner([{ ok: false, error: "timeout", retryable: true }]);
    const c = createClassifier({ ...base, runner });
    const r = await c.classify(companyEmail);
    expect(r).toBeNull();
    expect(c.totals.failures).toBe(1);
  });

  test("retryable failure is retried once, non-retryable is not", async () => {
    const retry = fakeRunner([
      { ok: false, error: "429", retryable: true },
      ok({ category: "other", confidence: 0.9, reason: "x" }),
    ]);
    const c1 = createClassifier({ ...base, runner: retry, retries: 1 });
    expect((await c1.classify(companyEmail)).type).toBe("other");
    expect(retry).toHaveBeenCalledTimes(2);

    const noRetry = fakeRunner([{ ok: false, error: "bad args", retryable: false }, ok({ category: "other", confidence: 0.9, reason: "x" })]);
    const c2 = createClassifier({ ...base, runner: noRetry, retries: 1 });
    expect(await c2.classify(companyEmail)).toBeNull();
    expect(noRetry).toHaveBeenCalledTimes(1);
  });

  test("circuit breaker stops spending after N consecutive failures and resets on success", async () => {
    const fail = { ok: false, error: "429", retryable: false };
    const runner = fakeRunner([fail, fail, fail, ok({ category: "other", confidence: 0.9, reason: "x" })]);
    const c = createClassifier({ ...base, runner, maxConsecutiveFailures: 3 });
    expect(await c.classify(companyEmail)).toBeNull();
    expect(await c.classify(companyEmail)).toBeNull();
    expect(await c.classify(companyEmail)).toBeNull();
    expect(c.totals.tripped).toBe(true);
    expect(await c.classify(companyEmail)).toBeNull(); // not called
    expect(runner).toHaveBeenCalledTimes(3);
    expect(c.totals.skippedWhileTripped).toBe(1);

    const runner2 = fakeRunner([fail, ok({ category: "other", confidence: 0.9, reason: "x" }), fail, fail]);
    const c2 = createClassifier({ ...base, runner: runner2, maxConsecutiveFailures: 3 });
    await c2.classify(companyEmail);
    await c2.classify(companyEmail);
    expect(c2.totals.consecutiveFailures).toBe(0);
    await c2.classify(companyEmail);
    await c2.classify(companyEmail);
    expect(c2.totals.tripped).toBe(false);
  });

  test("structured output that fails schema validation returns null", async () => {
    const runner = fakeRunner([ok({ category: "spam", confidence: 2, reason: "" })]);
    const c = createClassifier({ ...base, runner });
    expect(await c.classify(companyEmail)).toBeNull();
    expect(c.totals.failures).toBe(1);
  });

  test("threshold is configurable", async () => {
    const runner = fakeRunner([ok({ category: "other", confidence: 0.85, reason: "x" }), ok({ category: "other", confidence: 0.85, reason: "x", extractedData: { company: null, jobTitle: null, location: null, applicationUrl: null, recruiterName: null, salaryRange: null, source: null, jobType: null } })]);
    const c = createClassifier({ ...base, runner, threshold: 0.9 });
    const r = await c.classify(companyEmail);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(r.reviewRequired).toBe(true);
  });

  test("extract() runs a single stage-2 call and merges rule extraction", async () => {
    const runner = fakeRunner([
      ok({ category: "job_application", confidence: 0.9, reason: "x", extractedData: { company: "Wrong", jobTitle: null, location: "Sydney", applicationUrl: null, recruiterName: null, salaryRange: null, source: null, jobType: null } }),
    ]);
    const c = createClassifier({ ...base, runner });
    const r = await c.extract(seekEmail);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.calls[0].stage).toBe(2);
    expect(r.extractedData).toMatchObject({ company: "Canva", jobTitle: "Data Engineer", location: "Sydney" });
  });
});

describe("runClaudeJson envelope parsing", () => {
  const { runClaudeJson, DEFAULTS } = require("../scripts/lib/claude-classifier");
  const params = { stage: 1, label: "x", model: "opus", effort: "low", maxBudgetUsd: "0.25", systemPrompt: "S", jsonSchema: { type: "object" }, prompt: "p" };
  const cfg = (spawnImpl) => ({ ...DEFAULTS, cwd: require("os").tmpdir(), spawnImpl });
  const envelope = (over) => JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use", num_turns: 2, total_cost_usd: 0.0123, duration_ms: 2000, duration_api_ms: 1900, usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 }, modelUsage: { "claude-opus-5-5": {} }, result: "{\"category\":\"other\"}", structured_output: { category: "other", confidence: 0.9, reason: "r" }, ...over });

  test("success envelope: structured_output, usage record, tool_use stop reason is not a failure", async () => {
    const spawnImpl = jest.fn(async () => ({ code: 0, stdout: envelope({}), stderr: "", timedOut: false }));
    const r = await runClaudeJson(params, cfg(spawnImpl));
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ category: "other", confidence: 0.9, reason: "r" });
    expect(r.usage).toMatchObject({ stage: 1, label: "x", model: "claude-opus-5-5", cost_usd: 0.0123, duration_ms: 2000, cache_read_input_tokens: 5000, num_turns: 2 });
    expect(spawnImpl.mock.calls[0][1]).toContain("--json-schema");
  });

  test("falls back to parsing result text when structured_output is missing", async () => {
    const spawnImpl = async () => ({ code: 0, stdout: envelope({ structured_output: undefined, result: "{\"category\":\"other\",\"confidence\":1,\"reason\":\"t\"}" }), stderr: "", timedOut: false });
    const r = await runClaudeJson(params, cfg(spawnImpl));
    expect(r.ok).toBe(true);
    expect(r.data.category).toBe("other");
  });

  test("error envelope with 429 is retryable; 400 is not", async () => {
    const r429 = await runClaudeJson(params, cfg(async () => ({ code: 1, stdout: envelope({ subtype: "error", is_error: true, api_error_status: 429, result: "rate limited", structured_output: undefined }), stderr: "", timedOut: false })));
    expect(r429.ok).toBe(false);
    expect(r429.retryable).toBe(true);
    expect(r429.usage.is_error).toBe(true);
    const r400 = await runClaudeJson(params, cfg(async () => ({ code: 1, stdout: envelope({ subtype: "error", is_error: true, api_error_status: 400, result: "bad", structured_output: undefined }), stderr: "", timedOut: false })));
    expect(r400.ok).toBe(false);
    expect(r400.retryable).toBe(false);
  });

  test("timeout is retryable; usage/argument error (non-JSON stdout) is not", async () => {
    const t = await runClaudeJson(params, cfg(async () => ({ code: null, stdout: "", stderr: "", timedOut: true })));
    expect(t).toMatchObject({ ok: false, retryable: true });
    const bad = await runClaudeJson(params, cfg(async () => ({ code: 1, stdout: "", stderr: "Error: --json-schema is not a valid JSON Schema", timedOut: false })));
    expect(bad.ok).toBe(false);
    expect(bad.retryable).toBe(false);
    expect(bad.error).toMatch(/json-schema/);
    const net = await runClaudeJson(params, cfg(async () => ({ code: 1, stdout: "", stderr: "fetch failed: ECONNRESET", timedOut: false })));
    expect(net.retryable).toBe(true);
  });
});
