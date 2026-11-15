// Splits a note's markdown into blocks for the read view. Pure and free of Herdr imports, so
// the self-check runs it under plain node. Blocks only describe the text: uploads always send
// the editor's text, never one rebuilt from blocks.
import { canonicalId } from "./notion.js";

const depthOf = (indent) => indent.replace(/\t/g, "  ").length >> 1;

const todoLine = (l) => {
  const m = /^(\s*)[-*+] \[([ xX])\] (.*)$/.exec(l);
  return m && { done: m[2] !== " ", label: m[3], depth: depthOf(m[1]) };
};

/** The note's to-do blocks (outside fenced code and tags) as `{ line, done, label, depth }`. */
export function todos(text) {
  return parseBlocks(text).filter((b) => b.type === "todo").map((b) => ({ line: b.from, done: b.done, label: b.label, depth: b.depth }));
}

/** Flips the to-do at `line`, or returns null if that line is no longer the to-do `label`. */
export function toggleTodo(text, line, label) {
  const t = todos(text).find((x) => x.line === line);
  if (!t || t.label !== label) return null;
  const lines = text.split("\n");
  lines[line] = lines[line].replace(/\[[ xX]\]/, t.done ? "[ ]" : "[x]");
  return lines.join("\n");
}

const URL_ATTR = /(?:^|\s)url="([^"]*)"/;
const SOURCE_ATTR = /(?:^|\s)data-source-url="collection:\/\/([^"]*)"/;
const LINKS = Object.fromEntries(["page", "database"].map((n) => [n, new RegExp(`^<${n}\\s([^>]*)>((?:(?!</${n}>).)*)</${n}>$`)]));
// A page id, dashed or not, not part of a longer hex run.
const PAGE_ID = /(?<![0-9a-f])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/gi;

// A line that is exactly `<name url="…" …>Title</name>`, or null. The id is the last one in
// the URL's path: a query such as `?v=<view id>` names a view, not the page.
function link(t, name) {
  const m = LINKS[name].exec(t);
  const url = m && URL_ATTR.exec(m[1])?.[1];
  if (url == null) return null;
  const hex = [...url.split(/[?#]/)[0].matchAll(PAGE_ID)].at(-1)?.[0];
  return { attrs: m[1], url, title: m[2], id: canonicalId(hex) };
}

// Elements that never have a closing tag; without this `<br>` would swallow the rest of the note.
const VOID = new Set(["br", "hr", "img", "input", "wbr"]);

// Last line of the element opened on line `i`: open and close tags of the same name are
// counted, so a nested `<details>` does not end the outer one early. Tags inside fenced code
// are text, and an opening tag may end (or self-close) on a later line. An unclosed one runs to the end.
function tagEnd(lines, i, tag) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s/>]|$)([^>]*)(>|$)`, "g");
  let depth = 0, open = false, fence = false;
  for (let end = i; end < lines.length; end++) {
    let l = lines[end];
    if (end > i && /^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    if (open) {
      const gt = l.indexOf(">");
      if (gt < 0) continue;
      open = false;
      if (l[gt - 1] === "/") depth--;
      l = l.slice(gt + 1);
    }
    for (const [, close, rest, gt] of l.matchAll(re)) {
      if (close) depth--;
      else if (!gt) { depth++; open = true; }
      else if (!rest.endsWith("/")) depth++;
    }
    if (depth <= 0 && !open) return end;
  }
  return lines.length - 1;
}

// [type, last line, data] of the block that starts at line `i`.
function block(lines, i) {
  const l = lines[i], t = l.trim();
  let m;
  if ((m = /^\s*(```|~~~)/.exec(l))) {
    let end = i + 1;
    while (end < lines.length && !lines[end].trimStart().startsWith(m[1])) end++;
    return ["code", Math.min(end, lines.length - 1), { lang: t.slice(3).trim() }];
  }
  if (t === "<empty-block/>") return ["empty", i, {}];
  if ((m = link(t, "page"))) return ["page", i, { url: m.url, title: m.title, id: m.id }];
  if ((m = link(t, "database"))) {
    return ["database", i, { url: m.url, title: m.title, id: m.id, source: canonicalId(SOURCE_ATTR.exec(m.attrs)?.[1]) }];
  }
  if ((m = /^<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(t))) {
    return ["raw", VOID.has(m[1]) ? i : tagEnd(lines, i, m[1]), { tag: m[1] }];
  }
  if (/^(---|\*\*\*|___)$/.test(t)) return ["divider", i, {}];
  // A markdown table spans lines, so its rows stay one block.
  if (t.startsWith("|")) {
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trim().startsWith("|")) end++;
    return ["table", end, {}];
  }
  if ((m = /^(#{1,3}) (.*)$/.exec(l))) return ["heading", i, { level: m[1].length, text: m[2] }];
  if ((m = todoLine(l))) return ["todo", i, m];
  if ((m = /^(\s*)[-*+] (.*)$/.exec(l))) return ["bullet", i, { depth: depthOf(m[1]), text: m[2] }];
  if ((m = /^(\s*)(\d+[.)]) (.*)$/.exec(l))) return ["numbered", i, { depth: depthOf(m[1]), marker: m[2], text: m[3] }];
  if (t.startsWith(">")) {
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trimStart().startsWith(">")) end++;
    const text = lines.slice(i, end + 1).map((q) => q.replace(/^\s*> ?/, "")).join("\n");
    return ["quote", end, { text }];
  }
  if (!t) return ["blank", i, {}];
  const indent = /^\s*/.exec(l)[0];
  return ["paragraph", i, { text: l.slice(indent.length), depth: depthOf(indent) }];
}

/**
 * The note as blocks `{ type, from, to, raw, ...data }`: `from`/`to` are 0-based line indexes
 * (`to` inclusive) and `raw` is those lines. Every line is in exactly one block, so joining the
 * blocks' `raw` with "\n" gives `text` back.
 */
export function parseBlocks(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const [type, to, data] = block(lines, i);
    blocks.push({ type, from: i, to, raw: lines.slice(i, to + 1).join("\n"), ...data });
    i = to + 1;
  }
  return blocks;
}

const join = (rich) => rich.map((t) => t.plain_text).join("");

/**
 * A database row's property as `{ text, color? }`; `color` is a Notion colour name, only for
 * status and select (a multi-select shows its names as plain text). Unsupported types and
 * malformed properties give "—"; it never throws.
 */
export function cell(property) {
  try {
    const v = property[property.type];
    if (v === undefined) return { text: "—" };
    switch (property.type) {
      case "title":
      case "rich_text": return { text: join(v) };
      case "status":
      case "select": return v ? { text: v.name, color: v.color } : { text: "" };
      case "multi_select":
      case "people": return { text: v.map((x) => x.name).join(", ") };
      case "checkbox": return { text: v ? "✓" : "" };
      case "number": return { text: v === null ? "" : String(v) };
      case "date":
        if (v && typeof v.start !== "string") break;
        return { text: v ? (v.end ? `${v.start} → ${v.end}` : v.start) : "" };
      case "url":
      case "email":
      case "phone_number": return { text: v ?? "" };
    }
  } catch { /* falls through to the dash */ }
  return { text: "—" };
}
