/**
 * Comprehensive Email Data Extraction Rules
 *
 * Extracts: company, jobTitle, location, applicationUrl, source, jobType
 * Uses regex patterns first, with LLM fallback for complex cases.
 */

// Australian cities for location detection
const AUSTRALIAN_CITIES = [
  "Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Canberra",
  "Gold Coast", "Newcastle", "Hobart", "Darwin", "Wollongong", "Geelong",
  "Townsville", "Cairns", "Toowoomba", "Ballarat", "Bendigo", "Albury",
  "Launceston", "Mackay", "Rockhampton", "Bunbury", "Bundaberg",
  // Common suburbs/areas
  "Parramatta", "North Sydney", "Chatswood", "Macquarie Park", "Olympic Park",
  "CBD", "Inner West", "Eastern Suburbs", "Northern Beaches",
  "South Melbourne", "Richmond", "Docklands", "St Kilda", "Fitzroy",
  "Fortitude Valley", "South Bank", "West End",
];

// Australian states
const AUSTRALIAN_STATES = [
  "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT",
  "New South Wales", "Victoria", "Queensland", "Western Australia",
  "South Australia", "Tasmania", "Australian Capital Territory", "Northern Territory",
];

// Job types
const JOB_TYPES = {
  "full-time": ["full-time", "full time", "fulltime", "ft", "permanent full"],
  "part-time": ["part-time", "part time", "parttime", "pt"],
  "contract": ["contract", "contractor", "fixed term", "fixed-term"],
  "casual": ["casual"],
  "temporary": ["temporary", "temp"],
  "internship": ["internship", "intern"],
  "graduate": ["graduate", "grad program", "graduate program", "new grad"],
  "apprenticeship": ["apprenticeship", "apprentice", "traineeship", "trainee"],
};

// Job board sources
const JOB_SOURCES = {
  "SEEK": ["seek.com.au", "seek.com", "@seek"],
  "LinkedIn": ["linkedin.com", "@linkedin"],
  "Indeed": ["indeed.com", "@indeed", "indeedassessments"],
  "Greenhouse": ["greenhouse.io", "@greenhouse"],
  "Workday": ["workday.com", "myworkday.com", "@myworkday"],
  "Lever": ["lever.co", "@lever"],
  "SmartRecruiters": ["smartrecruiters.com", "@smartrecruiters"],
  "iCIMS": ["icims.com", "@icims"],
  "Jobvite": ["jobvite.com", "@jobvite"],
  "Taleo": ["taleo.net", "@taleo"],
  "Jora": ["jora.com", "@jora"],
  "CareerOne": ["careerone.com.au", "@careerone"],
  "GradConnection": ["gradconnection.com", "@gradconnection"],
  "Prosple": ["prosple.com", "@prosple"],
  "APSJobs": ["apsjobs.gov.au", "@apsjobs"],
  "Hatch": ["hatch.team", "@hatch"],
};

/**
 * Source-specific extraction patterns
 */
