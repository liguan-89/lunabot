// A local template library: package documents kept as files under DATA_DIR/templates/. Saving
// parses the document exactly as an import would, so a stored template is always installable.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, packageSummary, parsePackageDocument, type PackageDocument } from "./bot-package.ts";

export const TEMPLATE_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface TemplateEntry {
  slug: string;
  savedAt: string;
  summary: ReturnType<typeof packageSummary>;
}

export function templateSlug(name: string): string | null {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
  return TEMPLATE_SLUG.test(slug) ? slug : null;
}

function templateFile(dir: string, slug: string): string {
  return join(dir, `${slug}.json`);
}

export function listTemplates(dir: string): TemplateEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: TemplateEntry[] = [];
  for (const name of names) {
    const slug = name.replace(/\.json$/, "");
    if (!TEMPLATE_SLUG.test(slug) || !name.endsWith(".json")) continue;
    try {
      const document = parsePackageDocument(storedDocument(JSON.parse(readFileSync(join(dir, name), "utf8"))));
      entries.push({ slug, savedAt: savedAtOf(JSON.parse(readFileSync(join(dir, name), "utf8"))), summary: packageSummary(document) });
    } catch {
      // A file the current build cannot read is skipped, never fatal to the list.
    }
  }
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Files written before `savedAt`/`document` were wrapped still parse: a bare document is its own store record. */
function storedDocument(record: unknown): unknown {
  return record && typeof record === "object" && "document" in record ? (record as { document: unknown }).document : record;
}

function savedAtOf(record: unknown): string {
  const savedAt = (record as { savedAt?: unknown }).savedAt;
  return typeof savedAt === "string" ? savedAt : "";
}

/** Parses and normalizes the document exactly like an import, then writes it atomically under its slug. */
export function saveTemplate(dir: string, document: unknown, name?: string): TemplateEntry {
  const parsed = parsePackageDocument(document);
  const slug = templateSlug(name ?? parsed.package.name);
  if (!slug) throw new Error("The template needs a name that letters and digits can spell.");
  mkdirSync(dir, { recursive: true });
  const savedAt = new Date().toISOString();
  const file = templateFile(dir, slug);
  writeFileSync(`${file}.tmp`, JSON.stringify({ savedAt, document: JSON.parse(canonicalJson(parsed)) }));
  renameSync(`${file}.tmp`, file);
  return { slug, savedAt, summary: packageSummary(parsed) };
}

export function readTemplate(dir: string, slug: string): PackageDocument | null {
  if (!TEMPLATE_SLUG.test(slug)) return null;
  try {
    return parsePackageDocument(storedDocument(JSON.parse(readFileSync(templateFile(dir, slug), "utf8"))));
  } catch {
    return null;
  }
}

export function deleteTemplate(dir: string, slug: string): boolean {
  if (!TEMPLATE_SLUG.test(slug)) return false;
  try {
    rmSync(templateFile(dir, slug));
    return true;
  } catch {
    return false;
  }
}
