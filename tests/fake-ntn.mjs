#!/usr/bin/env node
// A stand-in for `ntn` that keeps pages in $FAKE_NTN_STATE (JSON). It strips a leading
// frontmatter block on edit and rewrites `_x_` to `*x*`, as the real CLI does.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_NTN_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(state));
const page = (id, p) => ({ id, object: "page", last_edited_time: "2026-11-14T19:13:00.000Z",
  properties: { Name: { type: "title", title: [{ plain_text: p.title }] } } });
const fail = (msg, code = 5) => { process.stderr.write(`error: ${msg}\nhint: more\n`); process.exit(code); };
const stripFrontmatter = (s) => s.replace(/^---\n[\s\S]*?\n?---\n/, "");

if (state.fail) fail(state.fail);
const [group, cmd, ...rest] = process.argv.slice(2);
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
if (group === "pages" && cmd === "get") {
  const p = state.pages[rest[0]];
  if (!p) fail(`Could not find page with ID: ${rest[0]}`);
  console.log(JSON.stringify({ page: page(rest[0], p), markdown: { markdown: p.markdown, truncated: false, unknown_block_ids: [] } }));
} else if (group === "pages" && cmd === "edit") {
  const p = state.pages[rest[0]];
  if (!p) fail(`Could not find page with ID: ${rest[0]}`);
  const body = stripFrontmatter(readFileSync(0, "utf8"));
  if (!body.trim()) fail("Markdown content is empty after removing the frontmatter block.");
  p.markdown = body.replace(/_(\w+)_/g, "*$1*").trimEnd();
  state.edits = (state.edits ?? 0) + 1;
  save();
  console.log(rest[0]);
} else if (group === "pages" && cmd === "create") {
  const content = flag("--content");
  const title = JSON.parse(/^---\ntitle: (.*)\n---\n/.exec(content)[1]);
  const id = `00000000-0000-0000-0000-${String(Object.keys(state.pages).length).padStart(12, "0")}`;
  state.pages[id] = { title, markdown: "", parent: flag("--parent") };
  save();
  console.log(JSON.stringify(page(id, state.pages[id])));
} else if (group === "datasources" && cmd === "query") {
  console.log(JSON.stringify({ has_more: false, results: Object.entries(state.pages).map(([id, p]) => page(id, p)) }));
} else if (group === "api" && /^v1\/pages\/[^/]+\/markdown$/.test(cmd) && flag("-X") === "PATCH") {
  const id = cmd.split("/")[2], p = state.pages[id], body = JSON.parse(flag("-d"));
  if (!p) fail(`Could not find page with ID: ${id}`);
  if (body.type !== "insert_content" || body.insert_content.position?.type !== "end") fail("unexpected body", 2);
  p.markdown = `${p.markdown}\n${body.insert_content.content.trimEnd()}`;
  save();
  console.log(JSON.stringify({ object: "page_markdown", id, markdown: p.markdown, truncated: false, unknown_block_ids: [] }));
} else if (group === "api" && cmd === "v1/search") {
  const q = JSON.parse(flag("-d")).query.toLowerCase();
  const hits = Object.entries(state.pages).filter(([, p]) => p.title.toLowerCase().includes(q));
  console.log(JSON.stringify({ results: hits.map(([id, p]) => page(id, p)) }));
} else fail(`unknown command ${group} ${cmd}`, 2);