const SOURCE_PATTERNS = {
  // SEEK
  seek: {
    company: [
      /application for .+? was (?:successfully )?submitted to (.+?)(?:\.|$)/im,
      /applied (?:for|to) .+? at (.+?)(?:\.|$)/im,
    ],
    jobTitle: [
      /application for (.+?) was (?:successfully )?submitted/im,
      /applied (?:for|to) (.+?) at/im,
    ],
  },

  // LinkedIn
  linkedin: {
    company: [
      /application (?:was )?sent to (.+?)(?:\.|$)/im,
      /applied to (.+?) on LinkedIn/im,
      /(.+?) is reviewing your application/im,
      /(.+?) viewed your application/im,
      /application to (.+?)(?:\.|$)/im,
    ],
    jobTitle: [
      /application for (.+?) (?:was )?sent/im,
      /applied for (.+?) at/im,
      /(.+?) role at/im,
      /position:?\s*(.+?)(?:\n|$)/im,
    ],
  },

  // Indeed
  indeed: {
    company: [
      /application to (.+?)(?:\.|$)/im,
      /applied to (.+?) for/im,
      /(.+?) has received your application/im,
    ],
    jobTitle: [
      /applied to .+? for (.+?)(?:\.|$)/im,
      /application for (.+?) at/im,
    ],
  },

  // Greenhouse
  greenhouse: {
    company: [
      /thank(?:s| you) for applying to (.+?)(?:\.|!|$)/im,
      /application (?:for|to|at) (?:.+? at )?(.+?)(?:\.|$)/im,
      /(.+?) - Application/im,
    ],
    jobTitle: [
      /applying (?:for|to) (?:the )?(.+?) (?:position|role|opportunity)/im,
      /application for (?:the )?(.+?) (?:at|position|role)/im,
      /position:?\s*(.+?)(?:\n|$)/im,
    ],
  },

  // Workday
  workday: {
    company: [
      /thank(?:s| you) for (?:your )?interest in (.+?)(?:\.|!|$)/im,
      /on your (.+?) Application/im,
      /(.+?) - Application/im,
      /(.+?) Careers/im,
    ],
    jobTitle: [
      // "for applying for the role of [Job Title]. We'll"
      /for applying for the role of (.+?)\.\s*We/im,
      // "for applying for the role of [Job Title]"
      /for applying for the (?:role|position) of (.+?)(?:\.|!|$)/im,
      // "position of [Job Title]" with stop words
      /position of\s*(?:&nbsp;)?(.+?)(?:\s*(?:&nbsp;)?(?:with|at)\s|\.|\s*–|$)/im,
      // "role of [Job Title]" with stop words
      /role of\s*(.+?)(?:\.\s*We|\s*with\s|\.|\s*–|$)/im,
      // "role: [Job Title]" or "job: [Job Title]"
      /(?:role|job|position):?\s*(.+?)(?:\n|$)/im,
    ],
  },

  // Lever
  lever: {
    company: [
      /thank(?:s| you) for applying to (.+?)(?:\.|!|$)/im,
      /application (?:to|at) (.+?)(?:\.|$)/im,
    ],
    jobTitle: [
      /applying for (?:the )?(.+?) (?:position|role)/im,
      /application for (?:the )?(.+?)(?:\.|$)/im,
    ],
  },
};

/**
 * Generic extraction patterns (used when source-specific patterns fail)
 */
