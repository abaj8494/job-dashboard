/**
 * Shared Classification Rules
 *
 * Used by both local-sync and corrections scanner to determine
 * if a classification can be handled by rules (vs needs LLM).
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
// RULE-BASED CLASSIFIER
// Catches ~100 obvious patterns before falling back to Ollama
// =============================================================================

const CLASSIFICATION_RULES = {
  // -------------------------------------------------------------------------
  // OTHER (not job-related) - most common, check first
  // -------------------------------------------------------------------------
  other: [
    // Job alert digests (NOT applications or responses)
    { field: "from", pattern: /jobnotification@/i, reason: "job-alert-sender" },
    { field: "from", pattern: /jobs2web\.com/i, reason: "job-alert-sender" },
    { field: "from", pattern: /job-alerts@linkedin\.com/i, reason: "linkedin-job-alert" },
    { field: "subject", pattern: /^(your )?(job alert|new jobs? posted)/i, reason: "job-alert-subject" },
    { field: "subject", pattern: /jobs? (from|at|posted)/i, reason: "job-alert-subject" },
    { field: "senderName", pattern: /job alerts?/i, reason: "job-alert-sender-name" },
    { field: "subject", pattern: /top jobs from/i, reason: "job-alert-subject" },
    { field: "from", pattern: /seek.*grad|gradconnection/i, reason: "job-alert" },

    // LinkedIn notifications (non-job)
    { field: "from", pattern: /@linkedin\.com$/i, condition: (e) => /job alerts?/i.test(e.fromName || ""), reason: "linkedin-alert" },

    // GitHub
    { field: "from", pattern: /@github\.com$/i, reason: "github" },
    { field: "from", pattern: /noreply@github\.com/i, reason: "github" },
    { field: "subject", pattern: /\[.*\/.*\] (pull request|issue|push|comment)/i, reason: "github-notification" },

    // Google security/DMARC
    { field: "from", pattern: /noreply-dmarc-support@google\.com/i, reason: "dmarc" },
    { field: "subject", pattern: /^(security alert|dmarc.*report)/i, reason: "security-alert" },
    { field: "subject", pattern: /report domain:.*submitter:/i, reason: "dmarc" },
    { field: "from", pattern: /dmarc.*report|dmarc-support/i, reason: "dmarc" },

    // E-commerce/Services
    { field: "from", pattern: /@amazon\.(com|co|com\.au)/i, reason: "ecommerce" },
    { field: "from", pattern: /@costco/i, reason: "retail" },
    { field: "from", pattern: /@garmin\./i, reason: "service" },
    { field: "from", pattern: /@vultr\./i, reason: "hosting" },
    { field: "from", pattern: /@kickstarter\./i, reason: "crowdfunding" },
    { field: "from", pattern: /@ebay\./i, reason: "ecommerce" },
    { field: "from", pattern: /@paypal\./i, reason: "payments" },
    { field: "from", pattern: /@netflix\./i, reason: "streaming" },
    { field: "from", pattern: /@spotify\./i, reason: "streaming" },

    // Marketing/newsletters
    { field: "from", pattern: /mailchimp|mcsv\.net/i, reason: "marketing" },
    { field: "from", pattern: /@sendgrid\./i, reason: "marketing" },
    { field: "subject", pattern: /^(don't miss|final hours|last chance)/i, reason: "marketing" },
    { field: "subject", pattern: /unsubscribe|newsletter/i, reason: "marketing" },
    { field: "from", pattern: /huggingface|hugging.*face/i, condition: (e) => !/job|career|apply/i.test(e.subject), reason: "tech-newsletter" },

    // Slack (non-job unless onboarding context)
    { field: "from", pattern: /@slack\.com$/i, condition: (e) => !/onboard|welcome.*team/i.test(e.subject), reason: "slack-general" },

    // Microsoft Learn / general newsletters
    { field: "from", pattern: /@microsoft\.com$/i, condition: (e) => /learning goals|microsoft learn/i.test(e.subject), reason: "newsletter" },

    // IBM marketing (not job responses)
    { field: "from", pattern: /ibm.*avature/i, condition: (e) => /tips|webinar|event|join.*day/i.test(e.subject), reason: "ibm-marketing" },

    // Government reporting (not job apps)
    { field: "from", pattern: /workforce.*australia|dewr\.gov/i, reason: "govt-reporting" },

    // Personal/sent emails with personal content markers
    { field: "subject", pattern: /^(fwd:|re:)?\s*(yo|hey|sup|running late|pdf|\.pdf$)/i, reason: "personal" },
    { field: "subject", pattern: /^(fwd:|re:)?\s*\w+\s+(video|song|music|watch this)/i, reason: "personal-share" },

    // Veterinary/pets
    { field: "from", pattern: /vet|veterinary|petbarn|pet.*hospital/i, reason: "pet-services" },

    // Recruitment spam (Outlier, Turing generic outreach)
    { field: "from", pattern: /outlier.*ai|@privateemail\.com/i, condition: (e) => /action required|invitation|matches.*job/i.test(e.subject), reason: "recruitment-spam" },
    { field: "subject", pattern: /🕊️.*action required.*invitation/i, reason: "recruitment-spam" },

    // Event invitations (not interview)
    { field: "subject", pattern: /webinar|event.*registration|join.*session/i, condition: (e) => !/interview|screen|assessment/i.test(e.subject), reason: "event-invite" },
    { field: "subject", pattern: /go beyond human limits|days? to go:/i, reason: "event-promo" },
  ],

  // -------------------------------------------------------------------------
  // JOB_RESPONSE (application confirmations)
  // -------------------------------------------------------------------------
  job_response: [
    // Thank you for applying patterns (note: "thankyou" can be one word)
    { field: "subject", pattern: /thank(s| ?you|you) for (your )?(apply|application|interest)/i, reason: "thank-you-applying" },
    { field: "subject", pattern: /we('ve| have) received your application/i, reason: "received-application" },
    { field: "subject", pattern: /application (received|submitted|complete|acknowledged)/i, reason: "application-received" },
    { field: "subject", pattern: /your application (for|to|at|with)/i, reason: "your-application" },
    { field: "subject", pattern: /thanks for applying/i, reason: "thanks-applying" },
    { field: "subject", pattern: /thank you for your interest in/i, reason: "thank-interest" },

    // Workday/ATS confirmations
    { field: "from", pattern: /@.*workday/i, condition: (e) => /thank|received|application/i.test(e.subject), reason: "workday-confirmation" },
    { field: "from", pattern: /recruitment@|careers@|talent@|hiring@/i, condition: (e) => /thank|received|confirm/i.test(e.subject), reason: "recruitment-confirmation" },
    { field: "from", pattern: /greenhouse|lever|icims|jobvite|smartrecruiters/i, condition: (e) => /thank|received|apply/i.test(e.subject), reason: "ats-confirmation" },

    // Specific company patterns
    { field: "subject", pattern: /we got it.*in the mix/i, reason: "canva-confirmation" },
    { field: "subject", pattern: /application viewed/i, reason: "application-viewed" },
    { field: "subject", pattern: /verify your candidate (account|profile)/i, reason: "account-verify" },
    { field: "subject", pattern: /good move|you('re| are) in the mix/i, reason: "confirmation-positive" },
    { field: "subject", pattern: /your.*journey begins/i, reason: "journey-begins" },
    { field: "subject", pattern: /job application acknowledgment/i, reason: "acknowledgment" },
    { field: "subject", pattern: /registration confirmation/i, condition: (e) => /recruit|career|talent/i.test(e.from), reason: "recruitment-registration" },
    { field: "subject", pattern: /welcome to.*careers/i, reason: "careers-welcome" },

    // Boeing/springboard specific
    { field: "from", pattern: /springboard\.com\.au/i, condition: (e) => /application|reference/i.test(e.subject), reason: "springboard-confirmation" },

    // NinjaTech, Neara, etc.
    { field: "subject", pattern: /received your job application/i, reason: "received-job-app" },
  ],

  // -------------------------------------------------------------------------
  // INTERVIEW (invitations and scheduling)
  // -------------------------------------------------------------------------
  interview: [
    { field: "subject", pattern: /interview (invite|invitation|confirm|schedule)/i, reason: "interview-invite" },
    { field: "subject", pattern: /phone screen/i, reason: "phone-screen" },
    { field: "subject", pattern: /you('re| are) invited.*(interview|screen|call|assessment)/i, reason: "invited-interview" },
    { field: "subject", pattern: /schedule.*(interview|call|meeting)/i, reason: "schedule-interview" },
    { field: "subject", pattern: /invitation:.*interview/i, reason: "calendar-interview" },
    { field: "subject", pattern: /(technical|coding) (assessment|challenge|test)/i, reason: "assessment" },
    { field: "subject", pattern: /skills.*assessment/i, reason: "skills-assessment" },
    { field: "subject", pattern: /role alignment discussion/i, reason: "alignment-call" },
    { field: "subject", pattern: /talent introduction session/i, reason: "intro-session" },
    { field: "subject", pattern: /in-person.*(assessment|interview|meeting)/i, reason: "in-person-interview" },
    { field: "subject", pattern: /online.*(assessment|interview|discussion)/i, reason: "online-interview" },
    { field: "subject", pattern: /video (interview|call|screen)/i, reason: "video-interview" },
    { field: "subject", pattern: /next.*round|round.*interview/i, reason: "next-round" },
    { field: "subject", pattern: /meet.*team|team.*meet/i, condition: (e) => /interview|hire|recruit/i.test(e.from), reason: "team-meet" },
    { field: "subject", pattern: /^invitation:/i, condition: (e) => /interview|screen|assessment|call/i.test(e.subject), reason: "calendar-invite" },
  ],

  // -------------------------------------------------------------------------
  // REJECTION (application outcomes - negative)
  // -------------------------------------------------------------------------
  rejection: [
    { field: "subject", pattern: /application outcome/i, condition: (e) => !/thank|received/i.test(e.subject), reason: "outcome-likely-rejection" },
    { field: "subject", pattern: /outcome of your application/i, reason: "outcome" },
    { field: "subject", pattern: /unsuccessful.*application/i, reason: "unsuccessful" },
    { field: "subject", pattern: /update.*application/i, condition: (e) => /regret|unfortunately|unable|ineligible|not.*proceed|not.*successful/i.test(e.textBody?.substring(0, 500) || ""), reason: "rejection-update" },
    { field: "subject", pattern: /we('ve| have) reviewed your application/i, reason: "reviewed-likely-rejection" },
    { field: "subject", pattern: /not (be )?(moving|proceed|progress)ing forward/i, reason: "not-proceeding" },
    { field: "subject", pattern: /regret to inform/i, reason: "regret" },
    { field: "subject", pattern: /role update|position.*update/i, condition: (e) => !/interview|schedule/i.test(e.subject), reason: "role-update-rejection" },
    { field: "subject", pattern: /application.*status|status.*application/i, condition: (e) => /close|filled|not.*selected/i.test(e.textBody?.substring(0, 500) || ""), reason: "status-rejection" },
    { field: "subject", pattern: /thank you for.*interest/i, condition: (e) => /unfortunately|regret|unable|ineligible|not.*time|other candidates/i.test(e.textBody?.substring(0, 500) || ""), reason: "polite-rejection" },
  ],

  // -------------------------------------------------------------------------
  // FOLLOW_UP (reminders, next steps)
  // -------------------------------------------------------------------------
  follow_up: [
    { field: "subject", pattern: /reminder:.*application/i, reason: "application-reminder" },
    { field: "subject", pattern: /next steps/i, condition: (e) => !/(thank|received)/i.test(e.subject), reason: "next-steps" },
    { field: "subject", pattern: /finish your application/i, reason: "finish-application" },
    { field: "subject", pattern: /complete your (application|profile|assessment)/i, reason: "complete-application" },
    { field: "subject", pattern: /waiting for your/i, reason: "waiting" },
    { field: "from", pattern: /codesignal|hackerrank|codility/i, condition: (e) => /reminder|waiting|complete/i.test(e.subject), reason: "assessment-reminder" },
    { field: "subject", pattern: /assessment (completed|submitted)/i, reason: "assessment-completed" },
    { field: "subject", pattern: /recruiters.*looking|profile.*view/i, reason: "profile-activity" },
    { field: "subject", pattern: /what('s| is) next/i, reason: "whats-next" },
    { field: "subject", pattern: /you('ve| have) applied.*what next/i, reason: "applied-next" },
    { field: "subject", pattern: /keep receiving.*email/i, reason: "email-preferences" },
    { field: "subject", pattern: /update on.*recruitment/i, reason: "recruitment-update" },
    { field: "subject", pattern: /take.*step|final.*step/i, condition: (e) => !/interview/i.test(e.subject), reason: "take-step" },
    { field: "from", pattern: /testgorilla/i, condition: (e) => /submitted|next|result/i.test(e.subject), reason: "testgorilla-followup" },
  ],
};

/**
 * Rule-based pre-classifier
 * Returns { type, confidence, reason, ruleMatched: true } or null if no rule matches
 */
