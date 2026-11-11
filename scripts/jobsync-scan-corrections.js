#!/usr/bin/env node
/**
 * Superseded: owner corrections are handled by jobsync-mail-classify.js.
 *
 * The Emacs mail poll (~/.emacs.d/elisp/email-config.el, email-sync-all)
 * still runs this file in the foreground right after `notmuch new`, so it now
 * runs the classifier there: corrections, new mail, and the send to
 * jobs.abaj.ai. Because the poll's shell waits for it, it is not cut off when
 * the poll finishes, which is what happens to the copy the notmuch post-new
 * hook starts in the background. If that copy holds the lock, this one waits
 * for it (or takes over a dead holder's lock), so the work always gets done.
 * Arguments are passed through (for example --dry-run).
 */
// Wait for the hook's copy rather than exit: if that copy is cut off, its
// lock is taken over (dead pid) and this run does the work. At most 15 minutes.
if (!process.argv.includes("--wait-lock")) process.argv.push("--wait-lock", "900");
process.env.JOBSYNC_VIA = process.env.JOBSYNC_VIA || "emacs-poll";
require("./jobsync-mail-classify.js").cli();