const GENERIC_PATTERNS = {
  company: [
    // "Thank you for applying to/at [Company]"
    /thank(?:s| you)(?: for)? (?:applying|your (?:interest|application)) (?:to|at|with) (.+?)(?:\.|!|$)/im,
    // "[Company] has received your application"
    /(.+?) has received your application/im,
    // "Your application to [Company]"
    /your application (?:to|at|with) (.+?)(?:\.|$)/im,
    // "Application for ... at [Company]"
    /application for .+? at (.+?)(?:\.|$)/im,
    // "[Company] - Application" (subject line pattern)
    /^(.+?) - (?:Application|Thank you|Your application)/im,
    // "at [Company]" in body
    /(?:position|role|job|opportunity) at (.+?)(?:\.|,|$)/im,
    // From name often contains company name
    // Will be handled separately
  ],

  jobTitle: [
    // "for applying for the role of [Job Title]. We'll" (Accenture/Workday pattern)
    /for applying for the role of (.+?)\.\s*We['']ll/im,
    // "for applying for the role of [Job Title]" (general)
    /for applying for (?:the )?(?:role|position) (?:of )?(.+?)(?:\.|!|$)/im,
    // "Thank you for applying for [Job Title]" (not "the role of")
    /thank(?:s| you) for applying for (?:the )?(?!role|position)(.+?)(?:\.|!| at)/im,
    // "Application for [Job Title]"
    /application for (?:the )?(?:position of )?(.+?)(?:\.|!| at| has| was)/im,
    // "position of [Job Title]. We'll" (Accenture/Workday pattern)
    /position of\s*(?:&nbsp;)?(.+?)(?:\.\s*We['']ll|\s*with\s)/im,
    // "position of [Job Title]" (general)
    /position of\s*(?:&nbsp;)?(.+?)(?:\.|\s*(?:&nbsp;)?(?:with|at)\s)/im,
    // "the [Job Title] role/position"
    /the (.+?) (?:role|position|opportunity)/im,
    // "[Job Title] at [Company]"
    /(?:applying for|applied for|application for) (?:the )?(.+?) at/im,
    // "Role: [Job Title]"
    /(?:role|position|job|title):?\s*(.+?)(?:\n|$)/im,
  ],

  location: [
    // "Location: [City]"
    /location:?\s*(.+?)(?:\n|$)/im,
    // "based in [City]"
    /based in (.+?)(?:\.|,|$)/im,
    // "[City], [State]"
    new RegExp(`(${AUSTRALIAN_CITIES.join("|")})(?:,?\\s*(?:${AUSTRALIAN_STATES.join("|")}))?`, "i"),
    // "in [City]"
    new RegExp(`(?:position|role|job|office|located) in (${AUSTRALIAN_CITIES.join("|")})`, "i"),
  ],

  applicationUrl: [
    // URLs containing job-related paths
    /(https?:\/\/[^\s<>"]+(?:\/jobs?\/|\/careers?\/|\/apply|\/application|\/position)[^\s<>"]*)/i,
    // Generic URLs in body (less specific)
    /(https?:\/\/[^\s<>"]+)/i,
  ],
};

/**
 * Determine the job source from email metadata
 */
function detectSource(email) {
  const from = (email.from || email.fromEmail || "").toLowerCase();
  const subject = (email.subject || "").toLowerCase();
  const body = (email.textBody || email.bodyText || "").toLowerCase();

  for (const [source, patterns] of Object.entries(JOB_SOURCES)) {
    for (const pattern of patterns) {
      if (from.includes(pattern) || subject.includes(pattern)) {
        return source;
      }
    }
  }

  // Check body for source mentions
  for (const [source, patterns] of Object.entries(JOB_SOURCES)) {
    for (const pattern of patterns) {
      if (body.includes(pattern)) {
        return source;
      }
    }
  }

  return null;
}

/**
 * Detect job type from text
 */
function detectJobType(text) {
  const lowerText = (text || "").toLowerCase();

  for (const [type, patterns] of Object.entries(JOB_TYPES)) {
    for (const pattern of patterns) {
      if (lowerText.includes(pattern)) {
        return type;
      }
    }
  }

  return null;
}

/**
 * Extract location from text
 */
function extractLocation(text) {
  const combinedText = text || "";

  for (const pattern of GENERIC_PATTERNS.location) {
    const match = combinedText.match(pattern);
    if (match && match[1]) {
      return cleanExtractedValue(match[1]);
    }
  }

  return null;
}

/**
 * Extract application URL from text
 */
function extractApplicationUrl(text) {
  const combinedText = text || "";

  for (const pattern of GENERIC_PATTERNS.applicationUrl) {
    const match = combinedText.match(pattern);
    if (match && match[1]) {
      const url = match[1];
      // Filter out unsubscribe, tracking, and image URLs
      if (
        !url.includes("unsubscribe") &&
        !url.includes("tracking") &&
        !url.includes(".png") &&
        !url.includes(".jpg") &&
        !url.includes(".gif") &&
        !url.includes("privacy") &&
        !url.includes("mailto:")
      ) {
        return url;
      }
    }
  }

  return null;
}

/**
 * Clean extracted value
 */
function cleanExtractedValue(value) {
  if (!value) return null;

  return value
    .trim()
    // Remove HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, "")
    // Remove trailing punctuation
    .replace(/[.,!?;:]+$/, "")
    // Remove quotes
    .replace(/^["']|["']$/g, "")
    // Remove extra whitespace
    .replace(/\s+/g, " ")
    // Remove common suffixes that get captured
    .replace(/\s*(?:Pty Ltd|Ltd|Inc|LLC|Corp|Corporation)\.?$/i, "")
    // Remove "Hiring" or "Careers" suffix from company names
    .replace(/\s*(?:Hiring|Careers|Recruiting|Talent|Jobs)$/i, "")
    .trim();
}

/**
 * Try to extract company from sender name
 */
function extractCompanyFromSender(email) {
  const fromName = email.fromName || "";

  // Common patterns: "Company Careers", "Company Recruiting", "Company Talent"
  const senderPatterns = [
    /^(.+?) (?:Careers|Recruiting|Talent|HR|Jobs|Hiring|Team)$/i,
    /^(.+?) (?:via|from) /i,
  ];

  for (const pattern of senderPatterns) {
    const match = fromName.match(pattern);
    if (match && match[1]) {
      return cleanExtractedValue(match[1]);
    }
  }

  // If from name looks like a company (not a person's name)
  // Person names usually have 2-3 words and don't contain Inc, etc.
  if (fromName && !fromName.match(/^[A-Z][a-z]+ [A-Z][a-z]+$/)) {
    // Likely a company name
    return cleanExtractedValue(fromName);
  }

  return null;
}

/**
 * Main extraction function using regex patterns
 */
function extractByRules(email) {
  const subject = email.subject || "";
  const body = email.textBody || email.bodyText || "";
  const combinedText = `${subject}\n${body}`;

  const result = {
    company: null,
    jobTitle: null,
    location: null,
    applicationUrl: null,
    source: null,
    jobType: null,
  };

  // Detect source first
  result.source = detectSource(email);

  // Get source-specific patterns
  const sourceKey = result.source?.toLowerCase().replace(/\s+/g, "");
  const sourcePatterns = SOURCE_PATTERNS[sourceKey] || {};

  // Try source-specific patterns first for company
  if (sourcePatterns.company) {
    for (const pattern of sourcePatterns.company) {
      const match = combinedText.match(pattern);
      if (match && match[1]) {
        result.company = cleanExtractedValue(match[1]);
        break;
      }
    }
  }

  // Fall back to generic patterns for company
  if (!result.company) {
    for (const pattern of GENERIC_PATTERNS.company) {
      const match = combinedText.match(pattern);
      if (match && match[1]) {
        result.company = cleanExtractedValue(match[1]);
        break;
      }
    }
  }

  // Try extracting company from sender name
  if (!result.company) {
    result.company = extractCompanyFromSender(email);
  }

  // Try source-specific patterns for job title
  if (sourcePatterns.jobTitle) {
    for (const pattern of sourcePatterns.jobTitle) {
      const match = combinedText.match(pattern);
      if (match && match[1]) {
        result.jobTitle = cleanExtractedValue(match[1]);
        break;
      }
    }
  }

  // Fall back to generic patterns for job title
  if (!result.jobTitle) {
    for (const pattern of GENERIC_PATTERNS.jobTitle) {
      const match = combinedText.match(pattern);
      if (match && match[1]) {
        result.jobTitle = cleanExtractedValue(match[1]);
        break;
      }
    }
  }

  // Extract other fields
  result.location = extractLocation(combinedText);
  result.applicationUrl = extractApplicationUrl(body);
  result.jobType = detectJobType(combinedText);

  return result;
}

/**
 * LLM extraction prompt for when regex fails
 */
function buildExtractionPrompt(email) {
  const subject = email.subject || "(No subject)";
  const from = email.fromName ? `${email.fromName} <${email.from || email.fromEmail}>` : (email.from || email.fromEmail);
  const body = (email.textBody || email.bodyText || "").substring(0, 3000);

  return `Extract job application details from this email. Return ONLY valid JSON.

From: ${from}
Subject: ${subject}

Body:
${body}

Extract these fields (use null if not found):
- company: The company name (employer, not job board)
- jobTitle: The specific job title/position
- location: City or location mentioned
- source: Job board used (SEEK, LinkedIn, Indeed, etc.) or null
- jobType: One of: full-time, part-time, contract, casual, temporary, internship, graduate, or null

Respond ONLY with JSON:
{"company":"...","jobTitle":"...","location":"...","source":"...","jobType":"..."}`;
}

/**
 * Parse LLM response
 */
function parseLLMResponse(response) {
  try {
    // Try to find JSON in the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        company: parsed.company || null,
        jobTitle: parsed.jobTitle || null,
        location: parsed.location || null,
        source: parsed.source || null,
        jobType: parsed.jobType || null,
        applicationUrl: parsed.applicationUrl || null,
      };
    }
  } catch (e) {
    // Ignore parse errors
  }
  return null;
}

/**
 * Merge extracted data, preferring non-null values
 */
function mergeExtractedData(existing, newData) {
  const result = { ...existing };

  for (const key of Object.keys(newData)) {
    if (newData[key] && !result[key]) {
      result[key] = newData[key];
    }
  }

  return result;
}

/**
 * Check if extraction is complete (has company and jobTitle at minimum)
 */
function isExtractionComplete(data) {
  return !!(data.company && data.jobTitle);
}

/**
 * Check if extraction needs LLM fallback
 */
function needsLLMFallback(data) {
  return !data.company || !data.jobTitle;
}

module.exports = {
  extractByRules,
  buildExtractionPrompt,
  parseLLMResponse,
  mergeExtractedData,
  isExtractionComplete,
  needsLLMFallback,
  detectSource,
  detectJobType,
  extractLocation,
  extractApplicationUrl,
  AUSTRALIAN_CITIES,
  AUSTRALIAN_STATES,
  JOB_TYPES,
  JOB_SOURCES,
};
