/**
 * ~/.jobsync/jobs-feed.json: job applications found in mail, read by the
 * JobSync Chrome extension through its native messaging host.
 *
 *   {"version": 1, "updatedAt": ISO, "jobs": [
 *     {"id": "mail-<16 hex>", "title", "company", "location",
 *      "date": "YYYY-MM-DD", "advertised": bool, "messageId"}]}
 *
 * The id is derived from the Message-ID, so one message never makes two jobs.
 * Writes go to a temp file and are renamed into place, so a reader never sees
 * a half-written file. The extension dedupes by id; messageId stays on the Mac
 * (the host does not pass it on).
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_FEED = path.join(process.env.HOME || os.homedir(), ".jobsync", "jobs-feed.json");

function normalizeMessageId(messageId) {
  return String(messageId || "").trim().replace(/^<|>$/g, "");
}

function feedIdFor(messageId) {
  const h = crypto.createHash("sha256").update(normalizeMessageId(messageId)).digest("hex");
  return `mail-${h.slice(0, 16)}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Local calendar date (the Mac's time zone) of a Date or date string. */
function localDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function loadFeed(file = DEFAULT_FEED) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && Array.isArray(data.jobs)) return data;
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`cannot read feed ${file}: ${e.code || "invalid JSON"}`);
  }
  return { version: 1, updatedAt: null, jobs: [] };
}

function saveFeed(feed, file = DEFAULT_FEED, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...feed, version: 1, updatedAt: now.toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Build a feed item from a classified message. Returns null when neither a
 * title nor a company is known (the extension could not show it).
 */
function feedItem(email, extracted) {
  const title = (extracted.jobTitle || "").trim();
  const company = (extracted.company || "").trim();
  if (!title && !company) return null;
  return {
    id: feedIdFor(email.messageId),
    title,
    company,
    location: (extracted.location || "").trim(),
    date: localDate(email.date) || localDate(new Date()),
    advertised: typeof extracted.advertised === "boolean" ? extracted.advertised : true,
    messageId: normalizeMessageId(email.messageId),
  };
}

/** Add items whose id is not present yet. Returns the number added. */
function addToFeed(items, file = DEFAULT_FEED) {
  const feed = loadFeed(file);
  const ids = new Set(feed.jobs.map((j) => j.id));
  let added = 0;
  for (const item of items) {
    if (!item || ids.has(item.id)) continue;
    feed.jobs.push(item);
    ids.add(item.id);
    added++;
  }
  if (added) saveFeed(feed, file);
  return added;
}

/** Remove the job for a message (an application the owner re-tagged). Returns the number removed. */
function removeFromFeed(messageId, file = DEFAULT_FEED) {
  const id = feedIdFor(messageId);
  const feed = loadFeed(file);
  const before = feed.jobs.length;
  feed.jobs = feed.jobs.filter((j) => j.id !== id);
  const removed = before - feed.jobs.length;
  if (removed) saveFeed(feed, file);
  return removed;
}

module.exports = {
  DEFAULT_FEED,
  feedIdFor,
  localDate,
  loadFeed,
  saveFeed,
  feedItem,
  addToFeed,
  removeFromFeed,
};
