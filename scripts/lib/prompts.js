/**
 * Claude Classification Prompts
 *
 * Single source of truth for the two-stage email classifier used by
 * jobsync-local-sync, jobsync-reclassify-untagged, jobsync-scan-corrections,
 * jobsync-backfill-metadata and the eval harness.
 *
 * Stage 1 sees metadata only (from, to, subject, date, a short snippet) and
 * must decide whether it is confident. Stage 2 sees the full body and also
 * extracts company / jobTitle / location etc.
 *
 * The system prompt is frozen text plus a deterministic corrections block so
 * behaviour is reproducible run to run. Per-email content goes in the user
 * prompt only.
 */

const { z } = require("zod");
const { CLASSIFICATION_TYPES } = require("./classification-rules");

const SNIPPET_CHARS = 300;
const STAGE2_BODY_CHARS = 8000;
const MAX_CORRECTION_EXAMPLES = 50;

const CLASSIFICATION_SYSTEM_PROMPT = `You classify emails for a personal job-application tracker. The owner of the mailbox is the job seeker. Decide whether each email is part of the owner's job search and, if so, which stage it represents.

## Categories (use exactly one)

- job_application — The ACT of applying. Either (a) outbound: the owner sends an application, cover letter or resume to a company, or (b) inbound: a job board (SEEK, LinkedIn, Indeed, Jora, GradConnection, Prosple, etc.) confirms that the owner's application was SUBMITTED. Phrases: "your application was successfully submitted", "you applied to", "application sent", "I am applying for".
- job_response — The HIRING COMPANY (or its ATS: Greenhouse, Lever, Workday, iCIMS, SmartRecruiters, Ashby, Jobvite, Taleo, BambooHR, Breezy) acknowledges or receives the application. Phrases: "thank you for applying", "we have received your application", "your application has been received", "we'll be in touch", "we are reviewing your application". IMPORTANT: "we have received your application" is job_response, NOT job_application — it is a response FROM the company, not the act of applying.
- interview — Invitation to, or scheduling of, a phone screen, video call, assessment centre, technical test with a live session, or on-site interview. Phrases: "schedule an interview", "your availability", "role alignment discussion", "next steps: interview", calendar invites for interviews.
- rejection — The application is declined or the position is filled. Phrases: "unfortunately", "we will not be moving forward", "decided not to proceed", "position has been filled", "other candidates".
- offer — A job offer or compensation negotiation. Phrases: "pleased to offer", "offer letter", "salary", "compensation package", "contract for signature".
- follow_up — Status updates or requests on an existing application that are none of the above: "checking in", "update on your application", requests for additional documents, reference checks, background checks, onboarding paperwork before an offer is accepted.
- other — Not part of the owner's job search: job alerts and digests ("jobs matching your search", "recommended for you"), recruiter marketing and newsletters, career advice, job-board account notices, event invitations that are not interviews, receipts, personal mail, anything else. Default when the email is not clearly one of the categories above.

## Hard rules

1. Job ALERTS and job RECOMMENDATIONS are "other", even from SEEK/LinkedIn/Indeed. Only a confirmation of an application the owner actually submitted is job_application.
2. Personal mail is "other" even when it mentions jobs (a friend venting about job hunting is not an application). Casual tone, personal addresses on both ends, or social content → other.
3. Automated "we received your application" / "thank you for applying" from a company or ATS is job_response.
4. A job-board "your application was submitted to <Company>" is job_application.
5. An email asking the owner to complete a timed assessment with no human session is follow_up; an invitation to speak with a person is interview.
6. Be conservative between job-related categories: if a job-related email does not clearly fit interview/rejection/offer, prefer job_response (first acknowledgement) or follow_up (later update).

## Confidence

Confidence is your probability that the category is correct, from 0 to 1.
- 0.9–1.0: obvious from the sender and subject alone (job-board confirmations, clear alerts, obvious marketing, obvious personal mail).
- 0.8–0.9: clear but inferred.
- below 0.8: genuinely unsure, the snippet is insufficient, or the sender is a company whose message could be a response, follow-up, interview or rejection.
When you are shown only metadata and a short snippet, do NOT guess between job-related categories: report the lower confidence so the full email is read.

## Reason

One short sentence naming the evidence you used (sender, subject phrase, or body phrase).`;

const STAGE1_INSTRUCTIONS = `You are seeing ONLY metadata and the first ${SNIPPET_CHARS} characters of the email. Classify it and report how confident you are. If the metadata is enough to be sure (clearly unrelated, a clear job alert, a clear job-board submission confirmation), say so with high confidence. If the email is from a company or recruiter and the stage is unclear, use a confidence below 0.8.`;

