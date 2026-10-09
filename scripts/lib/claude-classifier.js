/**
 * Claude Email Classifier (two-stage, headless Claude Code CLI)
 *
 * Invokes the local `claude` binary in print mode with tools disabled and a
 * JSON schema for structured output. Billed to the owner's claude.ai
 * subscription; no API key, no SDK.
 *
 *   Stage 1  metadata + 300-char snippet, effort low.  Final if confident.
 *   Stage 2  full body + extraction, effort medium.    Runs only when
 *            stage 1 is below the threshold, or (by default) when a job-related
 *            email still lacks company/jobTitle after rule extraction, because
 *            auto-filing needs them.
 *
 * Every call appends a usage record (total_cost_usd, duration, tokens) to
 * ~/.jobsync/claude-usage.jsonl.
 *
 * Failure semantics: any CLI, timeout, envelope or schema failure returns null
 * from classify(); callers must leave the mail untagged so the next run
 * retries. Nothing is ever mis-filed on failure.
 */

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildSystemPrompt,
  buildStage1Prompt,
  buildStage2Prompt,
  Stage1Schema,
  Stage2Schema,
  ExtractedDataSchema,
  STAGE1_JSON_SCHEMA,
  STAGE2_JSON_SCHEMA,
} = require("./prompts");
const { CLASSIFICATION_TYPES } = require("./classification-rules");
const { extractByRules, mergeExtractedData, needsLLMFallback } = require("./extraction-rules");

const HOME = process.env.HOME || os.homedir();
const JOBSYNC_DIR = path.join(HOME, ".jobsync");

const DEFAULTS = {
  bin: process.env.CLAUDE_BIN || path.join(HOME, ".local", "bin", "claude"),
  model: process.env.JOBSYNC_CLAUDE_MODEL || "opus",
  threshold: parseFloat(process.env.JOBSYNC_CONFIDENCE_THRESHOLD || "0.8"),
  timeoutMs: parseInt(process.env.JOBSYNC_CLAUDE_TIMEOUT_MS || "120000", 10),
  maxBudgetUsd: process.env.JOBSYNC_CLAUDE_MAX_BUDGET_USD || "0.25",
  stage1Effort: process.env.JOBSYNC_STAGE1_EFFORT || "low",
  stage2Effort: process.env.JOBSYNC_STAGE2_EFFORT || "medium",
  stage2ForExtraction: (process.env.JOBSYNC_STAGE2_FOR_EXTRACTION || "1") !== "0",
  usageFile: process.env.JOBSYNC_USAGE_FILE || path.join(JOBSYNC_DIR, "claude-usage.jsonl"),
  cwd: JOBSYNC_DIR,
  retries: 1,
  retryDelayMs: 5000,
  // After this many consecutive failed classifications (e.g. a 429 storm or a
  // logged-out CLI) classify() returns null without spending until a success.
  maxConsecutiveFailures: parseInt(process.env.JOBSYNC_MAX_CONSECUTIVE_FAILURES || "5", 10),
};

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The CLI is run from ~/.jobsync (no project settings there); create it if missing. */
function ensureCwd(cwd) {
  try {
    fs.mkdirSync(cwd, { recursive: true });
    return cwd;
  } catch (e) {
    return os.tmpdir();
  }
}

// ---------------------------------------------------------------------------
// Preflight: prove the CLI is logged in before any spend
// ---------------------------------------------------------------------------

function authStatus(opts = {}) {
  const bin = opts.bin || DEFAULTS.bin;
  const timeout = opts.timeoutMs || 20000;
  return new Promise((resolve) => {
    if (!fs.existsSync(bin)) {
      resolve({ error: `claude binary missing: ${bin}` });
      return;
    }
    execFile(bin, ["auth", "status", "--json"], { timeout, cwd: ensureCwd(opts.cwd || DEFAULTS.cwd), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        // fallthrough
      }
      if (err && !parsed) {
        resolve({ error: `auth status failed: ${err.message} ${String(stderr || "").slice(-200)}`.trim() });
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        resolve({ error: `auth status returned non-JSON: ${String(stdout).slice(-200)}` });
        return;
      }
      if (err) parsed.error = `auth status exited: ${err.message}`;
      resolve(parsed);
    });
  });
}

