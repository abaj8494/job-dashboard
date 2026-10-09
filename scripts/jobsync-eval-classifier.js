#!/usr/bin/env node
/**
 * Classifier Eval Harness
 *
 * Builds a small labelled dataset from real notmuch mail and measures the
 * two-stage Claude classifier against it. Used to gate the switch-over from
 * Ollama (see mission jobsync-claude-classifier, slice 03).
 *
 * Dataset sources:
 *   corrections  ~/.jobsync/corrections.json — human-labelled (correctedType is
 *                ground truth, originalType is what Ollama said). By default
 *                these are evaluated with the corrections block HELD OUT of the
 *                system prompt, so the number is not in-sample.
 *   notmuch      every jobsync/<job-related> tagged mail plus a reproducible
 *                sample of jobsync/other mail. Label = current tag (Ollama or
 *                the regex fast-path). No human label; this measures
 *                agreement with Ollama and feeds the review list.
 *
 * Usage:
 *   node scripts/jobsync-eval-classifier.js --build [--others N]
 *   node scripts/jobsync-eval-classifier.js --run [--limit N] [--concurrency 2] [--only corrections|notmuch] [--no-holdout] [--force]
 *   node scripts/jobsync-eval-classifier.js --report
 *
 * Files under ~/.jobsync/eval/: dataset.json, results.json, review.md
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const { CLASSIFICATION_TYPES, classifyByRules, htmlToText } = require("./lib/classification-rules");
const { createClassifier, preflight, alertCliFailure } = require("./lib/claude-classifier");

const execAsync = promisify(exec);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const MONITORED_EMAILS = (process.env.MONITORED_EMAILS || "j@abaj.ai,aayushbajaj7@gmail.com").split(",");
const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const EVAL_DIR = path.join(JOBSYNC_DIR, "eval");
const CORRECTIONS_FILE = path.join(JOBSYNC_DIR, "corrections.json");
const DATASET_FILE = path.join(EVAL_DIR, "dataset.json");
const RESULTS_FILE = path.join(EVAL_DIR, "results.json");
const REVIEW_FILE = path.join(EVAL_DIR, "review.md");

const JOB_TYPES = CLASSIFICATION_TYPES.filter((t) => t !== "other");
const BODY_CHARS = 8000;

function log(m) {
  console.log(`[${new Date().toISOString()}] ${m}`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}

function monitoredClause() {
  return MONITORED_EMAILS.map((e) => `(from:${e} OR to:${e})`).join(" OR ");
}

async function notmuchMessages(query) {
  const { stdout } = await execAsync(`notmuch search --output=messages "${query}"`, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim().split("\n").filter(Boolean).map((s) => s.replace(/^id:/, ""));
}

async function notmuchFile(messageId) {
  try {
    const escaped = messageId.replace(/'/g, "'\\''");
    const { stdout } = await execAsync(`notmuch search --output=files 'id:${escaped}'`);
    return stdout.trim().split("\n")[0] || null;
  } catch (e) {
    return null;
  }
}

async function parseEmailFile(filePath) {
  const parsed = await simpleParser(fs.readFileSync(filePath));
  const fromAddress = parsed.from?.value?.[0]?.address || parsed.from?.text || "";
  const toAddress = parsed.to
    ? Array.isArray(parsed.to)
      ? parsed.to[0]?.value?.[0]?.address || ""
      : parsed.to.value?.[0]?.address || parsed.to.text || ""
    : "";
  const isOutbound = MONITORED_EMAILS.some((e) => fromAddress.toLowerCase() === e.toLowerCase());
  return {
    messageId: parsed.messageId || "",
    subject: parsed.subject || "(No subject)",
    from: fromAddress,
    fromName: parsed.from?.value?.[0]?.name,
    to: toAddress,
    date: (parsed.date || new Date()).toISOString(),
    isOutbound,
    textBody: (parsed.text || htmlToText(parsed.html) || "").substring(0, BODY_CHARS),
  };
}

// Deterministic shuffle so --build is reproducible.
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// --build
// ---------------------------------------------------------------------------

async function build() {
  const othersN = parseInt(val("--others", "25"), 10);
  const corrections = readJson(CORRECTIONS_FILE, { corrections: [] }).corrections || [];
  const items = [];
  const seen = new Set();

  log(`Building dataset: ${corrections.length} corrections + all job-related tags + ${othersN} others`);

  for (const c of corrections) {
    const id = c.messageId.replace(/^<|>$/g, "");
    if (seen.has(id)) continue;
    seen.add(id);
    const file = await notmuchFile(id);
    let email = null;
    if (file) {
      try {
        email = await parseEmailFile(file);
      } catch (e) {
        log(`parse failed for ${id}: ${e.message}`);
      }
    }
    if (!email) {
      email = {
        messageId: `<${id}>`,
        subject: c.subject,
        from: c.from,
        fromName: c.fromName,
        to: c.to,
        date: c.correctedAt,
        isOutbound: !!c.isOutbound,
        textBody: (c.bodyPreview || "").substring(0, BODY_CHARS),
      };
    }
    items.push({ id, source: "corrections", humanLabel: c.correctedType, ollamaLabel: c.originalType, email });
  }

  for (const t of JOB_TYPES) {
    const ids = await notmuchMessages(`tag:jobsync/${t} AND (${monitoredClause()}) AND NOT tag:spam AND NOT tag:trash`);
    for (const id of ids) {
      if (seen.has(id)) continue;
      const file = await notmuchFile(id);
      if (!file) continue;
      try {
        const email = await parseEmailFile(file);
        seen.add(id);
        items.push({ id, source: "notmuch", humanLabel: null, ollamaLabel: t, email });
      } catch (e) {
        log(`parse failed for ${id}: ${e.message}`);
      }
    }
  }

  const otherIds = (await notmuchMessages(`tag:jobsync/other AND (${monitoredClause()}) AND NOT tag:spam AND NOT tag:trash`))
    .filter((id) => !seen.has(id))
    .sort((a, b) => hashString(a) - hashString(b))
    .slice(0, othersN);
  for (const id of otherIds) {
    const file = await notmuchFile(id);
    if (!file) continue;
    try {
      const email = await parseEmailFile(file);
      seen.add(id);
      items.push({ id, source: "notmuch", humanLabel: null, ollamaLabel: "other", email });
    } catch (e) {
      log(`parse failed for ${id}: ${e.message}`);
    }
  }

  const dataset = { builtAt: new Date().toISOString(), items };
  writeJson(DATASET_FILE, dataset);

  const bySource = {};
  for (const it of items) bySource[it.source] = (bySource[it.source] || 0) + 1;
  const byLabel = {};
  for (const it of items) {
    const l = it.humanLabel || it.ollamaLabel;
    byLabel[l] = (byLabel[l] || 0) + 1;
  }
  log(`Wrote ${items.length} items to ${DATASET_FILE}`);
  log(`By source: ${JSON.stringify(bySource)}`);
  log(`By label (human where available): ${JSON.stringify(byLabel)}`);
}

// ---------------------------------------------------------------------------
// --run
// ---------------------------------------------------------------------------

async function runWithConcurrency(items, fn, concurrency) {
  let index = 0;
  const results = [];
  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i, items.length);
      } catch (error) {
        results[i] = { error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function run() {
  const dataset = readJson(DATASET_FILE, null);
  if (!dataset) {
    log(`No dataset at ${DATASET_FILE}; run --build first`);
    process.exit(1);
  }
  const limit = parseInt(val("--limit", "0"), 10);
  const concurrency = parseInt(val("--concurrency", "2"), 10);
  const only = val("--only", null);
  const holdout = !has("--no-holdout");
  const force = has("--force");
  const threshold = parseFloat(val("--threshold", process.env.JOBSYNC_CONFIDENCE_THRESHOLD || "0.8"));

  const existing = force ? {} : readJson(RESULTS_FILE, { results: {} }).results || {};

  let items = dataset.items.filter((it) => !only || it.source === only).filter((it) => !existing[it.id]);
  if (limit > 0) items = items.slice(0, limit);
  log(`Running ${items.length} items (skipping ${Object.keys(existing).length} already done; --force to redo)`);
  if (items.length === 0) return report();

  const pf = await preflight();
  if (!pf.ok) {
    alertCliFailure("eval preflight", pf.detail, log);
    process.exit(2);
  }
  log(`Preflight: claude CLI ok (${pf.detail})`);

  const corrections = readJson(CORRECTIONS_FILE, { corrections: [] }).corrections || [];
  const full = createClassifier({ corrections, threshold, log });
  // Human-labelled items are evaluated without their own labels in the prompt.
  const heldOut = holdout ? createClassifier({ corrections: [], threshold, log }) : full;
  log(`Classifier: model=${full.config.model} threshold=${threshold} holdout=${holdout} concurrency=${concurrency}`);

  const results = { ...existing };
  const t0 = Date.now();

  await runWithConcurrency(
    items,
    async (it, i, n) => {
      const email = { ...it.email, date: new Date(it.email.date) };
      const rule = classifyByRules(email);
      const classifier = it.source === "corrections" ? heldOut : full;
      const r = await classifier.classify(email, { label: it.id });
      if (!r) {
        log(`[${i + 1}/${n}] FAILED ${it.email.subject.substring(0, 50)}`);
        return null;
      }
      const row = {
        id: it.id,
        source: it.source,
        subject: it.email.subject,
        from: it.email.from,
        humanLabel: it.humanLabel,
        ollamaLabel: it.ollamaLabel,
        ruleMatch: rule ? rule.type : null,
        stage1: r.stage1,
        stage2: r.stage2 ? { category: r.stage2.category, confidence: r.stage2.confidence, reason: r.stage2.reason } : null,
        final: r.type,
        confidence: r.confidence,
        stage: r.stage,
        reviewRequired: r.reviewRequired,
        extractedData: r.extractedData,
        cost: r.cost,
        durationMs: r.durationMs,
        heldOut: it.source === "corrections" ? holdout : false,
        ts: new Date().toISOString(),
      };
      results[it.id] = row;
      const truth = it.humanLabel || it.ollamaLabel;
      log(`[${i + 1}/${n}] ${row.final === truth ? "ok  " : "DIFF"} s${r.stage} ${r.type}@${r.confidence.toFixed(2)} vs ${truth}${it.humanLabel ? "(human)" : "(ollama)"} | ${it.email.subject.substring(0, 50)}`);
      // Persist incrementally so an interrupted run resumes.
      writeJson(RESULTS_FILE, { updatedAt: new Date().toISOString(), threshold, results });
      return row;
    },
    concurrency
  );

  log(`Run finished in ${((Date.now() - t0) / 1000).toFixed(0)}s; claude calls=${full.totals.calls + heldOut.totals.calls} cost=$${(full.totals.cost + heldOut.totals.cost).toFixed(3)}`);
  writeJson(RESULTS_FILE, { updatedAt: new Date().toISOString(), threshold, results });
  return report();
}

// ---------------------------------------------------------------------------
// --report
// ---------------------------------------------------------------------------

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : "n/a";
}

async function monthlyVolume() {
  try {
    const { stdout } = await execAsync(`notmuch count "date:60days.. AND (${monitoredClause()}) AND NOT tag:spam AND NOT tag:trash"`);
    return Math.round(parseInt(stdout.trim(), 10) / 2);
  } catch (e) {
    return null;
  }
}

async function report() {
  const data = readJson(RESULTS_FILE, null);
  if (!data) {
    log("No results yet");
    return;
  }
  const threshold = data.threshold;
  const rows = Object.values(data.results);
  const human = rows.filter((r) => r.humanLabel);
  const ollamaOnly = rows.filter((r) => !r.humanLabel);

  const lines = [];
  const out = (s = "") => lines.push(s);

  out(`# Classifier eval — ${rows.length} mails, threshold ${threshold}`);
  out();
  out(`## Accuracy on human-labelled corrections (${human.length} mails${human.some((r) => r.heldOut) ? ", corrections block held out of the prompt" : ", corrections IN prompt (in-sample)"})`);
  const s1ok = human.filter((r) => r.stage1.category === r.humanLabel).length;
  const finOk = human.filter((r) => r.final === r.humanLabel).length;
  const s1conf = human.filter((r) => r.stage1.confidence >= threshold);
  const s1confOk = s1conf.filter((r) => r.stage1.category === r.humanLabel).length;
  const ollOk = human.filter((r) => r.ollamaLabel === r.humanLabel).length;
  out(`- Stage-1-only accuracy: ${pct(s1ok, human.length)}`);
  out(`- Stage-1 accuracy when confident (>= ${threshold}): ${pct(s1confOk, s1conf.length)}; confident on ${pct(s1conf.length, human.length)}`);
  out(`- Final (two-stage) accuracy: ${pct(finOk, human.length)}`);
  out(`- Ollama accuracy on the same mails (by construction every one was an Ollama mistake): ${pct(ollOk, human.length)}`);
  const jobRelatedBinaryOk = human.filter((r) => (r.final !== "other") === (r.humanLabel !== "other")).length;
  out(`- Job-related vs other (binary) final accuracy: ${pct(jobRelatedBinaryOk, human.length)}`);
  out();

  out(`## Stage 2 usage (all ${rows.length} mails)`);
  const s2 = rows.filter((r) => r.stage === 2);
  const s2Doubt = rows.filter((r) => r.stage === 2 && r.stage1.confidence < threshold);
  const s2Extract = rows.filter((r) => r.stage === 2 && r.stage1.confidence >= threshold);
  out(`- Stage 2 ran on ${pct(s2.length, rows.length)}: ${s2Doubt.length} for low confidence, ${s2Extract.length} for extraction of a confident job-related mail`);
  const otherRows = rows.filter((r) => (r.humanLabel || r.ollamaLabel) === "other");
  const otherS1 = otherRows.filter((r) => r.stage === 1).length;
  out(`- Of mails labelled "other" (${otherRows.length}), settled on metadata alone: ${pct(otherS1, otherRows.length)}`);
  out(`- Would auto-file (job-related, confident): ${rows.filter((r) => r.final !== "other" && !r.reviewRequired).length}; would stay pending: ${rows.filter((r) => r.reviewRequired).length}`);
  out();

  out(`## Disagreement with Ollama`);
  const dis = rows.filter((r) => r.final !== r.ollamaLabel);
  out(`- Final label differs from Ollama/current tag on ${pct(dis.length, rows.length)} of all mails`);
  const disO = ollamaOnly.filter((r) => r.final !== r.ollamaLabel);
  out(`- On the unlabelled notmuch sample: ${pct(disO.length, ollamaOnly.length)} (needs the owner's eye; see review list)`);
  const pairs = {};
  for (const r of dis) {
    const k = `${r.ollamaLabel} -> ${r.final}`;
    pairs[k] = (pairs[k] || 0) + 1;
  }
  for (const [k, n] of Object.entries(pairs).sort((a, b) => b[1] - a[1])) out(`  - ${n} × ${k}`);
  const confusion = {};
  for (const r of human) {
    const k = `${r.humanLabel} -> ${r.final}`;
    confusion[k] = (confusion[k] || 0) + 1;
  }
  out(`- Human-labelled confusion (truth -> claude):`);
  for (const [k, n] of Object.entries(confusion).sort((a, b) => b[1] - a[1])) out(`  - ${n} × ${k}`);
  const jaJr = rows.filter((r) => ["job_application", "job_response"].includes(r.final) || ["job_application", "job_response"].includes(r.humanLabel || r.ollamaLabel));
  const jaJrSwap = jaJr.filter((r) => {
    const t = r.humanLabel || r.ollamaLabel;
    return (t === "job_application" && r.final === "job_response") || (t === "job_response" && r.final === "job_application");
  });
  out(`- job_application/job_response swaps: ${jaJrSwap.length} of ${jaJr.length} mails touching the pair`);
  out();

  out(`## Cost and latency`);
  const cost = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const ms = rows.reduce((a, r) => a + (r.durationMs || 0), 0);
  const meanCost = rows.length ? cost / rows.length : 0;
  const s1Rows = rows.filter((r) => r.stage === 1);
  const meanS1 = s1Rows.length ? s1Rows.reduce((a, r) => a + r.cost, 0) / s1Rows.length : 0;
  const meanS2 = s2.length ? s2.reduce((a, r) => a + r.cost, 0) / s2.length : 0;
  out(`- Total notional cost for this eval: $${cost.toFixed(3)} (billed to the Max subscription, not per token)`);
  out(`- Mean per mail: $${meanCost.toFixed(4)} (stage-1-only mails $${meanS1.toFixed(4)}, two-stage mails $${meanS2.toFixed(4)})`);
  out(`- Mean latency per mail: ${(ms / Math.max(rows.length, 1) / 1000).toFixed(1)}s of model time (plus ~3s CLI startup per call)`);
  const vol = await monthlyVolume();
  if (vol !== null) {
    out(`- Monthly volume (monitored mail, last 60 days / 2): ~${vol} mails`);
    out(`- Projected monthly notional cost: ~$${(vol * meanCost).toFixed(2)} at this mix; ~$${(vol * meanS1).toFixed(2)} if everything settled at stage 1`);
    out(`- Note: cold calls re-write the ~6-7k-token system prompt cache (about $0.05 each) after an idle gap; the eval runs warm, so real hook traffic will be somewhat higher.`);
  }
  out();

  const text = lines.join("\n");
  console.log("\n" + text);

  // Review list: subject + Ollama label + Claude label only.
  const review = [];
  review.push(`# Review list — ${rows.length} mails (subject | Ollama/current tag | Claude)`);
  review.push("");
  review.push("Human-labelled corrections are marked with the human label in brackets. `?` = Claude would leave it pending for review.");
  review.push("");
  review.push("| # | Subject | Ollama | Claude |");
  review.push("|---|---|---|---|");
  rows
    .sort((a, b) => (a.final === a.ollamaLabel) - (b.final === b.ollamaLabel) || a.subject.localeCompare(b.subject))
    .forEach((r, i) => {
      const subj = r.subject.replace(/\|/g, "/").replace(/\s+/g, " ").substring(0, 70);
      const claude = `${r.final}${r.reviewRequired ? " ?" : ""}`;
      const human = r.humanLabel ? ` [human: ${r.humanLabel}]` : "";
      review.push(`| ${i + 1} | ${subj} | ${r.ollamaLabel} | ${claude}${human} |`);
    });
  fs.writeFileSync(REVIEW_FILE, review.join("\n") + "\n");
  fs.writeFileSync(path.join(EVAL_DIR, "report.md"), text + "\n");
  log(`Wrote ${REVIEW_FILE} and report.md`);
}

(async () => {
  if (has("--build")) await build();
  else if (has("--run")) await run();
  else if (has("--report")) await report();
  else {
    console.log("Usage: --build [--others N] | --run [--limit N] [--concurrency N] [--only corrections|notmuch] [--no-holdout] [--force] | --report");
    process.exit(1);
  }
})().catch((e) => {
  log(`Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