const STAGE2_INSTRUCTIONS = `You are seeing the full email. Classify it, and if it is job-related extract the details. For extraction:
- company: the actual employer, never the job board or ATS vendor. null if not stated.
- jobTitle: the specific position title as written. null if not stated.
- location: city/state/country or "Remote". null if not stated.
- applicationUrl: a direct link to the job posting or application, if present.
- recruiterName: the named recruiter or hiring contact, if any.
- salaryRange: salary or compensation range if disclosed.
- source: the job board or ATS the email came through (SEEK, LinkedIn, Indeed, Greenhouse, Workday, ...), or null.
- jobType: one of full-time, part-time, contract, casual, temporary, internship, graduate, or null.
Only extract what the email explicitly states. Use null otherwise. If the email is "other", every extraction field is null.`;

/**
 * Deterministic corrections block appended to the system prompt.
 * One compact line per correction so 50 corrections stay ~2k tokens.
 */
function buildCorrectionsBlock(corrections, maxExamples = MAX_CORRECTION_EXAMPLES) {
  if (!Array.isArray(corrections) || corrections.length === 0) return "";

  const recent = corrections.slice(-maxExamples);
  const lines = recent.map((c) => {
    const subject = String(c.subject || "(No subject)").replace(/\s+/g, " ").substring(0, 120);
    const from = String(c.fromName ? `${c.fromName} <${c.from}>` : c.from || "").replace(/\s+/g, " ").substring(0, 80);
    const direction = c.isOutbound ? "SENT" : "RECEIVED";
    return `- was ${c.originalType}, correct is ${c.correctedType} | ${direction} | From: ${from} | Subject: ${subject}`;
  });

  return `\n\n## Owner corrections (ground truth from past mistakes; apply the same judgement to similar mail)\n${lines.join("\n")}`;
}

function buildSystemPrompt(corrections = []) {
  return CLASSIFICATION_SYSTEM_PROMPT + buildCorrectionsBlock(corrections);
}

function cleanLine(value, max = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().substring(0, max);
}

function snippetOf(email, chars = SNIPPET_CHARS) {
  const text = String(email.textBody || email.bodyText || "").replace(/\s+/g, " ").trim();
  return text.substring(0, chars);
}

function headerBlock(email) {
  const date = email.date instanceof Date ? email.date.toISOString() : String(email.date || "");
  const from = email.fromName ? `${cleanLine(email.fromName, 80)} <${cleanLine(email.from || email.fromEmail, 120)}>` : cleanLine(email.from || email.fromEmail, 120);
  return [
    `Direction: ${email.isOutbound ? "SENT by the owner" : "RECEIVED by the owner"}`,
    `From: ${from}`,
    `To: ${cleanLine(email.to || email.toEmail, 120)}`,
    `Subject: ${cleanLine(email.subject, 200)}`,
    `Date: ${date}`,
  ].join("\n");
}

function buildStage1Prompt(email) {
  return `${STAGE1_INSTRUCTIONS}

${headerBlock(email)}
Snippet: ${snippetOf(email) || "(no text body)"}`;
}

function buildStage2Prompt(email) {
  const body = String(email.textBody || email.bodyText || "").trim().substring(0, STAGE2_BODY_CHARS);
  return `${STAGE2_INSTRUCTIONS}

${headerBlock(email)}

Body:
${body || "(no text body)"}`;
}

// ---------------------------------------------------------------------------
// Structured output schemas (zod for validation, JSON Schema for --json-schema)
// ---------------------------------------------------------------------------

const CategorySchema = z.enum(CLASSIFICATION_TYPES);

const Stage1Schema = z.object({
  category: CategorySchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

const ExtractedDataSchema = z.object({
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  location: z.string().nullable(),
  applicationUrl: z.string().nullable(),
  recruiterName: z.string().nullable(),
  salaryRange: z.string().nullable(),
  source: z.string().nullable(),
  jobType: z.string().nullable(),
});

const Stage2Schema = z.object({
  category: CategorySchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  extractedData: ExtractedDataSchema,
});

// The claude CLI's --json-schema validator rejects the "$schema" key zod emits.
function toCliJsonSchema(schema) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

const STAGE1_JSON_SCHEMA = toCliJsonSchema(Stage1Schema);
const STAGE2_JSON_SCHEMA = toCliJsonSchema(Stage2Schema);

module.exports = {
  CLASSIFICATION_SYSTEM_PROMPT,
  STAGE1_INSTRUCTIONS,
  STAGE2_INSTRUCTIONS,
  SNIPPET_CHARS,
  STAGE2_BODY_CHARS,
  buildCorrectionsBlock,
  buildSystemPrompt,
  buildStage1Prompt,
  buildStage2Prompt,
  snippetOf,
  Stage1Schema,
  Stage2Schema,
  ExtractedDataSchema,
  STAGE1_JSON_SCHEMA,
  STAGE2_JSON_SCHEMA,
};
