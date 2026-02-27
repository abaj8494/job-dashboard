/**
 * Classification Rules — Fast-Path Only
 *
 * Source-specific regex for SEEK, LinkedIn, and Indeed job board confirmations.
 * These have rigid email formats with structured data extraction that Ollama
 * can't match. Everything else goes through Ollama classification.
 */

const CLASSIFICATION_TYPES = [
  "job_application",
  "job_response",
  "interview",
  "rejection",
  "offer",
  "follow_up",
  "other"
];

// =============================================================================
// FAST-PATH RULES — Source-specific patterns only
// =============================================================================

const CLASSIFICATION_RULES = {
  // -------------------------------------------------------------------------
  // OTHER — Only SEEK job-alert rule (prevents SEEK digests from being
  // misclassified as applications by the job_application SEEK rule below)
  // -------------------------------------------------------------------------
  other: [
    { field: "from", pattern: /seek/i, condition: (e) => /save your search|matching jobs delivered/i.test(e.subject), reason: "seek-job-alert" },
  ],

  // -------------------------------------------------------------------------
  // JOB_APPLICATION — SEEK/LinkedIn/Indeed confirmations with extraction
  // These are from job boards confirming the USER submitted an application
  // -------------------------------------------------------------------------
  job_application: [
    // SEEK application confirmations - with extraction
    {
      field: "from",
      pattern: /seek/i,
      condition: (e) => /application.*(successfully )?(submitted|sent)/i.test(e.subject),
      reason: "seek-confirmation",
      extract: (e) => {
        const text = e.textBody || "";
        // Use [\s\S]+? for job title to match across line breaks
        // Company is on same line as "submitted to", so use .+ (single-line)
        const patterns = [
          /application for\s+([\s\S]+?)\s+was\s+(?:successfully\s+)?submitted\s+to\s+(.+)/im,
          /your\s+application\s+for\s+([\s\S]+?)\s+(?:has been|was)\s+(?:successfully\s+)?submitted\s+to\s+(.+)/im,
          /submitted\s+(?:your\s+)?application\s+for\s+([\s\S]+?)\s+to\s+(.+)/im,
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            return {
              jobTitle: match[1].trim().replace(/\s+/g, ' '),
              company: match[2].trim().replace(/\s+/g, ' '),
              source: 'SEEK'
            };
          }
        }
        return { source: 'SEEK' };
      }
    },
    { field: "subject", pattern: /your application was successfully submitted/i, reason: "seek-submitted" },

    // LinkedIn application confirmations
    {
      field: "from",
      pattern: /linkedin/i,
      condition: (e) => /you applied|your application was sent|application submitted/i.test(e.subject),
      reason: "linkedin-confirmation",
      extract: (e) => {
        const text = e.textBody || "";
        const match = text.match(/(?:you )?applied (?:for )?(.+?)\s+at\s+(.+?)(?:\.|!|\n|$)/im);
        if (match) {
          return {
            jobTitle: match[1].trim().replace(/\s+/g, ' '),
            company: match[2].trim().replace(/\s+/g, ' '),
            source: 'LinkedIn'
          };
        }
        return { source: 'LinkedIn' };
      }
    },

    // Indeed application confirmations
    {
      field: "from",
      pattern: /indeed/i,
      condition: (e) => /your application was sent|application submitted|you applied/i.test(e.subject),
      reason: "indeed-confirmation",
      extract: (e) => ({ source: 'Indeed' })
    },
  ],
};

/**
 * Rule-based fast-path classifier
 * Returns { type, confidence, reason, ruleMatched: true, extractedData? } or null
 * Only catches SEEK/LinkedIn/Indeed — everything else goes to Ollama
 */
function classifyByRules(email) {
  const fields = {
    from: email.from?.toLowerCase() || "",
    to: email.to?.toLowerCase() || "",
    subject: email.subject?.toLowerCase() || "",
    senderName: email.fromName?.toLowerCase() || "",
    textBody: email.textBody || "",
    isOutbound: email.isOutbound ? "true" : "false",
  };

  // Check rules in priority order: other first (SEEK alerts), then job_application
  const checkOrder = ["other", "job_application"];

  for (const type of checkOrder) {
    const rules = CLASSIFICATION_RULES[type] || [];
    for (const rule of rules) {
      const fieldValue = fields[rule.field] || "";
      if (rule.pattern.test(fieldValue)) {
        if (rule.condition && !rule.condition(email)) {
          continue;
        }

        const extractedData = rule.extract ? rule.extract(email) : {};

        return {
          type,
          confidence: 0.95,
          reason: rule.reason,
          ruleMatched: true,
          extractedData,
        };
      }
    }
  }

  return null; // No rule matched, needs Ollama
}

/**
 * All corrections are high-variance now since regex rarely matches.
 * Almost all emails go through Ollama, so all corrections are useful for few-shot learning.
 */
function isHighVarianceCorrection() {
  return true;
}

/**
 * Convert HTML to plain text (fallback when email has no text/plain part)
 */
function htmlToText(html) {
  if (!html) return "";

  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, '"')
    .replace(/&ldquo;/gi, '"')
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map(line => line.trim())
    .join("\n")
    .trim();
}

module.exports = {
  CLASSIFICATION_TYPES,
  CLASSIFICATION_RULES,
  classifyByRules,
  isHighVarianceCorrection,
  htmlToText,
};
