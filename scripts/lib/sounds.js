/**
 * Outcome sounds for newly arrived job mail (macOS only).
 *
 * After a classifier run, the most important new job mail plays one sound:
 *   offer      "accepted": Hero, then the spoken words "Job offer"
 *   rejection  "declined": Basso
 *   other job  Hero (application, response, interview, follow-up)
 * One sound per run, offer > rejection > other job, and only for mail that
 * is live: just tagged by this run (not a refile, correction or dry run),
 * unread, in the inbox, not sent by the owner, and dated within the last
 * JOBSYNC_SOUND_MAX_AGE_HOURS (default 48; this keeps a backfill quiet but
 * still covers an account that syncs once a day).
 *
 * Settings, from the environment or ~/.jobsync/config:
 *   JOBSYNC_SOUNDS=off                  no sounds
 *   JOBSYNC_SOUND_OFFER / _REJECTION / _JOB    sound files
 *   JOBSYNC_SAY_OFFER / _REJECTION / _JOB      words spoken after the sound ("off" for none)
 *   JOBSYNC_SOUND_QUIET=23-8            quiet hours, local time, inclusive ("off" for none);
 *                                       the same hours as the mail banners in the post-new hook
 *   JOBSYNC_SOUND_MAX_AGE_HOURS=48
 *
 * The player is started detached, so it is not cut off when the run (or the
 * notmuch hook that started it) exits.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_CONFIG = path.join(process.env.HOME || os.homedir(), ".jobsync", "config");
const SYSTEM_SOUNDS = "/System/Library/Sounds";
const KIND_RANK = { offer: 3, rejection: 2, job: 1 };
const JOB_TYPES = ["job_application", "job_response", "interview", "rejection", "offer", "follow_up"];

const DEFAULTS = {
  sound: {
    offer: `${SYSTEM_SOUNDS}/Hero.aiff`,
    rejection: `${SYSTEM_SOUNDS}/Basso.aiff`,
    job: `${SYSTEM_SOUNDS}/Hero.aiff`,
  },
  say: { offer: "Job offer", rejection: "", job: "" },
  quiet: "23-8",
  maxAgeHours: 48,
};

function configValue(text, name) {
  const re = new RegExp(`^\\s*(?:export\\s+)?${name}=["']?([^"'\\n]*)["']?`, "m");
  const m = re.exec(text);
  return m ? m[1].trim() : "";
}

const isOff = (v) => /^(0|off|false|no|none)$/i.test(String(v).trim());

/** Sound settings from the environment, else ~/.jobsync/config (JOBSYNC_SOUND* and JOBSYNC_SAY_* only). */
function loadSoundConfig({ env = process.env, configFile = DEFAULT_CONFIG, platform = process.platform } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(configFile, "utf8");
  } catch (e) {
    // no config file
  }
  const get = (name) => (env[name] !== undefined && env[name] !== "" ? String(env[name]).trim() : configValue(text, name));
  const pick = (name, fallback) => {
    const v = get(name);
    if (!v) return fallback;
    return isOff(v) ? "" : v;
  };
  const maxAge = parseFloat(get("JOBSYNC_SOUND_MAX_AGE_HOURS"));
  return {
    enabled: platform === "darwin" && !isOff(get("JOBSYNC_SOUNDS") || "on"),
    sound: {
      offer: pick("JOBSYNC_SOUND_OFFER", DEFAULTS.sound.offer),
      rejection: pick("JOBSYNC_SOUND_REJECTION", DEFAULTS.sound.rejection),
      job: pick("JOBSYNC_SOUND_JOB", DEFAULTS.sound.job),
    },
    say: {
      offer: pick("JOBSYNC_SAY_OFFER", DEFAULTS.say.offer),
      rejection: pick("JOBSYNC_SAY_REJECTION", DEFAULTS.say.rejection),
      job: pick("JOBSYNC_SAY_JOB", DEFAULTS.say.job),
    },
    quiet: pick("JOBSYNC_SOUND_QUIET", DEFAULTS.quiet),
    maxAgeHours: maxAge > 0 ? maxAge : DEFAULTS.maxAgeHours,
  };
}

