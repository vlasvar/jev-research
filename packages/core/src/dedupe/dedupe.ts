import { normalizeUrlKey } from "../discovery/search.js";
import type { SearchResult, SourceDocument } from "../types.js";

export interface DedupeGroup {
  canonical: SearchResult;
  members: SearchResult[];
  reason: "url" | "title" | "content";
}

export function dedupeSearchResults(results: SearchResult[]): {
  unique: SearchResult[];
  groups: DedupeGroup[];
  removedCount: number;
} {
  const groups: DedupeGroup[] = [];
  const unique: SearchResult[] = [];
  const byUrl = new Map<string, SearchResult>();
  const byTitleHost = new Map<string, SearchResult>();

  for (const result of results) {
    const urlKey = normalizeUrlKey(result.url);
    const existingUrl = byUrl.get(urlKey);
    if (existingUrl) {
      attach(groups, existingUrl, result, "url");
      continue;
    }

    const titleKey = `${safeHost(result.url)}::${normalizeTitle(result.title)}`;
    const existingTitle = byTitleHost.get(titleKey);
    if (existingTitle && normalizeTitle(result.title).length > 24) {
      attach(groups, existingTitle, result, "title");
      continue;
    }

    byUrl.set(urlKey, result);
    byTitleHost.set(titleKey, result);
    unique.push(result);
  }

  const removedCount = results.length - unique.length;
  return { unique, groups, removedCount };
}

export function dedupeDocuments(docs: SourceDocument[]): {
  unique: SourceDocument[];
  removedCount: number;
  duplicateMap: Map<string, string>;
} {
  const unique: SourceDocument[] = [];
  const duplicateMap = new Map<string, string>();
  const byUrl = new Map<string, SourceDocument>();
  const byFingerprint = new Map<string, SourceDocument>();

  for (const doc of docs) {
    const urlKey = normalizeUrlKey(doc.url);
    const existingUrl = byUrl.get(urlKey);
    if (existingUrl) {
      duplicateMap.set(doc.url, existingUrl.url);
      continue;
    }

    const fp = contentFingerprint(doc.text);
    const existingFp = fp ? byFingerprint.get(fp) : undefined;
    if (existingFp) {
      duplicateMap.set(doc.url, existingFp.url);
      continue;
    }

    byUrl.set(urlKey, doc);
    if (fp) byFingerprint.set(fp, doc);
    unique.push(doc);
  }

  return {
    unique,
    removedCount: docs.length - unique.length,
    duplicateMap,
  };
}

function attach(
  groups: DedupeGroup[],
  canonical: SearchResult,
  member: SearchResult,
  reason: DedupeGroup["reason"],
): void {
  let group = groups.find((g) => g.canonical.url === canonical.url && g.reason === reason);
  if (!group) {
    group = { canonical, members: [], reason };
    groups.push(group);
  }
  group.members.push(member);
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function contentFingerprint(text: string): string | null {
  const cleaned = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (cleaned.length < 400) return null;
  // Simple shingle-ish fingerprint — no vector DB.
  const slice = cleaned.slice(0, 800);
  let hash = 0;
  for (let i = 0; i < slice.length; i++) {
    hash = (hash * 31 + slice.charCodeAt(i)) >>> 0;
  }
  return `${cleaned.length}:${hash}`;
}
