#!/usr/bin/env node
/**
 * JobSync Discover — Local Cron Script
 *
 * Fetches jobs from Adzuna + Jooble, scores them against resume profile
 * using Ollama, and POSTs the top matches to the JobSync server.
 *
 * Usage:
 *   node scripts/jobsync-discover.js [--dry-run] [--top N]
 *
 * Config: reads from environment (source ~/.jobsync/config)
 */

const fs = require("fs");
const path = require("path");

// Load .env from project root (for Adzuna/Jooble keys)
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

// Configuration from environment
const JOBSYNC_API_KEY = process.env.JOBSYNC_API_KEY || "";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || "";
const ADZUNA_API_KEY = process.env.ADZUNA_API_KEY || "";
const JOOBLE_API_KEY = process.env.JOOBLE_API_KEY || "";
const DISCOVER_API_URL =
  process.env.DISCOVER_API_URL || "http://localhost:3000/api/discover";
const DISCOVER_TOP_N = parseInt(process.env.DISCOVER_TOP_N || "10", 10);
const DISCOVER_MAX_DAYS_OLD = parseInt(
  process.env.DISCOVER_MAX_DAYS_OLD || "3",
  10
);

const JOBSYNC_DIR = path.join(process.env.HOME || "~", ".jobsync");
const LOG_FILE = path.join(JOBSYNC_DIR, "discover.log");
const IS_TTY = process.stdout.isTTY;

// CLI flags
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const topIdx = args.indexOf("--top");
const TOP_N = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : DISCOVER_TOP_N;

const SEARCH_QUERIES = [
  "machine learning engineer",
  "software engineer",
  "data analyst",
];
const SEARCH_LOCATION = "Sydney";

const CANDIDATE_PROFILE = `Aayush Bajaj — Sydney-based ML/Software Engineer graduating Sep 2025 from UNSW (CS/AI + Math minor). Starting Masters in Statistics Feb 2026.

EXPERIENCE LEVEL: Fresh graduate (Bachelor CS/AI from UNSW, Sep 2025). No full-time commercial experience — all projects are academic, personal, or short freelance. Targeting ENTRY-LEVEL, JUNIOR, and GRADUATE roles only.

KEY STRENGTHS:
- ML Engineering: Ranked #57 globally on KiTS19 medical imaging benchmark. PyTorch, TensorFlow, HuggingFace, nnU-Net, CNNs, LLMs, RAG. HPC experience with H200/A200 GPUs.
- Software Engineering: 14 deployed web services, 90%+ test coverage. Python, Go, TypeScript, JavaScript, Java, C, SQL. Flask, React, Node.js, Express, PostgreSQL, REST APIs.
- Data Analytics: Statistical analysis, hypothesis testing, regression, time series, A/B testing. Pandas, NumPy, Matplotlib, SQL, ETL pipelines.
- DevOps/Cloud: Docker, AWS (Solutions Architect certified), Azure, CI/CD, Linux, Nginx.
- LLM/GenAI: LangChain, LangGraph, OpenAI API, prompt engineering, fine-tuning.

NOTABLE PROJECTS:
- KiTS19 3D medical image segmentation (0.9129 Dice score, #57 globally)
- Full-stack chatbot with Hono, OpenAI GPT streaming, PostgreSQL
- Arcade platform with 22 browser games, Socket.IO multiplayer
- Medical records system for active practice (led 5-person team)
- Minesweeper AI solver with ResNet + ONNX browser inference

LOOKING FOR: ML Engineer, Software Engineer, Data Analyst, AI Engineer roles in Sydney. Open to hybrid/remote.`;

// ============ Logging ============

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  try {
    fs.appendFileSync(LOG_FILE, logMessage + "\n");
  } catch (e) {
    // ignore
  }
  if (IS_TTY) {
    console.log(logMessage);
  }
}

// ============ Concurrency helper ============

