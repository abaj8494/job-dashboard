import { generateObject } from "ai";
import { getModel } from "@/lib/ai/providers";
import {
  EmailClassificationSchema,
  type EmailClassificationResponse,
  type ExtractedJobData,
} from "@/models/ai.schemas";
import {
  EMAIL_CLASSIFICATION_SYSTEM_PROMPT,
  buildEmailClassificationPrompt,
} from "@/lib/ai/prompts/email-classification";
import { type ParsedEmail, getEmailTextContent } from "./parser";

export type { EmailClassificationResponse, ExtractedJobData };

export interface EmailClassification {
  type: EmailClassificationResponse["type"];
  confidence: number;
  reasoning: string;
  extractedData: ExtractedJobData;
}

// Default model for email classification
const DEFAULT_PROVIDER = "ollama" as const;
const DEFAULT_MODEL = "llama3.2";

/**
 * Classify an email using the LLM
 */
export async function classifyEmail(
  email: ParsedEmail,
  options?: {
    provider?: "ollama" | "openai" | "deepseek";
    model?: string;
  }
): Promise<EmailClassification> {
  const provider = options?.provider || DEFAULT_PROVIDER;
  const modelName = options?.model || DEFAULT_MODEL;

  try {
    const model = getModel(provider, modelName);
    const textContent = getEmailTextContent(email);

    const prompt = buildEmailClassificationPrompt({
      subject: email.subject,
      from: email.from,
      to: email.to,
      isOutbound: email.isOutbound,
      bodyText: textContent,
    });

    const result = await generateObject({
      model,
      schema: EmailClassificationSchema,
      system: EMAIL_CLASSIFICATION_SYSTEM_PROMPT,
      prompt,
    });

    return {
      type: result.object.type,
      confidence: result.object.confidence,
      reasoning: result.object.reasoning,
      extractedData: result.object.extractedData,
    };
  } catch (error) {
    console.error("Email classification failed:", error);

    // Return a safe default on error
    return {
      type: "other",
      confidence: 0,
      reasoning: `Classification failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      extractedData: {
        company: null,
        jobTitle: null,
        location: null,
        applicationUrl: null,
        recruiterName: null,
        interviewDate: null,
        deadline: null,
        salaryRange: null,
      },
    };
  }
}

/**
 * Check if classification is job-related (not "other")
 */
export function isJobRelated(classification: EmailClassification): boolean {
  return classification.type !== "other";
}

/**
 * Check if classification meets minimum confidence threshold
 */
export function meetsConfidenceThreshold(
  classification: EmailClassification,
  threshold: number = 0.6
): boolean {
  return classification.confidence >= threshold;
}

/**
 * Get human-readable label for classification type
 */
export function getClassificationLabel(type: EmailClassification["type"]): string {
  const labels: Record<EmailClassification["type"], string> = {
    job_application: "Application Sent",
    job_response: "Application Response",
    interview: "Interview",
    rejection: "Rejection",
    offer: "Job Offer",
    follow_up: "Follow-up",
    other: "Other",
  };
  return labels[type];
}

/**
 * Get status suggestion for job based on email classification
 */
export function getJobStatusSuggestion(type: EmailClassification["type"]): string {
  const statusMap: Record<EmailClassification["type"], string> = {
    job_application: "applied",
    job_response: "applied",
    interview: "interview",
    rejection: "rejected",
    offer: "offer",
    follow_up: "applied",
    other: "draft",
  };
  return statusMap[type];
}
