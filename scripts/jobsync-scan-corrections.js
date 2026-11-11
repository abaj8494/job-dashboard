#!/usr/bin/env node
/**
 * Superseded: owner corrections are handled by jobsync-mail-classify.js.
 *
 * The Emacs mail poll (~/.emacs.d/elisp/email-config.el, email-sync-all)
 * still runs this file in the foreground right after `notmuch new`, so it now
 * runs the classifier there: corrections, new mail, and the send to
 * jobs.abaj.ai. Because the poll's shell waits for it, it is not cut off when
 * the poll finishes, which is what happens to the copy the notmuch post-new
 * hook starts in the background. The lock means only one runs at a time.
 * Arguments are passed through (for example --dry-run).
 */
require("./jobsync-mail-classify.js").cli();