async function runWithConcurrency(items, fn, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      try {
        const result = await fn(item, currentIndex, items.length);
        results[currentIndex] = result;
      } catch (error) {
        results[currentIndex] = { error };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

// ============ Adzuna API ============

async function searchAdzuna(keywords, location, maxDaysOld) {
  if (!ADZUNA_APP_ID || !ADZUNA_API_KEY) {
    log("Adzuna credentials not configured, skipping");
    return [];
  }

  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_API_KEY,
    results_per_page: "25",
    what: keywords,
    where: location,
    max_days_old: maxDaysOld.toString(),
    sort_by: "date",
  });

  const url = `https://api.adzuna.com/v1/api/jobs/au/search/1?${params}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      log(`Adzuna API error for "${keywords}": ${response.status}`);
      return [];
    }

    const data = await response.json();
    return (data.results || []).map((r) => {
      const salary =
        r.salary_min && r.salary_max
          ? `$${Math.round(r.salary_min).toLocaleString()} - $${Math.round(r.salary_max).toLocaleString()}`
          : r.salary_min
            ? `$${Math.round(r.salary_min).toLocaleString()}`
            : undefined;

      return {
        externalId: r.id.toString(),
        source: "adzuna",
        title: r.title,
        company: r.company?.display_name || "Unknown",
        location: r.location?.display_name || location,
        salary,
        url: r.redirect_url,
        description: r.description || "",
        postedDate: r.created,
      };
    });
  } catch (error) {
    log(`Adzuna fetch failed for "${keywords}": ${error.message}`);
    return [];
  }
}

// ============ Jooble API ============

async function searchJooble(keywords, location) {
  if (!JOOBLE_API_KEY) {
    log("Jooble API key not configured, skipping");
    return [];
  }

  const url = `https://jooble.org/api/${JOOBLE_API_KEY}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keywords,
        location,
        page: "1",
        searchMode: 1,
      }),
    });

    if (!response.ok) {
      log(`Jooble API error for "${keywords}": ${response.status}`);
      return [];
    }

    const data = await response.json();
    return (data.jobs || []).map((job) => ({
      externalId: String(
        job.id ||
          `jooble-${Buffer.from(job.link || job.title)
            .toString("base64")
            .slice(0, 32)}`
      ),
      source: "jooble",
      title: job.title,
      company: job.company || "Unknown",
      location: job.location || location,
      salary: job.salary || undefined,
      url: job.link,
      description: job.snippet || "",
      postedDate: job.updated || undefined,
    }));
  } catch (error) {
    log(`Jooble fetch failed for "${keywords}": ${error.message}`);
    return [];
  }
}

// ============ Deduplication ============

function normalize(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function dedupeKey(job) {
  return `${normalize(job.title)}|${normalize(job.company)}|${normalize(job.location)}`;
}

function deduplicateJobs(jobs) {
  const seen = new Map();
  for (const job of jobs) {
    const key = dedupeKey(job);
    if (!seen.has(key)) {
      seen.set(key, job);
    }
  }
  return Array.from(seen.values());
}

// ============ Ollama Scoring ============

async function scoreJob(job) {
  const prompt = `Score how likely this candidate would get an INTERVIEW for this job (0-100).

Key factors:
- Seniority match (MOST IMPORTANT): Candidate is a fresh grad. Junior/entry/grad roles = high score. Mid-level = moderate. Senior/Lead/Principal/Manager = very low (0-20) regardless of skill match.
- Skills overlap: Do the candidate's skills match what's required?
- Location: Sydney-based roles score higher.
- Experience gap: Jobs requiring 3+ years commercial experience should score lower.

Use the FULL 0-100 scale:
- 90-100: Perfect match (entry-level, right skills, right location)
- 70-89: Strong match (junior role, most skills align)
- 50-69: Decent match (some skills overlap, acceptable level)
- 30-49: Weak match (mid-level role or few relevant skills)
- 0-20: Poor match (senior/lead/principal/manager role, or wrong field entirely)

CANDIDATE: ${CANDIDATE_PROFILE}

JOB:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Description: ${(job.description || "").substring(0, 1500)}

Reply ONLY with JSON: {"score": <number 0-100>, "reason": "<one sentence>"}`;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 150,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    const data = await response.json();
    const result = JSON.parse(data.response);
    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    return { score, reason: result.reason || "" };
  } catch (error) {
    log(`Ollama scoring failed for "${job.title}": ${error.message}`);
    return null;
  }
}

// ============ Server POST ============

