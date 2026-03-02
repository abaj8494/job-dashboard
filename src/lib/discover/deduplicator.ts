import { DiscoverJobResult } from "./types";

function normalize(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
}

function dedupeKey(job: DiscoverJobResult): string {
  return `${normalize(job.title)}|${normalize(job.company)}|${normalize(job.location)}`;
}

export function deduplicateJobs(
  jobs: DiscoverJobResult[]
): DiscoverJobResult[] {
  const seen = new Map<string, DiscoverJobResult>();

  for (const job of jobs) {
    const key = dedupeKey(job);
    if (!seen.has(key)) {
      seen.set(key, job);
    }
  }

  return Array.from(seen.values());
}
