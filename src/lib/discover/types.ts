export interface DiscoverJobResult {
  externalId: string;
  source: "adzuna" | "jooble";
  title: string;
  company: string;
  location: string;
  salary?: string;
  url?: string;
  description?: string;
  postedDate?: Date;
}

export interface DiscoverSearchParams {
  keywords: string;
  location: string;
  maxDaysOld?: number;
  page?: number;
  resultsPerPage?: number;
  source?: "adzuna" | "jooble" | "both";
}
