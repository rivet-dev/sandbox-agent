#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOCS_ROOT = path.resolve(__dirname, "..", "..", "docs");
const OUTPUT_ROOT = path.resolve(__dirname, process.env.SKILL_GENERATOR_OUTPUT_ROOT ?? "dist");
const TEMPLATE_PATH = path.resolve(__dirname, "template", "SKILL.md");
const DOCS_BASE_URL = "https://sandboxagent.dev/docs";

type Reference = {
  slug: string;
  title: string;
  description: string;
  canonicalUrl: string;
  referencePath: string;
};

async function main(): Promise<void> {
  if (!fs.existsSync(DOCS_ROOT)) {
    throw new Error(`Docs directory not found at ${DOCS_ROOT}`);
  }

  try {
    await fsp.rm(OUTPUT_ROOT, { recursive: true, force: true });
  } catch (error: any) {
    if (error?.code === "EACCES") {
      throw new Error(
        [
          `Failed to delete skill output directory due to permissions: ${OUTPUT_ROOT}`,
          "",
          "If this directory was created by a different user (for example via Docker), either fix ownership/permissions",
          "or rerun with a different output directory:",
          "",
          '  SKILL_GENERATOR_OUTPUT_ROOT="dist-dev" npx --yes tsx@4.21.0 scripts/skill-generator/generate.ts',
        ].join("\n"),
      );
    }
    throw error;
  }
  await fsp.mkdir(path.join(OUTPUT_ROOT, "references"), { recursive: true });

  const docFiles = await listDocFiles(DOCS_ROOT);
  const references: Reference[] = [];

  for (const filePath of docFiles) {
    const relPath = normalizePath(path.relative(DOCS_ROOT, filePath));
    const raw = await fsp.readFile(filePath, "utf8");
    const { data, body } = parseFrontmatter(raw);

    const slug = toSlug(relPath);
    const canonicalUrl = slug ? `${DOCS_BASE_URL}/${slug}` : DOCS_BASE_URL;
    const title = data.title || titleFromSlug(slug || relPath);
    const description = data.description || "";

    const markdown = convertDocToMarkdown(body);

    const referenceRelPath = `${stripExtension(relPath)}.md`;
    const outputPath = path.join(OUTPUT_ROOT, "references", referenceRelPath);
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });

    const referenceFile = buildReferenceFile({
      title,
      description,
      canonicalUrl,
      sourcePath: `docs/${relPath}`,
      body: markdown,
    });

    await fsp.writeFile(outputPath, referenceFile, "utf8");

    references.push({
      slug,
      title,
      description,
      canonicalUrl,
      referencePath: `references/${referenceRelPath}`,
    });
  }

  const quickstart = references.find((ref) => ref.slug === "quickstart");
  if (!quickstart) {
    throw new Error("Quickstart doc not found. Expected docs/quickstart.mdx");
  }

  const quickstartPath = path.join(DOCS_ROOT, "quickstart.mdx");
  const quickstartRaw = await fsp.readFile(quickstartPath, "utf8");
  const { body: quickstartBody } = parseFrontmatter(quickstartRaw);
  const quickstartContent = convertDocToMarkdown(quickstartBody);

  const referenceMap = buildReferenceMap(references);
  const template = await fsp.readFile(TEMPLATE_PATH, "utf8");

  const skillFile = template
    .replace("{{QUICKSTART}}", quickstartContent)
    .replace("{{REFERENCE_MAP}}", referenceMap);

  await fsp.writeFile(path.join(OUTPUT_ROOT, "SKILL.md"), `${skillFile.trim()}
`, "utf8");

  console.log(`Generated skill files in ${OUTPUT_ROOT}`);
}

async function listDocFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDocFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.mdx?$/.test(entry.name)) continue;
    files.push(fullPath);
  }

  return files;
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  if (!content.startsWith("---")) {
    return { data: {} as Record<string, string>, body: content.trim() };
  }

  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { data: {} as Record<string, string>, body: content.trim() };
  }

  const frontmatter = match[1];
  const body = content.slice(match[0].length);
  const data: Record<string, string> = {};

  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
    data[key] = value;
  }

  return { data, body: body.trim() };
}