/** offer, rejection or job for a classification type; null for other. */
function soundKind(type) {
  if (type === "offer" || type === "rejection") return type;
  return JOB_TYPES.includes(type) ? "job" : null;
}

/**
 * Live new mail: unread, in the inbox, not trash/spam/sent, not from the
 * owner, and dated within maxAgeHours of now (a little in the future is fine:
 * sender clocks drift).
 */
function isLive({ tags = [], date, isOutbound = false }, { now = new Date(), maxAgeHours = DEFAULTS.maxAgeHours } = {}) {
  const t = new Set(tags);
  if (!t.has("unread") || !t.has("inbox")) return false;
  if (["trash", "spam", "deleted", "sent"].some((x) => t.has(x)) || isOutbound) return false;
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(ms)) return false;
  const age = now.getTime() - ms;
  return age <= maxAgeHours * 3600 * 1000 && age >= -3600 * 1000;
}

/** Whether hour (0-23) falls in "start-end" quiet hours, inclusive, wrapping past midnight. "" = never. */
function inQuietHours(hour, spec) {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec || "");
  if (!m) return false;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  return start <= end ? hour >= start && hour <= end : hour >= start || hour <= end;
}

/** The most important of [{id, kind}], or null. */
function pickHighest(items) {
  let best = null;
  for (const it of items) if (it && KIND_RANK[it.kind] && (!best || KIND_RANK[it.kind] > KIND_RANK[best.kind])) best = it;
  return best;
}

/**
 * Play the sound for the most important live item, at most once.
 * Returns {played, kind, id, reason}. Logs ids and labels only.
 */
function playForRun(items, { config = loadSoundConfig(), now = new Date(), log = () => {}, spawnFn = spawn } = {}) {
  const best = pickHighest(items);
  if (!best) return { played: false, reason: "no live job mail" };
  const tail = `${items.length > 1 ? ` (${items.length} live job mail)` : ""}`;
  if (!config.enabled) {
    log(`sound ${best.kind} for ${best.id} skipped: sounds off${tail}`);
    return { played: false, kind: best.kind, id: best.id, reason: "off" };
  }
  if (inQuietHours(now.getHours(), config.quiet)) {
    log(`sound ${best.kind} for ${best.id} skipped: quiet hours ${config.quiet}${tail}`);
    return { played: false, kind: best.kind, id: best.id, reason: "quiet" };
  }
  const file = config.sound[best.kind];
  const words = config.say[best.kind];
  if (!file && !words) {
    log(`sound ${best.kind} for ${best.id} skipped: no sound set${tail}`);
    return { played: false, kind: best.kind, id: best.id, reason: "unset" };
  }
  // Positional arguments, never interpolated into the script.
  const script = 'if [ -n "$1" ]; then /usr/bin/afplay "$1"; fi; if [ -n "$2" ]; then /usr/bin/say "$2"; fi';
  try {
    const child = spawnFn("/bin/sh", ["-c", script, "jobsync-sound", file || "", words || ""], {
      detached: true,
      stdio: "ignore",
    });
    if (child && typeof child.on === "function") child.on("error", () => {});
    if (child && typeof child.unref === "function") child.unref();
  } catch (e) {
    log(`sound ${best.kind} for ${best.id} failed: ${e.message}`);
    return { played: false, kind: best.kind, id: best.id, reason: "spawn" };
  }
  log(`sound ${best.kind} for ${best.id}: afplay ${file ? path.basename(file) : "-"}${words ? " + say" : ""}${tail}`);
  return { played: true, kind: best.kind, id: best.id, file, say: words };
}

module.exports = { DEFAULTS, loadSoundConfig, soundKind, isLive, inQuietHours, pickHighest, playForRun };
