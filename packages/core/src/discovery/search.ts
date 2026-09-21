import { DdgError, search as ddgSearch } from "ddg-kit";
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

function mergeUnique(batches: SearchResult[][], maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const batch of batches) {
    for (const item of batch) {
      const key = normalizeUrlKey(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= maxResults) return out;
    }
  }
  return out;
}

const FETCH_HEADERS = {
  "user-agent": "JevResearch/0.1 (local-first research; respectful discovery)",
  accept: "application/rss+xml, application/xml, text/xml, application/json, text/html;q=0.8,*/*;q=0.5",
};

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

/** Official DuckDuckGo Instant Answer JSON API — weaker recall, rarely bot-challenged. */
export class DuckDuckGoInstantAnswerProvider implements SearchProvider {
  readonly name = "duckduckgo-ia";

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 25;
    const url =
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}` +
      `&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`DuckDuckGo Instant Answer HTTP ${res.status}`);
    const data = (await res.json()) as {
      AbstractURL?: string;
      AbstractText?: string;
      Heading?: string;
      RelatedTopics?: Array<
        | { Text?: string; FirstURL?: string; Result?: string }
        | { Name?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }
      >;
    };

    const raw: SearchResult[] = [];
    if (data.AbstractURL && data.Heading) {
      const n = normalizeSearchResult({
        title: data.Heading,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        source: "duckduckgo-ia",
      });
      if (n) raw.push(n);
    }

    const topics = flattenRelatedTopics(data.RelatedTopics ?? []);
    for (const topic of topics) {
      const n = normalizeSearchResult({
        title: topic.Text || topic.FirstURL,
        url: topic.FirstURL,
        snippet: topic.Text,
        source: "duckduckgo-ia",
      });
      if (n) raw.push(n);
    }

    return mergeUnique([raw], maxResults);
  }
}

function flattenRelatedTopics(
  topics: Array<
    | { Text?: string; FirstURL?: string }
    | { Name?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }
  >,
): Array<{ Text?: string; FirstURL?: string }> {
  const out: Array<{ Text?: string; FirstURL?: string }> = [];
  for (const item of topics) {
    if ("FirstURL" in item && item.FirstURL) {
      out.push(item);
      continue;
    }
    if ("Topics" in item && Array.isArray(item.Topics)) {
      for (const nested of item.Topics) out.push(nested);
    }
  }
  return out;
}

export class GoogleNewsRssSearchProvider implements SearchProvider {
  readonly name = "google-news-rss";

  constructor(
    private readonly locales: Array<{ hl: string; gl: string; ceid: string }> = [
      { hl: "en-US", gl: "US", ceid: "US:en" },
      { hl: "el", gl: "GR", ceid: "GR:el" },
      { hl: "en-GB", gl: "GB", ceid: "GB:en" },
    ],
  ) {}

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 25;
    const batches: SearchResult[][] = [];
    for (const locale of this.locales) {
      try {
        batches.push(await this.searchLocale(query, locale, maxResults));
      } catch {
        /* try next locale */
      }
    }
    return mergeUnique(batches, maxResults);
  }

  private async searchLocale(
    query: string,
    locale: { hl: string; gl: string; ceid: string },
    maxResults: number,
  ): Promise<SearchResult[]> {
    const url =
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}` +
      `&hl=${encodeURIComponent(locale.hl)}` +
      `&gl=${encodeURIComponent(locale.gl)}` +
      `&ceid=${encodeURIComponent(locale.ceid)}`;
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`Google News RSS HTTP ${res.status}`);
    const xml = await res.text();
    return parseGoogleNewsRss(xml, maxResults);
  }
}

export function parseGoogleNewsRss(xml: string, maxResults = 25): SearchResult[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const out: SearchResult[] = [];
  for (const item of items) {
    const title = decodeXml(extractTag(item, "title") ?? "");
    const link = decodeXml(extractTag(item, "link") ?? "");
    const pubDate = extractTag(item, "pubDate") ?? undefined;
    const source = decodeXml(extractTag(item, "source") ?? "") || undefined;
    const description = decodeXml(stripTags(extractTag(item, "description") ?? ""));
    const normalized = normalizeSearchResult({
      title,
      url: link,
      snippet: description || source,
      source: source || "google-news",
      publishedAt: pubDate,
    });
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= maxResults) break;
  }
  return out;
}

export class WikipediaOpenSearchProvider implements SearchProvider {
  readonly name = "wikipedia";

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    const maxResults = Math.min(options?.maxResults ?? 10, 20);
    const url =
      `https://en.wikipedia.org/w/api.php?action=opensearch` +
      `&search=${encodeURIComponent(query)}&limit=${maxResults}&namespace=0&format=json`;
    const res = await fetch(url, {
      headers: { ...FETCH_HEADERS, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Wikipedia OpenSearch HTTP ${res.status}`);
    const data = (await res.json()) as [string, string[], string[], string[]];
    const titles = data[1] ?? [];
    const descriptions = data[2] ?? [];
    const links = data[3] ?? [];
    const out: SearchResult[] = [];
    for (let i = 0; i < titles.length; i++) {
      const normalized = normalizeSearchResult({
        title: titles[i],
        url: links[i],
        snippet: descriptions[i],
        source: "wikipedia",
      });
      if (normalized) out.push(normalized);
    }
    return out;
  }
}

/**
 * Tries DuckDuckGo HTML search first; on bot-challenge / hard failure,
 * falls back to Google News RSS, DuckDuckGo Instant Answer, and Wikipedia.
 */
export class ResilientSearchProvider implements SearchProvider {
  readonly name = "resilient";

  constructor(
    private readonly primary: SearchProvider = new DuckDuckGoSearchProvider(),
    private readonly fallbacks: SearchProvider[] = [
      new GoogleNewsRssSearchProvider(),
      new DuckDuckGoInstantAnswerProvider(),
      new WikipediaOpenSearchProvider(),
    ],
  ) {}

  async search(query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
    const maxResults = options?.maxResults ?? 25;
    const errors: string[] = [];

    try {
      const primary = await this.primary.search(query, { maxResults });
      if (primary.length > 0) return primary;
      errors.push(`${this.primary.name}: no results`);
    } catch (err) {
      errors.push(`${this.primary.name}: ${formatSearchError(err)}`);
    }

    const batches: SearchResult[][] = [];
    for (const provider of this.fallbacks) {
      try {
        const batch = await provider.search(query, { maxResults });
        if (batch.length > 0) batches.push(batch);
        else errors.push(`${provider.name}: no results`);
      } catch (err) {
        errors.push(`${provider.name}: ${formatSearchError(err)}`);
      }
    }

    const merged = mergeUnique(batches, maxResults);
    if (merged.length > 0) return merged;

    throw new Error(
      `All discovery providers failed for query "${query}". ${errors.join(" | ")}`,
    );
  }
}

export class StaticSearchProvider implements SearchProvider {
  readonly name = "static";
  constructor(private readonly results: SearchResult[]) {}
  async search(): Promise<SearchResult[]> {
    return this.results.map((r) => ({ ...r }));
  }
}

export function formatSearchError(err: unknown): string {
  if (err instanceof DdgError) {
    if (err.code === "BOT_CHALLENGE") {
      return "Provider returned a bot challenge (falling back to other sources)";
    }
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function extractTag(xml: string, tag: string): string | null {
  const cdata = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i"));
  if (cdata?.[1] !== undefined) return cdata[1].trim();
  const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return plain?.[1]?.trim() ?? null;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
