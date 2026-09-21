import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type { SourceDocument } from "../types.js";

export interface ContentFetcher {
  fetch(url: string): Promise<SourceDocument>;
}

const DEFAULT_HEADERS = {
  "user-agent":
    "JevResearch/0.1 (local-first research; respectful fetch)",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
};

export class HttpContentFetcher implements ContentFetcher {
  constructor(private readonly timeoutMs = 20_000) {}

  async fetch(url: string): Promise<SourceDocument> {
    const retrievedAt = new Date().toISOString();
    const publisher = safeHost(url);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(url, {
        redirect: "follow",
        headers: DEFAULT_HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 401 || res.status === 403 || res.status === 407) {
        return {
          url,
          title: publisher ?? url,
          publisher,
          text: "",
          retrievedAt,
          fetchStatus: "blocked",
          error: `Access restricted (HTTP ${res.status}). Paywalls and auth walls are not bypassed.`,
        };
      }

      if (!res.ok) {
        return {
          url,
          title: publisher ?? url,
          publisher,
          text: "",
          retrievedAt,
          fetchStatus: "failed",
          error: `HTTP ${res.status}`,
        };
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!/html|text|xml/i.test(contentType) && contentType) {
        return {
          url,
          title: publisher ?? url,
          publisher,
          text: "",
          retrievedAt,
          fetchStatus: "failed",
          error: `Unsupported content-type: ${contentType}`,
        };
      }

      const html = await res.text();
      const extracted = extractReadable(html, url);
      if (!extracted.text || extracted.text.trim().length < 80) {
        return {
          url,
          title: extracted.title || publisher || url,
          publisher,
          publishedAt: extracted.publishedAt,
          text: extracted.text,
          retrievedAt,
          fetchStatus: "empty",
          error: "Could not extract useful article text.",
        };
      }

      return {
        url,
        title: extracted.title || publisher || url,
        publisher,
        publishedAt: extracted.publishedAt,
        text: extracted.text.slice(0, 40_000),
        retrievedAt,
        fetchStatus: "ok",
      };
    } catch (err) {
      return {
        url,
        title: publisher ?? url,
        publisher,
        text: "",
        retrievedAt,
        fetchStatus: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export class StaticContentFetcher implements ContentFetcher {
  constructor(private readonly docs: Record<string, SourceDocument>) {}
  async fetch(url: string): Promise<SourceDocument> {
    const doc = this.docs[url];
    if (doc) return { ...doc };
    return {
      url,
      title: url,
      text: "",
      retrievedAt: new Date().toISOString(),
      fetchStatus: "failed",
      error: "Not in static fetcher map",
    };
  }
}

export function extractReadable(
  html: string,
  url: string,
): { title: string; text: string; publishedAt?: string } {
  const { document } = parseHTML(html);
  // Readability expects a browser-like document; linkedom is sufficient for MVP.
  const reader = new Readability(document as unknown as Document, {
    charThreshold: 40,
  });
  const article = reader.parse();
  const title =
    article?.title?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    safeHost(url) ||
    url;
  const text = (article?.textContent || stripTags(html)).replace(/\s+\n/g, "\n").trim();
  const publishedAt =
    document.querySelector("meta[property='article:published_time']")?.getAttribute("content") ||
    document.querySelector("time[datetime]")?.getAttribute("datetime") ||
    undefined;
  return { title, text, publishedAt: publishedAt ?? undefined };
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
