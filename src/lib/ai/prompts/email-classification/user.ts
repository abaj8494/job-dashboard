interface EmailInput {
  subject: string;
  from: string;
  to: string;
  isOutbound: boolean;
  bodyText: string;
}

/**
 * Build the user prompt for email classification
 */
export function buildEmailClassificationPrompt(email: EmailInput): string {
  const direction = email.isOutbound ? "SENT BY USER (outbound)" : "RECEIVED BY USER (inbound)";

  // Truncate body to avoid token limits
  const maxBodyLength = 3000;
  const truncatedBody = email.bodyText.length > maxBodyLength
    ? email.bodyText.substring(0, maxBodyLength) + "\n[... truncated ...]"
    : email.bodyText;

  return `Analyze this email and classify it as job-related or not.

## EMAIL DETAILS

**Direction:** ${direction}
**From:** ${email.from}
**To:** ${email.to}
**Subject:** ${email.subject}

## EMAIL BODY

${truncatedBody}

---

Classify this email and extract any job-related information. Return your analysis in the required JSON format.`;
}