function authSummary(d) {
  if (!d) return "unknown";
  if (d.error) return d.error;
  return `loggedIn=${d.loggedIn} authMethod=${d.authMethod} subscription=${d.subscriptionType || d.apiProvider}`;
}

/**
 * Returns { ok: boolean, detail: string, status }.
 */
async function preflight(opts = {}) {
  const status = await authStatus(opts);
  if (status.error) return { ok: false, detail: status.error, status };
  if (status.loggedIn !== true) return { ok: false, detail: `not logged in (${authSummary(status)})`, status };
  return { ok: true, detail: authSummary(status), status };
}

/**
 * Best-effort loud failure: log + macOS notification. Never throws.
 */
function alertCliFailure(where, detail, log) {
  const message = `JobSync could not use the claude CLI (${where}): ${detail}. Mail left untagged for retry.`;
  if (log) log(`ALERT: ${message}`);
  if (process.platform === "darwin") {
    try {
      execFile("osascript", ["-e", `display notification ${JSON.stringify(message.substring(0, 200))} with title "JobSync"`], () => {});
    } catch (e) {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Low-level: one headless CLI call with a JSON schema
// ---------------------------------------------------------------------------

/**
 * Spawn the CLI once. Resolves { code, stdout, stderr, timedOut }.
 */
function spawnClaude(bin, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e.message), timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (e) {
        // ignore
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message), timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function buildArgs({ model, effort, maxBudgetUsd, systemPrompt, jsonSchema, prompt }) {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--tools",
    "",
    "--model",
    model,
    "--effort",
    effort,
    "--no-session-persistence",
    "--permission-prompts",
    "none",
    "--strict-mcp-config",
    "--max-budget-usd",
    String(maxBudgetUsd),
    "--system-prompt",
    systemPrompt,
    "--json-schema",
    JSON.stringify(jsonSchema),
  ];
}

function usageRecord(envelope, meta) {
  const u = envelope.usage || {};
  return {
    ts: new Date().toISOString(),
    ...meta,
    model: Object.keys(envelope.modelUsage || {})[0] || null,
    cost_usd: envelope.total_cost_usd ?? null,
    duration_ms: envelope.duration_ms ?? null,
    duration_api_ms: envelope.duration_api_ms ?? null,
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_read_input_tokens: u.cache_read_input_tokens ?? null,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
    num_turns: envelope.num_turns ?? null,
    is_error: envelope.is_error ?? null,
    api_error_status: envelope.api_error_status ?? null,
    subtype: envelope.subtype ?? null,
  };
}

/**
 * Default runner. Returns
 *   { ok: true,  data, envelope, usage }
 *   { ok: false, error, retryable, envelope?, usage? }
 */
async function runClaudeJson(params, cfg) {
  const bin = cfg.bin;
  const args = buildArgs(params);
  const spawnImpl = cfg.spawnImpl || spawnClaude;
  const { code, stdout, stderr, timedOut } = await spawnImpl(bin, args, { cwd: ensureCwd(cfg.cwd), timeoutMs: cfg.timeoutMs });

  if (timedOut) {
    return { ok: false, error: `timeout after ${cfg.timeoutMs}ms`, retryable: true };
  }

  let envelope = null;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    // Non-JSON output; fall through
  }

  if (!envelope || typeof envelope !== "object") {
    const tail = String(stderr).slice(-300).replace(/\s+/g, " ");
    return {
      ok: false,
      error: `claude exited ${code} with non-JSON output; stdout ${stdout.length} bytes, stderr ${tail}`,
      // A usage/argument error (exit 1 with a message) will not fix itself;
      // only transient transport problems are worth a retry.
      retryable: /rate limit|overloaded|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|network/i.test(tail),
    };
  }

  const usage = usageRecord(envelope, { stage: params.stage, label: params.label });

  if (envelope.is_error || envelope.subtype !== "success") {
    const status = envelope.api_error_status;
    return {
      ok: false,
      error: `claude envelope error: subtype=${envelope.subtype} api_error_status=${status} result=${String(envelope.result || "").slice(0, 200)}`,
      retryable: RETRYABLE_STATUS.has(Number(status)) || /rate limit|overloaded|timeout/i.test(String(envelope.result || "")),
      envelope,
      usage,
    };
  }

  // A normal structured-output call reports stop_reason "tool_use" and 2 turns.
  // That is how --json-schema is implemented; it is not a failure.
  let data = envelope.structured_output;
  if (data === undefined || data === null) {
    try {
      data = JSON.parse(envelope.result);
    } catch (e) {
      return { ok: false, error: "no structured_output in envelope", retryable: false, envelope, usage };
    }
  }

  return { ok: true, data, envelope, usage };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

function nullableExtraction(extracted) {
  const out = {};
  for (const [k, v] of Object.entries(extracted || {})) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

/**
 * createClassifier(options)
 *   corrections   array from ~/.jobsync/corrections.json (few-shot block)
 *   threshold     confidence at/above which stage 1 is final (default 0.8)
 *   log           function(message)
 *   runner        injectable (params, cfg) => result, for tests
 *   plus any DEFAULTS override (bin, model, timeoutMs, ...)
 */
function createClassifier(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const log = cfg.log || (() => {});
  const runner = cfg.runner || runClaudeJson;
  const systemPrompt = buildSystemPrompt(cfg.corrections || []);
  const totals = { calls: 0, cost: 0, durationMs: 0, stage1: 0, stage2: 0, failures: 0, consecutiveFailures: 0, tripped: false, skippedWhileTripped: 0 };

  function noteOutcome(ok) {
    if (ok) {
      totals.consecutiveFailures = 0;
      return;
    }
    totals.consecutiveFailures++;
    if (!totals.tripped && totals.consecutiveFailures >= cfg.maxConsecutiveFailures) {
      totals.tripped = true;
      log(`Circuit breaker: ${totals.consecutiveFailures} consecutive classification failures; no further calls this run.`);
    }
  }

  function appendUsage(record) {
    totals.calls++;
    totals.cost += record.cost_usd || 0;
    totals.durationMs += record.duration_ms || 0;
    if (record.stage === 1) totals.stage1++;
    if (record.stage === 2) totals.stage2++;
    if (!cfg.usageFile) return;
    try {
      fs.mkdirSync(path.dirname(cfg.usageFile), { recursive: true });
      fs.appendFileSync(cfg.usageFile, JSON.stringify(record) + "\n");
    } catch (e) {
      log(`Failed to write usage record: ${e.message}`);
    }
  }

  async function callWithRetry(params) {
    let attempt = 0;
    let last = null;
    while (attempt <= cfg.retries) {
      const result = await runner(params, cfg);
      if (result.usage) appendUsage({ ...result.usage, ok: result.ok, attempt });
      if (result.ok) return result;
      last = result;
      log(`Claude stage ${params.stage} failed (attempt ${attempt + 1}/${cfg.retries + 1}): ${result.error}`);
      if (!result.retryable) break;
      attempt++;
      if (attempt <= cfg.retries) await sleep(cfg.retryDelayMs * attempt);
    }
    totals.failures++;
    return last;
  }

  async function runStage(stage, email, label) {
    if (totals.tripped) {
      totals.skippedWhileTripped++;
      return null;
    }
    const isStage1 = stage === 1;
    const result = await callWithRetry({
      stage,
      label,
      model: cfg.model,
      effort: isStage1 ? cfg.stage1Effort : cfg.stage2Effort,
      maxBudgetUsd: cfg.maxBudgetUsd,
      systemPrompt,
      jsonSchema: isStage1 ? STAGE1_JSON_SCHEMA : STAGE2_JSON_SCHEMA,
      prompt: isStage1 ? buildStage1Prompt(email) : buildStage2Prompt(email),
    });
    if (!result.ok) {
      noteOutcome(false);
      return null;
    }

    const parsed = (isStage1 ? Stage1Schema : Stage2Schema).safeParse(result.data);
    if (!parsed.success) {
      totals.failures++;
      log(`Claude stage ${stage} returned invalid structured output: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
      noteOutcome(false);
      return null;
    }
    noteOutcome(true);
    return {
      ...parsed.data,
      cost: result.usage?.cost_usd || 0,
      durationMs: result.usage?.duration_ms || 0,
    };
  }

  /**
   * Full two-stage classification.
   * Returns null on failure (caller leaves the mail untagged), else:
   * {
   *   type, confidence, reason, stage (1|2), reviewRequired,
   *   extractedData, stage1, stage2, cost, durationMs
   * }
   */
  async function classify(email, opts = {}) {
    const label = opts.label || (email.messageId || "").slice(0, 60);
    const stage1 = await runStage(1, email, label);
    if (!stage1) return null;

    const ruleExtracted = extractByRules(email);
    let final = stage1;
    let stage = 1;
    let stage2 = null;
    let extractedData = { ...ruleExtracted };

    const confident = stage1.confidence >= cfg.threshold;
    const jobRelated = stage1.category !== "other";
    const needsExtraction = cfg.stage2ForExtraction && jobRelated && needsLLMFallback(ruleExtracted);

    if (!confident || needsExtraction || opts.forceStage2) {
      stage2 = await runStage(2, email, label);
      if (!stage2) return null;
      final = stage2;
      stage = 2;
      // Prefer rule-extracted values (SEEK/LinkedIn exact patterns), fill the rest from Claude.
      extractedData = mergeExtractedData(ruleExtracted, nullableExtraction(stage2.extractedData));
    }

    const type = CLASSIFICATION_TYPES.includes(final.category) ? final.category : "other";
    const confidence = Math.max(0, Math.min(1, Number(final.confidence) || 0));

    return {
      type,
      confidence,
      reason: final.reason,
      stage,
      reviewRequired: confidence < cfg.threshold,
      extractedData: type === "other" ? {} : nullableExtraction(extractedData),
      stage1: { category: stage1.category, confidence: stage1.confidence, reason: stage1.reason },
      stage2: stage2 ? { category: stage2.category, confidence: stage2.confidence, reason: stage2.reason, extractedData: stage2.extractedData } : null,
      cost: (stage1.cost || 0) + (stage2 ? stage2.cost || 0 : 0),
      durationMs: (stage1.durationMs || 0) + (stage2 ? stage2.durationMs || 0 : 0),
    };
  }

  /**
   * Extraction only (stage 2 call on a known job-related email).
   * Used by scan-corrections promotions and backfill-metadata.
   * Returns extractedData object (possibly empty) or null on failure.
   */
  async function extract(email, opts = {}) {
    const label = opts.label || (email.messageId || "").slice(0, 60);
    const stage2 = await runStage(2, email, label);
    if (!stage2) return null;
    const ruleExtracted = extractByRules(email);
    return {
      extractedData: nullableExtraction(mergeExtractedData(ruleExtracted, nullableExtraction(stage2.extractedData))),
      category: stage2.category,
      confidence: stage2.confidence,
      reason: stage2.reason,
      cost: stage2.cost || 0,
    };
  }

  return {
    classify,
    extract,
    totals,
    config: cfg,
    systemPrompt,
  };
}

module.exports = {
  DEFAULTS,
  authStatus,
  authSummary,
  preflight,
  alertCliFailure,
  runClaudeJson,
  buildArgs,
  createClassifier,
  ExtractedDataSchema,
};
