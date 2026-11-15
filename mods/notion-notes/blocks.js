// Splits a note's markdown into blocks for the read view. Pure and free of Herdr imports, so
// the self-check runs it under plain node. Blocks only describe the text: uploads always send
// the editor's text, never one rebuilt from blocks.
import { canonicalId } from "./notion.js";

const depthOf = (indent) => indent.replace(/\t/g, "  ").length >> 1;

const todoLine = (l) => {
  const m = /^(\s*)[-*+] \[([ xX])\] (.*)$/.exec(l);
  return m && { done: m[2] !== " ", label: m[3], depth: depthOf(m[1]) };
};

/** The note's `- [ ]` / `- [x]` lines outside fenced code: `{ line, done, label, depth }`. */
export function todos(text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((l, line) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const t = !fence && todoLine(l);
    if (t) out.push({ line, ...t });
  });
  return out;
}

/** Flips the to-do at `line`, or returns null if that line is no longer the to-do `label`. */
export function toggleTodo(text, line, label) {
  const t = todos(text).find((x) => x.line === line);
  if (!t || t.label !== label) return null;
  const lines = text.split("\n");
  lines[line] = lines[line].replace(/\[[ xX]\]/, t.done ? "[ ]" : "[x]");
  return lines.join("\n");
}

const attr = (attrs, name) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

// A line that is exactly `<name url="…" …>Title</name>`, or null.
function link(t, name) {
  const m = new RegExp(`^<${name}\\s([^>]*)>((?:(?!</${name}>).)*)</${name}>$`).exec(t);
  const url = m ? attr(m[1], "url") : undefined;
  if (url === undefined) return null;
  const hex = [...url.matchAll(/[0-9a-f]{32}/gi)].at(-1)?.[0];
  return { attrs: m[1], url, title: m[2], id: canonicalId(hex) };
}

// Elements that never have a closing tag; without this `<br>` would swallow the rest of the note.
const VOID = new Set(["br", "hr", "img", "input", "wbr"]);

// Last line of the element opened on line `i`: open and close tags of the same name are
// counted, so a nested `<details>` does not end the outer one early. An unclosed one runs to the end.
function tagEnd(lines, i, tag) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s/>]|$)([^>]*)(>|$)`, "g");
  let depth = 0;
  for (let end = i; end < lines.length; end++) {
    for (const [, close, rest, gt] of lines[end].matchAll(re)) {
      if (close) depth--;
      else if (!(gt && rest.endsWith("/"))) depth++;
    }
    if (depth <= 0) return end;
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
    const source = attr(m.attrs, "data-source-url")?.replace(/^collection:\/\//, "");
    return ["database", i, { url: m.url, title: m.title, id: m.id, source: canonicalId(source) }];
  }
  if ((m = /^<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(t))) {
    return ["raw", VOID.has(m[1]) ? i : tagEnd(lines, i, m[1]), { tag: m[1] }];
  }
  if (/^(---|\*\*\*|___)$/.test(t)) return ["divider", i, {}];
  if ((m = /^(#{1,3}) (.*)$/.exec(l))) return ["heading", i, { level: m[1].length, text: m[2] }];
  if ((m = todoLine(l))) return ["todo", i, m];
  if ((m = /^(\s*)[-*+] (.*)$/.exec(l))) return ["bullet", i, { depth: depthOf(m[1]), text: m[2] }];
  if ((m = /^(\s*)\d+[.)] (.*)$/.exec(l))) return ["numbered", i, { depth: depthOf(m[1]), text: m[2] }];
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
