#!/usr/bin/env node
// A stand-in for `ntn` that keeps pages in $FAKE_NTN_STATE (JSON). It strips a leading
// frontmatter block on edit and rewrites `_x_` to `*x*`, as the real CLI does. Creating a page under
// a parent appends its `<page>` tag as the parent's last line, and an edit that drops a tag is refused.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_NTN_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(state));
const page = (id, p) => ({ id, object: "page", last_edited_time: "2026-11-14T19:13:00.000Z",
  properties: { Name: { type: "title", title: [{ plain_text: p.title }] } } });
const fail = (msg, code = 5) => { process.stderr.write(`error: ${msg}\nhint: more\n`); process.exit(code); };
// Row property as the API returns it for a written value; like Notion, an unknown select option is created in the schema.
const stored = (schema, type, v) => {
  const rich = (a) => a.map((t) => ({ type: "text", text: { content: t.text.content, link: null }, annotations: {}, plain_text: t.text.content, href: null }));
  if (type === "title" || type === "rich_text") return rich(v);
  if (type !== "select" && type !== "status") return v;
  const opts = (schema[type].options ??= []);
  if (v === null) return type === "status" ? opts[0] : null;
  let o = opts.find((x) => x.name.toLowerCase() === v.name.toLowerCase());
  if (!o && type === "status") fail(`Invalid status option. Status option "${v.name}" does not exist".`);
  if (!o) opts.push((o = { name: v.name, color: "default" }));
  return { name: o.name, color: o.color };
};
const fill = (s, props) => Object.fromEntries(Object.entries(props).map(([name, body]) => {
  const col = s.properties[name];
  if (!col) fail(`${name} is not a property that exists.`);
  if (!(col.type in body)) fail(`${name} is expected to be ${col.type}.`);
  return [name, { id: col.id, type: col.type, [col.type]: stored(col, col.type, body[col.type]) }];
}));
const stripFrontmatter = (s) => s.replace(/^---\n[\s\S]*?\n?---\n/, "");

if (state.fail) fail(state.fail);
const [group, cmd, ...rest] = process.argv.slice(2);
// Like the real CLI's parser: a separate value that starts with "-" is taken for an unknown flag.
const flag = (name) => {
  const joined = rest.find((a) => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const v = rest.includes(name) ? rest[rest.indexOf(name) + 1] : null;
  if (v?.startsWith("-")) fail(`unexpected argument '${v.split("\n")[0]}' found`, 2);
  return v;
};
if (group === "pages" && cmd === "get") {
  const p = state.pages[rest[0]];
  if (!p) fail(`Could not find page with ID: ${rest[0]}`);
  console.log(JSON.stringify({ page: page(rest[0], p), markdown: { markdown: p.markdown, truncated: false, unknown_block_ids: [] } }));
} else if (group === "pages" && cmd === "edit") {
  const p = state.pages[rest[0]];
  if (!p) fail(`Could not find page with ID: ${rest[0]}`);
  const body = stripFrontmatter(readFileSync(0, "utf8"));
  if (!body.trim()) fail("Markdown content is empty after removing the frontmatter block.");
  for (const [, url] of p.markdown.matchAll(/^<page url="([^"]*)">.*<\/page>$/gm)) {
    if (!body.includes(`<page url="${url}"`)) fail("Public API request failed (400 Bad Request validation_error): This operation would delete 1 child page(s), database(s), or meeting note(s):");
  }
  p.markdown = body.replace(/_(\w+)_/g, "*$1*").trimEnd();
  state.edits = (state.edits ?? 0) + 1;
  save();
  console.log(rest[0]);
} else if (group === "pages" && cmd === "create") {
  const content = flag("--content");
  const title = JSON.parse(/^---\ntitle: (.*)\n---\n/.exec(content)[1]);
  const id = `00000000-0000-0000-0000-${String(Object.keys(state.pages).length).padStart(12, "0")}`;
  const parent = flag("--parent");
  state.pages[id] = { title, markdown: "", parent };
  const mother = state.pages[parent?.replace(/^page:/, "")];
  if (mother) {
    const tag = `<page url="https://app.notion.com/p/${id.replace(/-/g, "")}">${title}</page>`;
    mother.markdown = mother.markdown ? `${mother.markdown}\n${tag}` : tag;
  }
  save();
  console.log(JSON.stringify(page(id, state.pages[id])));
} else if (group === "datasources" && cmd === "query" && state.sources?.[rest[0]]) {
  const s = state.sources[rest[0]];
  console.log(JSON.stringify({ has_more: s.more ?? false, results: s.rows }));
} else if (group === "datasources" && cmd === "query") {
  console.log(JSON.stringify({ has_more: false, results: Object.entries(state.pages).map(([id, p]) => page(id, p)) }));
} else if (group === "api" && /^v1\/pages\/[^/]+\/markdown$/.test(cmd) && flag("-X") === "PATCH") {
  const id = cmd.split("/")[2], p = state.pages[id], body = JSON.parse(flag("-d"));
  if (!p) fail(`Could not find page with ID: ${id}`);
  if (body.type !== "insert_content" || body.insert_content.position?.type !== "end") fail("unexpected body", 2);
  p.markdown = `${p.markdown}\n${body.insert_content.content.trimEnd()}`;
  save();
  console.log(JSON.stringify({ object: "page_markdown", id, markdown: p.markdown, truncated: false, unknown_block_ids: [] }));
} else if (group === "api" && /^v1\/pages\/[^/]+$/.test(cmd) && flag("-X") === "PATCH") {
  const id = cmd.split("/")[2], s = Object.values(state.sources ?? {}).find((x) => x.rows.some((r) => r.id === id));
  if (!s) fail(`Could not find page with ID: ${id}`);
  Object.assign(s.rows.find((r) => r.id === id).properties, fill(s, JSON.parse(flag("-d")).properties));
  save();
  console.log(JSON.stringify({ object: "page", id }));
} else if (group === "api" && cmd === "v1/pages" && !rest.includes("-X")) {
  const body = JSON.parse(flag("-d")), s = state.sources?.[body.parent?.data_source_id];
  if (!s) fail(`Could not find data_source with ID: ${body.parent?.data_source_id}`);
  const id = `11111111-0000-0000-0000-${String(s.rows.length).padStart(12, "0")}`;
  const row = { id, url: `https://www.notion.so/${id.replace(/-/g, "")}`, properties: fill(s, body.properties) };
  s.rows.push(row);
  save();
  console.log(JSON.stringify({ object: "page", id, url: row.url }));
} else if (group === "api" && /^v1\/data_sources\/[^/]+$/.test(cmd) && !rest.includes("-X")) {
  const id = cmd.split("/")[2], s = state.sources?.[id];
  if (!s) fail(`Could not find data source with ID: ${id}`);
  console.log(JSON.stringify({ object: "data_source", id, title: [{ plain_text: s.title }], properties: s.properties }));
} else if (group === "api" && cmd === "v1/search") {
  const q = JSON.parse(flag("-d")).query.toLowerCase();
  const hits = Object.entries(state.pages).filter(([, p]) => p.title.toLowerCase().includes(q));
  console.log(JSON.stringify({ results: hits.map(([id, p]) => page(id, p)) }));
} else fail(`unknown command ${group} ${cmd}`, 2);
