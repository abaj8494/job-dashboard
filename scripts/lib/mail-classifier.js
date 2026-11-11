/**
 * Server-free, privacy-first mail classifier for the jobsync notmuch pipeline.
 *
 *   Stage 0  local only: tags set by other hook steps, transactional sender
 *            domains, and the SEEK/LinkedIn/Indeed rules. No Claude call.
 *   Stage 1  Claude (Opus) sees HEADERS ONLY: direction, From, To, Subject,
 *            Date, and whether the mail is a list mail. No body text.
 *   Stage 2  only when stage 1 is unsure, or a job application still lacks a
 *            company or title. Claude sees the headers plus a short, redacted
 *            excerpt of the body (quoted replies dropped; links, addresses and
 *            long numbers replaced).
 *
 * Calls go through the headless Claude Code CLI on the owner's subscription
 * (runClaudeJson in ./claude-classifier). Nothing is posted anywhere.
 */

const { z } = require("zod");
const { runClaudeJson, DEFAULTS } = require("./claude-classifier");
const { buildSystemPrompt } = require("./prompts");
const { CLASSIFICATION_TYPES, classifyByRules } = require("./classification-rules");

const EXCERPT_CHARS = 1500;

// Mail tagged by earlier post-new hook steps is never part of the job search.
const NON_JOB_TAGS = ["alpaca", "Finance", "invoice-pending", "autofile", "tern", "shrike"];

// Transactional senders (shops, banks, streaming, utilities). Matched on the
// From domain and its parents, e.g. "join.netflix.com" matches "netflix.com".
const NON_JOB_DOMAINS = [
  "netflix.com",
  "amazon.com.au",
  "amazon.com",
  "paypal.com.au",
  "paypal.com",
  "cba.com.au",
  "commbank.com.au",
  "propertytree.com",
  "remarkable.com",
  "alpaca.markets",
  "apple.com",
  "uber.com",
  "github.com",
];

// ---------------------------------------------------------------------------
// Stage 0
// ---------------------------------------------------------------------------

function senderDomain(email) {
  const m = /@([^>\s]+)\s*>?\s*$/.exec(String(email.from || ""));
  return m ? m[1].toLowerCase() : "";
}

