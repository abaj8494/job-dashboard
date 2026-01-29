export {
  queryNewEmails,
  getMessageIdFromFile,
  markEmailProcessed,
  getNewEmailCount,
  isNotmuchAvailable,
  MONITORED_EMAILS,
  MAILDIR_PATH,
} from "./notmuch";

export {
  parseEmailFile,
  htmlToText,
  getEmailTextContent,
  getEmailDomain,
  isJobBoardDomain,
  type ParsedEmail,
} from "./parser";

export {
  classifyEmail,
  type EmailClassification,
  type ExtractedJobData,
} from "./classifier";