function classifyByRules(email) {
  const fields = {
    from: email.from?.toLowerCase() || "",
    subject: email.subject?.toLowerCase() || "",
    senderName: email.fromName?.toLowerCase() || "",
    textBody: email.textBody || "",
  };

  // Check rules in priority order
  const checkOrder = ["other", "interview", "rejection", "job_response", "follow_up"];

  for (const type of checkOrder) {
    const rules = CLASSIFICATION_RULES[type] || [];
    for (const rule of rules) {
      const fieldValue = fields[rule.field] || "";
      if (rule.pattern.test(fieldValue)) {
        // Check additional condition if present
        if (rule.condition && !rule.condition(email)) {
          continue;
        }
        return {
          type,
          confidence: 0.95,
          reason: rule.reason,
          ruleMatched: true,
        };
      }
    }
  }

  return null; // No rule matched, needs Ollama
}

/**
 * Check if a correction is "high variance" (rules wouldn't have caught it)
 * High variance corrections are valuable for few-shot learning
 */
function isHighVarianceCorrection(email, originalType, correctedType) {
  // If rules would classify this email, it's low variance (rules handle it)
  const ruleResult = classifyByRules(email);

  if (ruleResult) {
    // Rules matched - if they got it right, low variance
    // If they got it wrong, that's interesting but we should fix the rules instead
    return false;
  }

  // Rules didn't match - this is a high variance case that needs LLM
  return true;
}

module.exports = {
  CLASSIFICATION_TYPES,
  CLASSIFICATION_RULES,
  classifyByRules,
  isHighVarianceCorrection,
};