function domainMatches(domain, list) {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Decide without Claude where that is safe. Returns
 * {type, source, extractedData} or null.
 */
function prefilter(email, tags = []) {
  const hit = tags.find((t) => NON_JOB_TAGS.includes(t));
  if (hit) return { type: "other", source: `tag:${hit}`, extractedData: {} };

  const domain = senderDomain(email);
  if (!email.isOutbound && domain && domainMatches(domain, NON_JOB_DOMAINS)) {
    return { type: "other", source: "sender-domain", extractedData: {} };
  }

  const rule = classifyByRules(email);
  if (rule) return { type: rule.type, source: `rule:${rule.reason}`, extractedData: rule.extractedData || {} };
  return null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function cleanLine(value, max = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().substring(0, max);
}

function headerBlock(email) {
  const date = email.date instanceof Date ? email.date.toISOString() : cleanLine(email.date, 40);
  const from = email.fromName
    ? `${cleanLine(email.fromName, 80)} <${cleanLine(email.from, 120)}>`
    : cleanLine(email.from, 120);
  return [
    `Direction: ${email.isOutbound ? "SENT by the owner" : "RECEIVED by the owner"}`,
    `From: ${from}`,
    `To: ${cleanLine(email.to, 120)}`,
    `Subject: ${cleanLine(email.subject, 200)}`,
    `Date: ${date}`,
    `List mail: ${email.isList ? "yes (has List-Id or List-Unsubscribe)" : "no"}`,
  ].join("\n");
}

/**
 * A short excerpt for stage 2: quoted replies and forwarded history removed,
 * links, e-mail addresses, phone and other long numbers replaced.
 */
function redactedExcerpt(text, chars = EXCERPT_CHARS) {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(On .+ wrote:|-{2,}\s*Original Message|From: .+@)/i.test(line)) break;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .substring(0, chars);
}

const STAGE1_INSTRUCTIONS = `You are seeing ONLY the headers of an email, never its body. Classify it from the headers and report how confident you are. If the headers settle it (clearly unrelated, a job alert, a job-board submission confirmation), say so with high confidence. If it is from a company or recruiter and the stage is unclear from the subject, use a confidence below 0.8.
If the headers themselves name the employer, the job title or the job location, return them; otherwise null. Never guess them.`;

const STAGE2_INSTRUCTIONS = `You are seeing the headers and a short excerpt of the body (links, addresses and numbers are replaced). Classify the email. If it is job-related, extract:
- company: the actual employer, never the job board or ATS vendor. null if not stated.
- jobTitle: the specific position title as written. null if not stated.
- location: suburb/city and state, or "Remote". null if not stated.
- advertised: false only if the excerpt says the application was unsolicited or speculative; true if it was for an advertised job; null if unclear.
Only extract what is explicitly stated. If the email is "other", every extraction field is null.`;

function buildStage1Prompt(email) {
  return `${STAGE1_INSTRUCTIONS}\n\n${headerBlock(email)}`;
}

function buildStage2Prompt(email) {
  const excerpt = redactedExcerpt(email.textBody);
  return `${STAGE2_INSTRUCTIONS}\n\n${headerBlock(email)}\n\nExcerpt:\n${excerpt || "(no text body)"}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const Category = z.enum(CLASSIFICATION_TYPES);
const Stage1Schema = z.object({
  category: Category,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  location: z.string().nullable(),
});
const Stage2Schema = Stage1Schema.extend({ advertised: z.boolean().nullable() });

function toCliJsonSchema(schema) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}
const STAGE1_JSON_SCHEMA = toCliJsonSchema(Stage1Schema);
const STAGE2_JSON_SCHEMA = toCliJsonSchema(Stage2Schema);

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

function present(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * createMailClassifier({corrections, threshold, runner, log, ...DEFAULTS overrides})
 * classify(email, {tags, label}) resolves to null on failure (leave the mail
 * untagged for a retry), else
 *   {type, confidence, stage: 0|1|2, source, extractedData: {company, jobTitle, location, advertised}}
 */
function createMailClassifier(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const runner = cfg.runner || runClaudeJson;
  const log = cfg.log || (() => {});
  const systemPrompt = buildSystemPrompt(cfg.corrections || []);
  const totals = { calls: 0, stage1: 0, stage2: 0, prefiltered: 0, cost: 0, durationMs: 0, failures: 0, consecutiveFailures: 0, tripped: false };
  const usageFile = cfg.usageFile;
  const fs = require("fs");

  function recordUsage(usage, ok) {
    totals.calls++;
    totals.cost += usage.cost_usd || 0;
    totals.durationMs += usage.duration_ms || 0;
    if (!usageFile) return;
    try {
      fs.appendFileSync(usageFile, JSON.stringify({ ...usage, ok, pipeline: "mail-classify" }) + "\n");
    } catch (e) {
      log(`usage record not written: ${e.code || e.message}`);
    }
  }

  async function runStage(stage, email, label) {
    if (totals.tripped) return null;
    const params = {
      stage,
      label,
      model: cfg.model,
      effort: stage === 1 ? cfg.stage1Effort : cfg.stage2Effort,
      maxBudgetUsd: cfg.maxBudgetUsd,
      systemPrompt,
      jsonSchema: stage === 1 ? STAGE1_JSON_SCHEMA : STAGE2_JSON_SCHEMA,
      prompt: stage === 1 ? buildStage1Prompt(email) : buildStage2Prompt(email),
    };

    let result = null;
    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      result = await runner(params, cfg);
      if (result.usage) recordUsage(result.usage, result.ok);
      if (result.ok || !result.retryable) break;
      if (attempt < cfg.retries) await new Promise((r) => setTimeout(r, cfg.retryDelayMs * (attempt + 1)));
    }

    const parsed = result && result.ok ? (stage === 1 ? Stage1Schema : Stage2Schema).safeParse(result.data) : null;
    if (!parsed || !parsed.success) {
      totals.failures++;
      totals.consecutiveFailures++;
      // Errors from the CLI can echo the prompt; log only the stage and the kind of failure.
      log(`${label} stage ${stage} failed: ${result && result.ok ? "invalid structured output" : (result && result.retryable ? "retryable error" : "error")}`);
      if (totals.consecutiveFailures >= cfg.maxConsecutiveFailures && !totals.tripped) {
        totals.tripped = true;
        log(`circuit breaker: ${totals.consecutiveFailures} consecutive failures, no more calls this run`);
      }
      return null;
    }
    totals.consecutiveFailures = 0;
    totals[`stage${stage}`]++;
    return parsed.data;
  }

  /**
   * opts.ownerType: the type the owner set (a correction) or already saw as a
   * tag (--refile). It wins over Claude's category, and Claude's company,
   * title and location are kept even if Claude itself would say "other".
   */
  async function classify(email, opts = {}) {
    const label = opts.label || String(email.messageId || "").slice(0, 80);
    const ownerType = CLASSIFICATION_TYPES.includes(opts.ownerType) ? opts.ownerType : null;

    let pre = prefilter(email, opts.tags || []);
    // An owner-typed job mail is never short-circuited to "other" by the local rules.
    if (ownerType && ownerType !== "other" && pre && pre.type === "other") pre = null;
    if (pre && (pre.type !== "job_application" || (present(pre.extractedData.company) && present(pre.extractedData.jobTitle)))) {
      totals.prefiltered++;
      return {
        type: ownerType || pre.type,
        confidence: 1,
        stage: 0,
        source: pre.source,
        extractedData: {
          company: present(pre.extractedData.company),
          jobTitle: present(pre.extractedData.jobTitle),
          location: present(pre.extractedData.location),
          advertised: pre.type === "job_application" ? true : null,
        },
      };
    }

    // A rule-matched job-board confirmation is an application; Claude only
    // fills the details the rule could not read (stage 2, no stage 1).
    const ruleApplication = Boolean(pre && pre.type === "job_application");
    const fromRules = (pre && pre.extractedData) || {};
    let final = { category: ruleApplication ? "job_application" : null, confidence: 1, company: null, jobTitle: null, location: null, advertised: null };
    let stage = 0;
    const merged = () => ({
      company: present(fromRules.company) || present(final.company),
      jobTitle: present(fromRules.jobTitle) || present(final.jobTitle),
      location: present(fromRules.location) || present(final.location),
    });

    if (!ruleApplication) {
      const s1 = await runStage(1, email, label);
      if (!s1) return null;
      final = { ...s1, advertised: null };
      stage = 1;
    }

    const unsure = final.confidence < cfg.threshold;
    const missing = final.category === "job_application" && (!merged().company || !merged().jobTitle);

    if (unsure || missing || opts.forceStage2) {
      const s2 = await runStage(2, email, label);
      if (!s2) return null;
      final = ruleApplication ? { ...s2, category: "job_application", confidence: 1 } : s2;
      stage = 2;
    }

    const type = ownerType || (CLASSIFICATION_TYPES.includes(final.category) ? final.category : "other");
    const data = merged();
    return {
      type,
      confidence: ownerType ? 1 : Math.max(0, Math.min(1, Number(final.confidence) || 0)),
      stage,
      source: ruleApplication ? `${pre.source}+claude` : "claude",
      extractedData:
        type === "other"
          ? { company: null, jobTitle: null, location: null, advertised: null }
          : { ...data, advertised: typeof final.advertised === "boolean" ? final.advertised : null },
    };
  }

  return { classify, totals, config: cfg, systemPrompt };
}

module.exports = {
  NON_JOB_TAGS,
  NON_JOB_DOMAINS,
  EXCERPT_CHARS,
  prefilter,
  headerBlock,
  redactedExcerpt,
  buildStage1Prompt,
  buildStage2Prompt,
  Stage1Schema,
  Stage2Schema,
  STAGE1_JSON_SCHEMA,
  STAGE2_JSON_SCHEMA,
  createMailClassifier,
};
