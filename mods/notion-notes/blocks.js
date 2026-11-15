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

// The lines of `text` when `b`'s span still holds `b.raw`, else null: the page changed underneath.
function linesOf(text, b) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  const ok = Number.isInteger(b?.from) && Number.isInteger(b.to) && b.from >= 0 && b.from <= b.to && b.to < lines.length
    && lines.slice(b.from, b.to + 1).join("\n") === b.raw;
  return ok ? lines : null;
}

/** `text` with the lines of `block` replaced by `raw` (several lines, or "" to remove them), or null if `block` is stale. */
export function replaceBlock(text, block, raw) {
  const lines = linesOf(text, block);
  if (!lines) return null;
  lines.splice(block.from, block.to - block.from + 1, ...(raw === "" ? [] : [raw]));
  return lines.join("\n");
}

/**
 * `text` with `raw` added as new lines after `block`, or null if `block` is stale. An empty note
 * has no block to insert after, so the caller never gets here with `text === ""`.
 */
export function insertAfter(text, block, raw) {
  const lines = linesOf(text, block);
  if (!lines) return null;
  lines.splice(block.to + 1, 0, raw);
  return lines.join("\n");
}

const indentOf = (l) => /^\s*/.exec(l)[0];
const PREFIX = { paragraph: "", h1: "# ", h2: "## ", h3: "### ", todo: "- [ ] ", bullet: "- ", numbered: "1. ", quote: "> " };
// Only these keep their indentation: the parser reads a heading or a quote only when unindented.
const KEEPS_INDENT = new Set(["paragraph", "todo", "bullet", "numbered"]);
const RETYPABLE = new Set(["paragraph", "heading", "todo", "bullet", "numbered", "quote"]);

/**
 * Gives a one-line block another type (`paragraph`, `h1`–`h3`, `todo`, `bullet`, `numbered` or
 * `quote`), keeping its text. A done to-do loses its `[x]`. `raw` is returned unchanged when it
 * is not a one-line paragraph, heading, list item or quote, or when `type` is unknown.
 */
export function retype(raw, type) {
  if (typeof raw !== "string" || raw.includes("\n") || !Object.hasOwn(PREFIX, type)) return raw;
  const [kind, , data] = block([raw], 0);
  if (!RETYPABLE.has(kind)) return raw;
  return (KEEPS_INDENT.has(type) ? indentOf(raw) : "") + PREFIX[type] + (data.text ?? data.label);
}

/**
 * The prefix of the block Enter creates after `block`, with its indentation: the same bullet
 * marker, an open to-do, or the next number with the same `.` or `)`. Anything else gives "".
 */
export function continuation(block) {
  const [, indent, mark] = /^(\s*)(\S+)/.exec(block?.raw ?? "") ?? [];
  switch (block?.type) {
    case "bullet": return indent + mark + " ";
    case "todo": return indent + PREFIX.todo;
    case "numbered": return indent + (parseInt(mark) + 1) + mark.slice(-1) + " ";
    default: return "";
  }
}

const EDITABLE = new Set(["paragraph", "heading", "bullet", "numbered", "todo", "quote"]);

/**
 * How a block is edited in place: `prefix` is the markdown that stays out of the field and
 * `text` is what the field holds, so `prefix + text` is the raw line. A blank or empty block has
 * an empty prefix (typing replaces the whole line). Null for anything that spans lines (a
 * multi-line quote, code, tables), raw tags, dividers, pages and databases.
 */
export function editParts(block) {
  const type = block?.type;
  if (type === "blank" || type === "empty") return { prefix: "", text: "" };
  if (!EDITABLE.has(type) || block.to !== block.from) return null;
  const text = type === "todo" ? block.label : block.text;
  return { prefix: block.raw.slice(0, block.raw.length - text.length), text };
}

/** The closest block before (`step` -1) or after (1) line `from` that `editParts` accepts, or undefined. */
export function nextEditable(blocks, from, step) {
  return step < 0 ? blocks.findLast((b) => b.from < from && editParts(b)) : blocks.find((b) => b.from > from && editParts(b));
}

/**
 * Where the `/word` under the cursor starts, as `{ start, query }`, given the field's value
 * before and after one change; null when the change is not one typed or deleted character, or
 * the cursor is not at the end of a `/word` that starts the text or follows whitespace. The
 * field does not report its cursor, so it is taken from the common prefix: in a run of equal
 * characters it lands at the end of the run, which only matters when word characters follow.
 */
export function slashQuery(prev, next) {
  if (typeof prev !== "string" || typeof next !== "string") return null;
  const grew = next.length - prev.length;
  if (Math.abs(grew) !== 1) return null;
  const [short, long] = grew > 0 ? [prev, next] : [next, prev];
  let p = 0;
  while (p < short.length && short[p] === long[p]) p++;
  if (short.slice(p) !== long.slice(p + 1)) return null;
  const pos = grew > 0 ? p + 1 : p;
  const m = /(?:^|\s)\/([\p{L}\p{N}]*)$/u.exec(next.slice(0, pos));
  return m && { start: pos - m[1].length - 1, query: m[1] };
}

/** `retype`, also for a blank line (which `retype` leaves alone): it becomes the type's bare marker. */
export function setType(raw, type) {
  return raw.trim() === "" && Object.hasOwn(PREFIX, type) ? PREFIX[type] : retype(raw, type);
}

// In menu order. `id` is a `retype` type, or "divider"; keywords are matched by prefix.
const COMMANDS = [
  ["paragraph", "Text", "text texto paragraph parrafo"],
  ["h1", "Heading 1", "h1 heading title titulo"],
  ["h2", "Heading 2", "h2 heading title titulo"],
  ["h3", "Heading 3", "h3 heading title titulo"],
  ["todo", "To-do", "todo to-do task tarea checkbox"],
  ["bullet", "Bulleted list", "bullet bulleted list lista"],
  ["numbered", "Numbered list", "number numbered list lista numerada"],
  ["quote", "Quote", "quote cita"],
  ["divider", "Divider", "divider hr separator separador line"],
].map(([id, label, words]) => ({ id, label, words: words.split(" ") }));
const MENU_ROWS = 8;
const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The `/` menu commands matching `query` as `{ id, label }`, at most 8, in menu order. */
export function commands(query) {
  const q = fold(query);
  return COMMANDS.filter((c) => c.words.some((w) => w.startsWith(q))).slice(0, MENU_ROWS).map(({ id, label }) => ({ id, label }));
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
