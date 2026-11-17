/**
 * @jest-environment node
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const sounds = require("../scripts/lib/sounds");

const NOW = new Date(2026, 10, 18, 10, 0, 0); // 10:00 local
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);
const LIVE_TAGS = ["inbox", "unread", "new"];

function config(over = {}) {
  return sounds.loadSoundConfig({ env: {}, configFile: "/nonexistent", platform: "darwin", ...over });
}

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on() {}, unref() { calls[calls.length - 1].unref = true; } };
  };
  fn.calls = calls;
  return fn;
}

describe("soundKind", () => {
  it("maps offer and rejection to their own sounds and other job mail to job", () => {
    expect(sounds.soundKind("offer")).toBe("offer");
    expect(sounds.soundKind("rejection")).toBe("rejection");
    for (const t of ["job_application", "job_response", "interview", "follow_up"]) expect(sounds.soundKind(t)).toBe("job");
    expect(sounds.soundKind("other")).toBeNull();
  });
});

describe("isLive", () => {
  it("accepts unread inbox mail dated in the last 48 hours", () => {
    expect(sounds.isLive({ tags: LIVE_TAGS, date: hoursAgo(0.1) }, { now: NOW })).toBe(true);
    expect(sounds.isLive({ tags: LIVE_TAGS, date: hoursAgo(30) }, { now: NOW })).toBe(true);
  });
  it("rejects backfill-old, read, archived, trashed, sent and owner mail", () => {
    expect(sounds.isLive({ tags: LIVE_TAGS, date: hoursAgo(49) }, { now: NOW })).toBe(false);
    expect(sounds.isLive({ tags: ["inbox"], date: hoursAgo(0.1) }, { now: NOW })).toBe(false);
    expect(sounds.isLive({ tags: ["unread"], date: hoursAgo(0.1) }, { now: NOW })).toBe(false);
    expect(sounds.isLive({ tags: [...LIVE_TAGS, "trash"], date: hoursAgo(0.1) }, { now: NOW })).toBe(false);
    expect(sounds.isLive({ tags: [...LIVE_TAGS, "sent"], date: hoursAgo(0.1) }, { now: NOW })).toBe(false);
    expect(sounds.isLive({ tags: LIVE_TAGS, date: hoursAgo(0.1), isOutbound: true }, { now: NOW })).toBe(false);
  });
  it("honours maxAgeHours and rejects bad or far-future dates", () => {
    expect(sounds.isLive({ tags: LIVE_TAGS, date: hoursAgo(3) }, { now: NOW, maxAgeHours: 2 })).toBe(false);
    expect(sounds.isLive({ tags: LIVE_TAGS, date: "not a date" }, { now: NOW })).toBe(false);
    expect(sounds.isLive({ tags: LIVE_TAGS, date: hoursAgo(-0.5) }, { now: NOW })).toBe(true);
    expect(sounds.isLive({ tags: LIVE_TAGS, date: hoursAgo(-2) }, { now: NOW })).toBe(false);
  });
});

describe("inQuietHours", () => {
  it("wraps past midnight, inclusive", () => {
    for (const h of [23, 0, 3, 8]) expect(sounds.inQuietHours(h, "23-8")).toBe(true);
    for (const h of [9, 12, 22]) expect(sounds.inQuietHours(h, "23-8")).toBe(false);
  });
  it("handles a same-day range and none", () => {
    expect(sounds.inQuietHours(13, "12-14")).toBe(true);
    expect(sounds.inQuietHours(15, "12-14")).toBe(false);
    expect(sounds.inQuietHours(3, "")).toBe(false);
  });
});

describe("pickHighest", () => {
  it("offer beats rejection beats other job mail", () => {
    const items = [{ id: "a", kind: "job" }, { id: "b", kind: "rejection" }, { id: "c", kind: "offer" }, { id: "d", kind: "job" }];
    expect(sounds.pickHighest(items).id).toBe("c");
    expect(sounds.pickHighest(items.filter((i) => i.kind !== "offer")).id).toBe("b");
    expect(sounds.pickHighest([])).toBeNull();
  });
});

describe("loadSoundConfig", () => {
  it("defaults: Hero + spoken words for an offer, Basso for a rejection, Hero for other job mail", () => {
    const c = config();
    expect(c.enabled).toBe(true);
    expect(path.basename(c.sound.offer)).toBe("Hero.aiff");
    expect(c.say.offer).toBe("Job offer");
    expect(path.basename(c.sound.rejection)).toBe("Basso.aiff");
    expect(path.basename(c.sound.job)).toBe("Hero.aiff");
    expect(c.sound.rejection).not.toBe(c.sound.offer);
    expect(c.quiet).toBe("23-8");
    expect(c.maxAgeHours).toBe(48);
  });
  it("reads JOBSYNC_SOUND* from the config file; the environment wins; off clears", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobsync-sounds-"));
    const file = path.join(dir, "config");
    fs.writeFileSync(
      file,
      'export JOBSYNC_SOUND_REJECTION="/x/Funk.aiff"\nexport JOBSYNC_SAY_OFFER=off\nexport JOBSYNC_SOUND_QUIET=off\nexport JOBSYNC_SOUND_MAX_AGE_HOURS=6\n',
    );
    const c = sounds.loadSoundConfig({ env: { JOBSYNC_SOUND_JOB: "/y/Ping.aiff" }, configFile: file, platform: "darwin" });
    expect(c.sound.rejection).toBe("/x/Funk.aiff");
    expect(c.sound.job).toBe("/y/Ping.aiff");
    expect(c.say.offer).toBe("");
    expect(c.quiet).toBe("");
    expect(c.maxAgeHours).toBe(6);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("is off with JOBSYNC_SOUNDS=off and off the Mac", () => {
    expect(config({ env: { JOBSYNC_SOUNDS: "off" } }).enabled).toBe(false);
    expect(config({ platform: "linux" }).enabled).toBe(false);
  });
});

describe("playForRun", () => {
  it("plays once, detached, for the most important item", () => {
    const spawnFn = fakeSpawn();
    const logs = [];
    const r = sounds.playForRun(
      [{ id: "m1", kind: "job" }, { id: "m2", kind: "offer" }, { id: "m3", kind: "rejection" }],
      { config: config(), now: NOW, log: (l) => logs.push(l), spawnFn },
    );
    expect(r).toMatchObject({ played: true, kind: "offer", id: "m2" });
    expect(spawnFn.calls).toHaveLength(1);
    const { cmd, args, opts, unref } = spawnFn.calls[0];
    expect(cmd).toBe("/bin/sh");
    expect(args.slice(-2)).toEqual(["/System/Library/Sounds/Hero.aiff", "Job offer"]);
    expect(args[1]).toContain("/usr/bin/afplay");
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toBe(true);
    expect(logs).toEqual(["sound offer for m2: afplay Hero.aiff + say (3 live job mail)"]);
  });
  it("plays the declined sound for a rejection, with no words", () => {
    const spawnFn = fakeSpawn();
    const r = sounds.playForRun([{ id: "m3", kind: "rejection" }], { config: config(), now: NOW, spawnFn });
    expect(r.kind).toBe("rejection");
    expect(spawnFn.calls[0].args.slice(-2)).toEqual(["/System/Library/Sounds/Basso.aiff", ""]);
  });
  it("is silent in quiet hours, when off, and with nothing live", () => {
    const spawnFn = fakeSpawn();
    const logs = [];
    const night = new Date(2026, 10, 18, 0, 40);
    expect(sounds.playForRun([{ id: "m", kind: "offer" }], { config: config(), now: night, log: (l) => logs.push(l), spawnFn }).reason).toBe("quiet");
    expect(sounds.playForRun([{ id: "m", kind: "offer" }], { config: config({ env: { JOBSYNC_SOUNDS: "off" } }), now: NOW, spawnFn }).reason).toBe("off");
    expect(sounds.playForRun([], { config: config(), now: NOW, spawnFn }).played).toBe(false);
    expect(spawnFn.calls).toHaveLength(0);
    expect(logs).toEqual(["sound offer for m skipped: quiet hours 23-8"]);
  });
});