async function sendToServer(jobs) {
  try {
    const response = await fetch(DISCOVER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": JOBSYNC_API_KEY,
      },
      body: JSON.stringify({ jobs }),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`Server returned ${response.status}: ${text}`);
      return false;
    }

    const result = await response.json();
    log(`Server response: ${JSON.stringify(result)}`);
    return true;
  } catch (error) {
    log(`Failed to send to server: ${error.message}`);
    return false;
  }
}

// ============ Main ============

async function main() {
  // Ensure log directory exists
  if (!fs.existsSync(JOBSYNC_DIR)) {
    fs.mkdirSync(JOBSYNC_DIR, { recursive: true });
  }

  log("=== JobSync Discover starting ===");
  log(`Dry run: ${DRY_RUN}, Top N: ${TOP_N}, Max days old: ${DISCOVER_MAX_DAYS_OLD}`);

  if (!JOBSYNC_API_KEY && !DRY_RUN) {
    log("ERROR: JOBSYNC_API_KEY not set");
    process.exit(1);
  }

  // Step 1: Fetch jobs from both APIs across all queries
  log("Fetching jobs from Adzuna and Jooble...");
  const allJobs = [];

  for (const query of SEARCH_QUERIES) {
    log(`  Searching: "${query}" in ${SEARCH_LOCATION}`);
    const [adzunaJobs, joobleJobs] = await Promise.all([
      searchAdzuna(query, SEARCH_LOCATION, DISCOVER_MAX_DAYS_OLD),
      searchJooble(query, SEARCH_LOCATION),
    ]);
    log(`    Adzuna: ${adzunaJobs.length}, Jooble: ${joobleJobs.length}`);
    allJobs.push(...adzunaJobs, ...joobleJobs);
  }

  log(`Total fetched: ${allJobs.length}`);

  // Step 2: Deduplicate
  const uniqueJobs = deduplicateJobs(allJobs);
  log(`After dedup: ${uniqueJobs.length}`);

  // Step 2b: Filter out seniority-mismatched titles
  const TITLE_BLOCKLIST = /\b(senior|sr\.?|lead|principal|staff|director|head of|vp|manager)\b/i;
  const filtered = uniqueJobs.filter((job) => {
    if (TITLE_BLOCKLIST.test(job.title)) {
      log(`  Filtered: ${job.title} (seniority mismatch)`);
      return false;
    }
    return true;
  });
  log(`After seniority filter: ${filtered.length} (removed ${uniqueJobs.length - filtered.length})`);

  if (filtered.length === 0) {
    log("No jobs found. Exiting.");
    return;
  }

  // Step 3: Score each job with Ollama (concurrency = 2)
  log("Scoring jobs with Ollama...");
  const scored = await runWithConcurrency(
    filtered,
    async (job, idx, total) => {
      const shortTitle = job.title.substring(0, 50);
      log(`  [${idx + 1}/${total}] Scoring: ${shortTitle}`);
      const result = await scoreJob(job);
      if (result) {
        log(`    -> ${result.score}/100: ${result.reason}`);
        return { ...job, matchScore: result.score, matchReason: result.reason };
      }
      return { ...job, matchScore: 0, matchReason: "scoring failed" };
    },
    2
  );

  // Filter out errors and sort by score
  const validScored = scored
    .filter((r) => r && !r.error)
    .sort((a, b) => b.matchScore - a.matchScore);

  // Step 4: Take top N
  const topJobs = validScored.slice(0, TOP_N);
  log(`Top ${topJobs.length} jobs:`);
  for (const job of topJobs) {
    log(`  ${job.matchScore}/100 | ${job.title} @ ${job.company} (${job.source})`);
  }

  // Step 5: POST to server (unless dry run)
  if (DRY_RUN) {
    log("DRY RUN — not posting to server");
    return;
  }

  // Prepare payload (strip matchReason, keep matchScore)
  const payload = topJobs.map(({ matchReason, ...rest }) => rest);

  log(`Sending ${payload.length} jobs to ${DISCOVER_API_URL}...`);
  const success = await sendToServer(payload);
  if (success) {
    log("=== Discover sync completed successfully ===");
  } else {
    log("=== Discover sync FAILED ===");
    process.exit(1);
  }
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