function toSlug(relPath: string): string {
  const withoutExt = stripExtension(relPath);
  const normalized = withoutExt.replace(/\\/g, "/");
  if (normalized.endsWith("/index")) {
    return normalized.slice(0, -"/index".length);
  }
  return normalized;
}

function stripExtension(value: string): string {
  return value.replace(/\.mdx?$/i, "");
}

function titleFromSlug(value: string): string {
  const cleaned = value.replace(/\.mdx?$/i, "").replace(/\\/g, "/");
  const parts = cleaned.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || "index";
  return formatSegment(last);
}

function buildReferenceFile(args: {
  title: string;
  description: string;
  canonicalUrl: string;
  sourcePath: string;
  body: string;
}): string {
  const { title, description, canonicalUrl, sourcePath, body } = args;
  const lines = [
    `# ${title}`,
    "",
    `> Source: \`${sourcePath}\``,
    `> Canonical URL: ${canonicalUrl}`,
    `> Description: ${description || ""}`,
    "",
    "---",
    body.trim(),
  ];

  return `${lines.join("\n").trim()}\n`;
}

function buildReferenceMap(references: Reference[]): string {
  const grouped = new Map<string, Reference[]>();
  const groupRoots = new Set<string>();

  for (const ref of references) {
    const segments = (ref.slug || "").split("/").filter(Boolean);
    if (segments.length > 1) {
      groupRoots.add(segments[0]);
    }
  }

  for (const ref of references) {
    const segments = (ref.slug || "").split("/").filter(Boolean);
    let group = "general";
    if (segments.length > 1) {
      group = segments[0];
    } else if (segments.length === 1 && groupRoots.has(segments[0])) {
      group = segments[0];
    }

    const bucket = grouped.get(group);
    if (bucket) {
      bucket.push(ref);
    } else {
      grouped.set(group, [ref]);
    }
  }

  const lines: string[] = [];
  const sortedGroups = [...grouped.keys()].sort((a, b) => a.localeCompare(b));

  for (const group of sortedGroups) {
    lines.push(`### ${formatSegment(group)}`, "");
    const items = grouped.get(group).slice().sort((a, b) => a.title.localeCompare(b.title));
    for (const item of items) {
      lines.push(`- [${item.title}](${item.referencePath})`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function formatSegment(value: string): string {
  if (!value) return "General";
  const special: Record<string, string> = {
    ai: "AI",
    sdks: "SDKs",
  };
  if (special[value]) return special[value];
  if (value === "general") return "General";
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function convertDocToMarkdown(body: string): string {
  const { replaced, restore } = extractCodeBlocks(body ?? "");
  let text = replaced;

  text = text.replace(/^[ \t]*import\s+[^;]+;?\s*$/gm, "");
  text = text.replace(/^[ \t]*export\s+[^;]+;?\s*$/gm, "");
  text = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  text = stripWrapperTags(text, "Steps");
  text = stripWrapperTags(text, "Tabs");
  text = stripWrapperTags(text, "CardGroup");
  text = stripWrapperTags(text, "CodeGroup");
  text = stripWrapperTags(text, "AccordionGroup");
  text = stripWrapperTags(text, "Frame");

  text = formatHeadingBlocks(text, "Step", "Step", 3);
  text = formatHeadingBlocks(text, "Tab", "Tab", 4);
  text = formatHeadingBlocks(text, "Accordion", "Details", 4);

  text = formatCards(text);

  text = applyCallouts(text, "Tip");
  text = applyCallouts(text, "Note");
  text = applyCallouts(text, "Warning");
  text = applyCallouts(text, "Info");
  text = applyCallouts(text, "Callout");

  text = replaceImages(text);

  text = text.replace(/<Card[^>]*>/gi, "").replace(/<\/Card>/gi, "");
  text = text.replace(/<Steps[^>]*>/gi, "").replace(/<\/Steps>/gi, "");
  text = text.replace(/<Tabs[^>]*>/gi, "").replace(/<\/Tabs>/gi, "");
  text = text.replace(/<Step[^>]*>/gi, "").replace(/<\/Step>/gi, "");
  text = text.replace(/<Tab[^>]*>/gi, "").replace(/<\/Tab>/gi, "");
  text = text.replace(/<Accordion[^>]*>/gi, "").replace(/<\/Accordion>/gi, "");
  text = text.replace(/<Frame[^>]*>/gi, "").replace(/<\/Frame>/gi, "");

  text = text.replace(/<[A-Z][A-Za-z0-9]*[^>]*>/g, "").replace(/<\/[A-Z][A-Za-z0-9]*>/g, "");
  text = stripIndentation(text);
  text = text.replace(/\n{3,}/g, "\n\n");

  return restore(text).trim();
}

function extractCodeBlocks(input: string): { replaced: string; restore: (value: string) => string } {
  const blocks: string[] = [];
  const replaced = input.replace(/```[\s\S]*?```/g, (match) => {
    const token = `@@CODE_BLOCK_${blocks.length}@@`;
    blocks.push(normalizeCodeBlock(match));
    return token;
  });

  return {
    replaced,
    restore: (value) => value.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, index) => blocks[Number(index)] ?? ""),
  };
}

function normalizeCodeBlock(block: string): string {
  const lines = block.split("\n");
  if (lines.length < 2) return block.trim();

  const opening = lines[0].trim();
  const closing = lines[lines.length - 1].trim();
  const contentLines = lines.slice(1, -1);
  const indents = contentLines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  const normalizedContent = contentLines.map((line) => line.slice(minIndent));

  return [opening, ...normalizedContent, closing].join("\n");
}

function stripWrapperTags(input: string, tag: string): string {
  const open = new RegExp(`<${tag}[^>]*>`, "gi");
  const close = new RegExp(`</${tag}>`, "gi");
  return input.replace(open, "\n").replace(close, "\n");
}

function formatHeadingBlocks(input: string, tag: string, fallback: string, level: number): string {
  const heading = "#".repeat(level);
  const withTitles = input.replace(
    new RegExp(`<${tag}[^>]*title=(?:\"([^\"]+)\"|'([^']+)')[^>]*>`, "gi"),
    (_, doubleQuoted: string | undefined, singleQuoted: string | undefined) =>
      `\n${heading} ${(doubleQuoted ?? singleQuoted ?? fallback).trim()}\n\n`,
  );
  const withFallback = withTitles.replace(new RegExp(`<${tag}[^>]*>`, "gi"), `\n${heading} ${fallback}\n\n`);
  return withFallback.replace(new RegExp(`</${tag}>`, "gi"), "\n");
}

function formatCards(input: string): string {
  return input.replace(/<Card([^>]*)>([\s\S]*?)<\/Card>/gi, (_, attrs: string, content: string) => {
    const title = getAttributeValue(attrs, "title") ?? "Resource";
    const href = getAttributeValue(attrs, "href");
    const summary = collapseWhitespace(stripHtml(content));
    const link = href ? `[${title}](${href})` : title;
    const suffix = summary ? ` — ${summary}` : "";
    return `\n- ${link}${suffix}\n\n`;
  });
}

function applyCallouts(input: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\s\S]*?)</${tag}>`, "gi");
  return input.replace(regex, (_, content: string) => {
    const label = tag.toUpperCase();
    const text = collapseWhitespace(stripHtml(content));
    return `\n> **${label}:** ${text}\n\n`;
  });
}

function replaceImages(input: string): string {
  return input.replace(/<img\s+([^>]+?)\s*\/?>(?:\s*<\/img>)?/gi, (_, attrs: string) => {
    const src = getAttributeValue(attrs, "src") ?? "";
    const alt = getAttributeValue(attrs, "alt") ?? "";
    if (!src) return "";
    const url = src.startsWith("/") ? `${DOCS_BASE_URL}${src}` : src;
    return `![${alt}](${url})`;
  });
}

function getAttributeValue(attrs: string, name: string): string | undefined {
  const regex = new RegExp(`${name}=(?:\"([^\"]+)\"|'([^']+)')`, "i");
  const match = attrs.match(regex);
  if (!match) return undefined;
  return (match[1] ?? match[2] ?? "").trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripIndentation(input: string): string {
  return input
    .split("\n")
    .map((line) => line.replace(/^\t+/, "").replace(/^ {2,}/, ""))
    .join("\n");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
