import { DiscoverJobResult, DiscoverSearchParams } from "./types";

interface AdzunaResult {
  id: string;
  title: string;
  company: { display_name: string };
  location: { display_name: string };
  salary_min?: number;
  salary_max?: number;
  redirect_url: string;
  description: string;
  created: string;
}

interface AdzunaResponse {
  results: AdzunaResult[];
  count: number;
}

export async function searchAdzuna(
  params: DiscoverSearchParams
): Promise<DiscoverJobResult[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const apiKey = process.env.ADZUNA_API_KEY;

  if (!appId || !apiKey) {
    console.warn("Adzuna API credentials not configured");
    return [];
  }

  const page = params.page || 1;
  const resultsPerPage = params.resultsPerPage || 25;
  const maxDaysOld = params.maxDaysOld || 3;

  const searchParams = new URLSearchParams({
    app_id: appId,
    app_key: apiKey,
    results_per_page: resultsPerPage.toString(),
    what: params.keywords,
    where: params.location,
    max_days_old: maxDaysOld.toString(),
    sort_by: "date",
    content_type: "application/json",
  });

  const url = `https://api.adzuna.com/v1/api/jobs/au/search/${page}?${searchParams}`;

  const response = await fetch(url);

  if (!response.ok) {
    console.error(`Adzuna API error: ${response.status} ${response.statusText}`);
    return [];
  }

  const data: AdzunaResponse = await response.json();

  return data.results.map((result) => {
    const salary =
      result.salary_min && result.salary_max
        ? `$${Math.round(result.salary_min).toLocaleString()} - $${Math.round(result.salary_max).toLocaleString()}`
        : result.salary_min
          ? `$${Math.round(result.salary_min).toLocaleString()}`
          : undefined;

    return {
      externalId: result.id.toString(),
      source: "adzuna" as const,
      title: result.title,
      company: result.company.display_name,
      location: result.location.display_name,
      salary,
      url: result.redirect_url,
      description: result.description,
      postedDate: new Date(result.created),
    };
  });
}
