import { search as ddgSearch } from "ddg-kit";
import { SearchResultSchema, type SearchResult } from "../types.js";

export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]>;
}

export function normalizeSearchResult(raw: {
  title?: string;
  url?: string;
  href?: string;
  link?: string;
  snippet?: string;
  description?: string;
  source?: string;
  publishedAt?: string;
  date?: string;
}): SearchResult | null {
  const url = raw.url || raw.href || raw.link;
  const title = (raw.title || "").trim();
  if (!url || !title) return null;
  let normalizedUrl: string;
  try {
    const u = new URL(url);
    u.hash = "";
    normalizedUrl = u.toString();
  } catch {
    return null;
  }

  const candidate = {
    title,
    url: normalizedUrl,
    snippet: raw.snippet || raw.description,
    source: raw.source || safeHost(normalizedUrl),
    publishedAt: raw.publishedAt || raw.date,
  };

  const parsed = SearchResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly name = "duckduckgo";

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 25;
    const response = await ddgSearch(query, { maxResults });
    const results: SearchResult[] = [];
    const seen = new Set<string>();

    for (const item of response.results ?? []) {
      const normalized = normalizeSearchResult({
        title: item.title,
        url: item.url,
        snippet: item.description,
      });
      if (!normalized) continue;
      const key = normalizeUrlKey(normalized.url);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(normalized);
      if (results.length >= maxResults) break;
    }

    return results;
  }
}

export class StaticSearchProvider implements SearchProvider {
  readonly name = "static";
  constructor(private readonly results: SearchResult[]) {}
  async search(): Promise<SearchResult[]> {
    return this.results.map((r) => ({ ...r }));
  }
}

export function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let path = u.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    return `${u.protocol}//${u.hostname.replace(/^www\./, "").toLowerCase()}${path}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
