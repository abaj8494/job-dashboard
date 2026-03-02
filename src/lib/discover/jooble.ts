import { DiscoverJobResult, DiscoverSearchParams } from "./types";

interface JoobleJob {
  title: string;
  location: string;
  snippet: string;
  salary: string;
  source: string;
  type: string;
  link: string;
  company: string;
  updated: string;
  id: string;
}

interface JoobleResponse {
  totalCount: number;
  jobs: JoobleJob[];
}

export async function searchJooble(
  params: DiscoverSearchParams
): Promise<DiscoverJobResult[]> {
  const apiKey = process.env.JOOBLE_API_KEY;

  if (!apiKey) {
    console.warn("Jooble API key not configured");
    return [];
  }

  const url = `https://jooble.org/api/${apiKey}`;

  const body = {
    keywords: params.keywords,
    location: params.location,
    page: (params.page || 1).toString(),
    searchMode: 1,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error(`Jooble API error: ${response.status} ${response.statusText}`);
    return [];
  }

  const data: JoobleResponse = await response.json();

  return (data.jobs || []).map((job) => ({
    externalId: String(job.id || `jooble-${Buffer.from(job.link || job.title).toString("base64").slice(0, 32)}`),
    source: "jooble" as const,
    title: job.title,
    company: job.company || "Unknown",
    location: job.location,
    salary: job.salary || undefined,
    url: job.link,
    description: job.snippet,
    postedDate: job.updated ? new Date(job.updated) : undefined,
  }));
}
