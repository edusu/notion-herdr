// Self-check for mods/notion-notes/notion.js against tests/fake-ntn.mjs: `node tests/self-check.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { client, upload, serial, titleOf, refreshDecision, pages, ago, pageUrl, readable, mappedPage, sourceNames, canonicalId } from "../mods/notion-notes/notion.js";
import { parseBlocks, todos, toggleTodo, cell, replaceBlock, insertAfter, retype, continuation, slashQuery, commands, setType, editParts, nextEditable } from "../mods/notion-notes/blocks.js";

const here = dirname(fileURLToPath(import.meta.url));
const ntn = join(here, "fake-ntn.mjs");
chmodSync(ntn, 0o755);
const tmp = mkdtempSync(join(tmpdir(), "notion-notes-"));
const stateFile = join(tmp, "state.json");
process.env.FAKE_NTN_STATE = stateFile;

// Same shape as Herdr's exec: resolves with the exit code, rejects only when it cannot start.
const exec = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, (err, stdout, stderr) => {
    if (err && typeof err.code !== "number") return reject(err);
    resolve({ code: err ? err.code : 0, stdout, stderr });
  }));
const write = async (path, text) => writeFileSync(path, text);
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const reset = (s) => writeFileSync(stateFile, JSON.stringify(s));
const ID = "418e82c3-1287-8154-94b3-fc5ad78fc192";
const file = join(tmp, "up.md");
const api = client(exec, ntn);

test("parses pages get, search and datasources query", async () => {
  reset({ pages: { [ID]: { title: "Herdr notes", markdown: "hello" } } });
  assert.deepEqual(await api.get(ID), { id: ID, title: "Herdr notes", url: null, markdown: "hello", partial: false });
  const row = { id: ID, title: "Herdr notes", edited: "2026-11-14T19:13:00.000Z", parent: null, parentIds: [] };
  assert.deepEqual(await api.search("herdr"), [row]);
  assert.deepEqual(await api.search("nothing"), []);
  assert.deepEqual(await api.list("ds"), [row]);
  assert.equal(titleOf({ properties: {} }), "Untitled");
});

test("picker rows carry title, last edit and the parent's name when the response has it", () => {
  // Shaped like `ntn api v1/search` / `ntn datasources query --json` results.
  const page = (id, title, parent, edited) => ({
    object: "page", id, last_edited_time: edited, parent,
    properties: { Name: { id: "title", type: "title", title: [{ plain_text: title, type: "text" }] } },
  });
  const rows = pages({ object: "list", has_more: false, results: [
    page("p1", "Projects", { type: "workspace", workspace: true }, "2026-11-14T19:00:00.000Z"),
    page("p2", "Standup", { type: "page_id", page_id: "p1" }, "2026-11-12T10:00:00.000Z"),
    page("p3", "Standup", { type: "data_source_id", data_source_id: "ds9", database_id: "db9" }, "2026-10-01T08:30:00.000Z"),
  ] });
  assert.deepEqual(rows, [
    { id: "p1", title: "Projects", edited: "2026-11-14T19:00:00.000Z", parent: "Workspace", parentIds: [] },
    { id: "p2", title: "Standup", edited: "2026-11-12T10:00:00.000Z", parent: "Projects", parentIds: ["p1"] },
    { id: "p3", title: "Standup", edited: "2026-10-01T08:30:00.000Z", parent: null, parentIds: ["ds9", "db9"] },
  ]);
  // The once-per-session data-source lookup names the third row's parent.
  const names = sourceNames({ results: [
    { object: "data_source", id: "ds9", parent: { type: "database_id", database_id: "db9" }, title: [{ plain_text: "Meetings" }] },
    { object: "data_source", id: "ds8", parent: { type: "database_id", database_id: "db8" }, title: [] },
  ] });
  assert.equal(rows[2].parentIds.map((id) => names.get(id)).find(Boolean), "Meetings");
  assert.equal(names.get("db8"), "Untitled");
  const now = Date.parse("2026-11-14T19:30:00.000Z");
  assert.deepEqual(rows.map((r) => ago(r.edited, now)), ["30m", "2d", "2026-10-01"]);
  assert.equal(ago("2026-11-14T16:30:00.000Z", now), "3h");
  assert.equal(ago(undefined, now), "");
});

test("Open in Notion uses the app link, a Notion https URL, or one built from the id", () => {
  const own = "https://app.notion.com/p/notion-herdr-test-418e82c31287815494b3fc5ad78fc192";
  assert.equal(pageUrl(ID, own, true), "notion://www.notion.so/418e82c31287815494b3fc5ad78fc192");
  assert.equal(pageUrl(ID, own, false), own);
  assert.equal(pageUrl(ID, "https://acme.notion.site/Page-1", false), "https://acme.notion.site/Page-1");
  for (const bad of ["https://evil.example/notion.so", "http://www.notion.so/x", "file:///etc/passwd", "https://notion.so.evil.com/x", null])
    assert.equal(pageUrl(ID, bad, false), "https://www.notion.so/418e82c31287815494b3fc5ad78fc192");
  assert.equal(pageUrl("../../etc", own, true), null);
});

test("notion-note-append finds the mapped folder upwards and refuses an unmapped folder, empty stdin or unsent Herdr edits", async () => {
  assert.equal(mappedPage({ "/w/repo": "a" }, "/w/repo/src/deep", "/h"), "a");
  assert.equal(mappedPage({ "~": "h" }, "/h/x", "/h"), "h");
  assert.equal(mappedPage({ "/w/repo": "a", "vps:/w": "r" }, "/w/other", "/h"), null);

  const home = join(tmp, "app");
  mkdirSync(join(home, "notion-notes"), { recursive: true });
  mkdirSync(join(home, "mods/notion-notes"), { recursive: true });
  writeFileSync(join(home, "notion-notes/map.json"), JSON.stringify({ [join(tmp, "repo")]: ID }));
  writeFileSync(join(home, "mods/notion-notes/mod.json"), JSON.stringify({ settings: { ntn } }));
  mkdirSync(join(tmp, "repo/src"), { recursive: true });
  reset({ pages: { [ID]: { title: "t", markdown: "old" } } });
  const run = (args, input) => new Promise((ok) => {
    const child = execFile(join(here, "../bin/notion-note-append"), args, { env: { ...process.env, HERDR_APP_HOME: home } },
      (err, stdout, stderr) => ok({ code: err ? err.code : 0, stdout, stderr }));
    child.stdin.end(input);
  });
  const r = await run(["--folder", join(tmp, "repo/src")], "## Agent summary\n- did things\n");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(state().pages[ID].markdown, "old\n## Agent summary\n- did things");
  const none = await run(["--folder", tmp], "text");
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no note is mapped/);
  const empty = await run(["--folder", join(tmp, "repo")], "  \n");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /stdin is empty/);
  writeFileSync(join(home, `notion-notes/${ID}.json`), JSON.stringify({ pending: true }));
  const busy = await run(["--folder", join(tmp, "repo")], "text");
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /not yet uploaded/);
  // An id typed without dashes or in capitals still finds the note's local state.
  const typed = await run(["--page", ID.replace(/-/g, "").toUpperCase()], "text");
  assert.match(typed.stderr, /not yet uploaded/);
  assert.equal(canonicalId(ID.replace(/-/g, "").toUpperCase()), ID);
  assert.equal(canonicalId("nope"), null);
  assert.equal(state().pages[ID].markdown, "old\n## Agent summary\n- did things");
});

test("create passes a quoted title and the parent", async () => {
  reset({ pages: {} });
  const p = await api.create('a: "b"', "page:abc");
  assert.equal(p.title, 'a: "b"');
  assert.equal(state().pages[p.id].parent, "page:abc");
});

test("uploads when Notion still has the base, and keeps Notion's normalized markdown as base", async () => {
  reset({ pages: { [ID]: { title: "t", markdown: "old" } } });
  const r = await upload(api, ID, "new _text_", "old", file, write);
  assert.deepEqual(r, { base: "new *text*" });
  assert.equal(state().pages[ID].markdown, "new *text*");
});

test("a body that starts with frontmatter-like lines survives", async () => {
  reset({ pages: { [ID]: { title: "t", markdown: "old" } } });
  await upload(api, ID, "---\nfoo: 1\n---\nbar", "old", file, write);
  assert.equal(state().pages[ID].markdown, "---\nfoo: 1\n---\nbar");
});

test("a page changed in Notion is a conflict and is not edited", async () => {
  reset({ pages: { [ID]: { title: "t", markdown: "edited elsewhere" } } });
  const r = await upload(api, ID, "mine", "old", file, write);
  assert.equal(r.conflict.markdown, "edited elsewhere");
  assert.equal(state().edits, undefined);
  assert.deepEqual(await upload(api, ID, "mine", "old", file, write, true), { base: "mine" });
});

test("serial runs uploads in order and survives a failed job", async () => {
  reset({ pages: { [ID]: { title: "t", markdown: "v0" } } });
  const queue = serial(), order = [];
  let base = "v0";
  const job = (text) => queue(async () => { order.push(text); base = (await upload(api, ID, text, base, file, write)).base; });
  const failed = queue(async () => { throw new Error("boom"); });
  await Promise.all([job("v1"), failed.catch(() => {}), job("v2")]);
  assert.deepEqual(order, ["v1", "v2"]);
  assert.equal(state().pages[ID].markdown, "v2");
});

test("refresh applies a Notion change, keeps an unchanged one, and is dropped after typing", () => {
  const base = "old";
  assert.equal(refreshDecision({ typed: false, remote: "new", base }), "apply");
  assert.equal(refreshDecision({ typed: false, remote: "old", base }), "same");
  assert.equal(refreshDecision({ typed: true, remote: "new", base }), "drop");
});

test("errors become one readable line", async () => {
  reset({ pages: {}, fail: "not logged in" });
  await assert.rejects(api.get(ID), { message: "error: not logged in" });
  await assert.rejects(client(exec, join(tmp, "missing-ntn")).get(ID), /^Error: Cannot run /);
});

test("an emptied note uploads as Notion's empty block", async () => {
  reset({ pages: { [ID]: { title: "t", markdown: "<empty-block/>" } } });
  assert.deepEqual(await upload(api, ID, "  \n", "<empty-block/>", file, write), { base: "<empty-block/>" });
});

test("read view turns Notion tags into markdown", () => {
  const md = '<page url="https://app.notion.com/p/a">General</page>\n<empty-block/>\n<database url="https://app.notion.com/p/b" inline="true" data-source-url="collection://x">Tasks</database>';
  assert.equal(readable(md), "📄 [General](https://app.notion.com/p/a)\n\n\n🗃️ [Tasks](https://app.notion.com/p/b)\n");
  // Consecutive child pages stay separate paragraphs instead of one run-on line.
  assert.equal(readable('<page url="u1">A</page>\n<page url="u2">B</page>'), "📄 [A](u1)\n\n📄 [B](u2)\n");
});

test("to-dos: nested items parse, code fences are ignored, a stale line is not flipped", () => {
  const text = "# Tasks\n- [ ] one\n\t- [x] nested\n```md\n- [ ] in code\n```\n* [X] star";
  assert.deepEqual(todos(text), [
    { line: 1, done: false, label: "one", depth: 0 },
    { line: 2, done: true, label: "nested", depth: 1 },
    { line: 6, done: true, label: "star", depth: 0 },
  ]);
  assert.equal(toggleTodo(text, 1, "one"), text.replace("- [ ] one", "- [x] one"));
  assert.equal(toggleTodo(text, 2, "nested"), text.replace("[x] nested", "[ ] nested"));
  assert.equal(toggleTodo(text, 4, "in code"), null);
  // A refresh inserted a line: index 1 now holds another to-do, so nothing flips.
  assert.equal(toggleTodo("# Tasks\n- [ ] new\n- [ ] one", 1, "one"), null);
  assert.equal(toggleTodo(text, 0, "one"), null);
});

// Shaped like the user's Tasks page: child page, empty block, inline database, then ordinary markdown.
const TASKS = [
  '<page url="https://app.notion.com/p/General-0e5e82c3128782a4a3c807e20e40ff01">General</page>',
  "<empty-block/>",
  '<database url="https://app.notion.com/p/0e5e82c3128782a4a3c807e20e40ff02" inline="true" data-source-url="collection://0e5e82c3-1287-82a4-a3c8-07e20e40ffea">Tasks</database>',
  "## Notes",
  "- [ ] call back",
  "\t- [x] nested done",
  "Some **bold** text",
].join("\n");

test("every line of a page belongs to exactly one block, in order", () => {
  const inputs = [
    TASKS, "", "\n", "# a\n\ntext\n", "a\r\nb\r\n",
    "```js\nunclosed fence\n- [ ] x",
    "<callout>\nnever closed\n- [ ] x",
    "<details>\n<summary>a</summary>\n<details>\ninner\n</details>\nstill outer\n</details>\nafter",
    "> a\n> b\n\n1. x\n2) y\n---\n#### four",
  ];
  for (const text of inputs) assert.equal(parseBlocks(text).map((b) => b.raw).join("\n"), text);
  assert.deepEqual(parseBlocks(""), []);
});

test("a Tasks-shaped page parses into typed blocks with their data", () => {
  const b = parseBlocks(TASKS);
  assert.deepEqual(b.map((x) => [x.type, x.from, x.to]), [
    ["page", 0, 0], ["empty", 1, 1], ["database", 2, 2], ["heading", 3, 3],
    ["todo", 4, 4], ["todo", 5, 5], ["paragraph", 6, 6],
  ]);
  assert.equal(b[0].title, "General");
  assert.equal(b[0].id, "0e5e82c3-1287-82a4-a3c8-07e20e40ff01");
  assert.equal(b[0].url, "https://app.notion.com/p/General-0e5e82c3128782a4a3c807e20e40ff01");
  assert.equal(b[2].title, "Tasks");
  assert.equal(b[2].id, "0e5e82c3-1287-82a4-a3c8-07e20e40ff02");
  assert.equal(b[2].source, "0e5e82c3-1287-82a4-a3c8-07e20e40ffea");
  assert.deepEqual([b[3].level, b[3].text], [2, "Notes"]);
  assert.deepEqual([b[4].done, b[4].label, b[4].depth], [false, "call back", 0]);
  assert.deepEqual([b[5].done, b[5].label, b[5].depth], [true, "nested done", 1]);
  assert.deepEqual([b[6].text, b[6].depth], ["Some **bold** text", 0]);
});

test("a fence swallows everything inside it", () => {
  const text = '```md\n- [ ] x\n<page url="https://www.notion.so/a-0e5e82c3128782a4a3c807e20e40ff01">A</page>\n```\nafter';
  const b = parseBlocks(text);
  assert.deepEqual(b.map((x) => [x.type, x.from, x.to]), [["code", 0, 3], ["paragraph", 4, 4]]);
  assert.equal(b[0].lang, "md");
});

test("a multi-line tag is one raw block through its matching close, or to the end if unclosed", () => {
  const nested = "<details>\n<summary>a</summary>\n<details>\ninner\n</details>\nstill outer\n</details>\nafter";
  assert.deepEqual(parseBlocks(nested).map((x) => [x.type, x.from, x.to, x.tag]), [["raw", 0, 6, "details"], ["paragraph", 7, 7, undefined]]);
  assert.deepEqual(parseBlocks("<callout>one line</callout>\nnext").map((x) => x.type), ["raw", "paragraph"]);
  assert.deepEqual(parseBlocks('<unknown a="1"/>\nnext').map((x) => x.type), ["raw", "paragraph"]);
  const open = parseBlocks("intro\n<callout>\n- [ ] inside\nmore");
  assert.deepEqual(open.map((x) => [x.type, x.from, x.to, x.tag]), [["paragraph", 0, 0, undefined], ["raw", 1, 3, "callout"]]);
});

test("a todo block agrees with todos() on its line, label, state and depth", () => {
  const text = "# T\n- [ ] a\n\t- [x] b\n```\n- [ ] no\n```\n+ [X] c";
  const fromBlocks = parseBlocks(text).filter((x) => x.type === "todo").map((x) => ({ line: x.from, done: x.done, label: x.label, depth: x.depth }));
  assert.deepEqual(fromBlocks, todos(text));
});

test("lists, quotes, dividers and look-alikes parse as their own types", () => {
  const b = parseBlocks("- a\n\t* b\n1. c\n2) d\n> q1\n> q2\n---\n#### four\nhttps://x <https://y>\n  \n\tindented");
  assert.deepEqual(b.map((x) => x.type), ["bullet", "bullet", "numbered", "numbered", "quote", "divider", "paragraph", "paragraph", "blank", "paragraph"]);
  assert.deepEqual([b[1].depth, b[1].text], [1, "b"]);
  assert.deepEqual([b[4].from, b[4].to, b[4].text], [4, 5, "q1\nq2"]);
  assert.deepEqual([b[9].text, b[9].depth], ["indented", 1]);
});

test("a page URL without 32 hex digits has no id, and a database without a data source has no source", () => {
  const [p, d] = parseBlocks('<page url="https://www.notion.so/short">P</page>\n<database url="https://www.notion.so/x-0e5e82c3128782a4a3c807e20e40ff02">D</database>');
  assert.deepEqual([p.type, p.id], ["page", null]);
  assert.deepEqual([d.type, d.source, d.id], ["database", null, "0e5e82c3-1287-82a4-a3c8-07e20e40ff02"]);
  // Attribute order does not matter.
  const [e] = parseBlocks('<database data-source-url="collection://0e5e82c3-1287-82a4-a3c8-07e20e40ffea" url="u">T</database>');
  assert.equal(e.source, "0e5e82c3-1287-82a4-a3c8-07e20e40ffea");
});

test("source returns the title column first, then the schema's order, with rows and the more flag", async () => {
  const props = (n, s) => ({ Nombre: { id: "title", type: "title", title: [{ plain_text: n }] }, Estado: { id: "s", type: "status", status: { name: s, color: "blue" } } });
  reset({ pages: {}, sources: { [ID]: {
    title: "Tasks",
    // The schema lists Estado before Nombre; the title column still comes first.
    properties: { Estado: { id: "s", name: "Estado", type: "status" }, Fecha: { id: "d", name: "Fecha", type: "date" }, Nombre: { id: "title", name: "Nombre", type: "title" } },
    rows: [{ id: "r1", url: "https://www.notion.so/r1", properties: props("One", "Doing") }],
    more: true,
  } } });
  assert.deepEqual(await api.source(ID), {
    columns: [{ name: "Nombre", type: "title" }, { name: "Estado", type: "status" }, { name: "Fecha", type: "date" }],
    rows: [{ id: "r1", url: "https://www.notion.so/r1", properties: props("One", "Doing") }],
    more: true,
  });
});

test("source fails with one readable line for a missing data source, and never runs ntn for an invalid id", async () => {
  reset({ pages: {} });
  await assert.rejects(api.source(ID), { message: `error: Could not find data source with ID: ${ID}` });
  await assert.rejects(api.source("../search"), { message: "Invalid data source id: ../search" });
  // Existing pages keep answering a plain query when no source is registered.
  assert.deepEqual(await api.list("ds"), []);
});

test("cell shows each property type as text, with a colour for status and select", () => {
  const rich = (...t) => t.map((plain_text) => ({ plain_text }));
  assert.deepEqual(cell({ type: "title", title: rich("A", "B") }), { text: "AB" });
  assert.deepEqual(cell({ type: "title", title: [] }), { text: "" });
  assert.deepEqual(cell({ type: "rich_text", rich_text: rich("x ", "y") }), { text: "x y" });
  assert.deepEqual(cell({ type: "status", status: { name: "Doing", color: "blue" } }), { text: "Doing", color: "blue" });
  assert.deepEqual(cell({ type: "status", status: null }), { text: "" });
  assert.deepEqual(cell({ type: "select", select: { name: "High", color: "red" } }), { text: "High", color: "red" });
  assert.deepEqual(cell({ type: "select", select: null }), { text: "" });
  assert.deepEqual(cell({ type: "multi_select", multi_select: [{ name: "a", color: "red" }, { name: "b", color: "green" }] }), { text: "a, b" });
  assert.deepEqual(cell({ type: "multi_select", multi_select: [] }), { text: "" });
  assert.deepEqual(cell({ type: "checkbox", checkbox: true }), { text: "✓" });
  assert.deepEqual(cell({ type: "checkbox", checkbox: false }), { text: "" });
  assert.deepEqual(cell({ type: "number", number: 3.5 }), { text: "3.5" });
  assert.deepEqual(cell({ type: "number", number: 0 }), { text: "0" });
  assert.deepEqual(cell({ type: "number", number: null }), { text: "" });
  assert.deepEqual(cell({ type: "date", date: { start: "2026-11-14", end: null } }), { text: "2026-11-14" });
  assert.deepEqual(cell({ type: "date", date: { start: "2026-11-14", end: "2026-11-16" } }), { text: "2026-11-14 → 2026-11-16" });
  assert.deepEqual(cell({ type: "date", date: null }), { text: "" });
  assert.deepEqual(cell({ type: "people", people: [{ name: "Ana" }, { name: "Luis" }] }), { text: "Ana, Luis" });
  assert.deepEqual(cell({ type: "people", people: [] }), { text: "" });
  assert.deepEqual(cell({ type: "url", url: "https://x.test" }), { text: "https://x.test" });
  assert.deepEqual(cell({ type: "url", url: null }), { text: "" });
  assert.deepEqual(cell({ type: "email", email: "a@b.c" }), { text: "a@b.c" });
  assert.deepEqual(cell({ type: "phone_number", phone_number: null }), { text: "" });
});

test("cell shows a dash for unsupported or malformed properties and never throws", () => {
  assert.deepEqual(cell({ type: "formula", formula: { type: "string", string: "x" } }), { text: "—" });
  for (const bad of [undefined, null, "text", 3, {}, { type: "status" }, { type: "people", people: [null] }, { type: "date", date: {} }]) {
    assert.deepEqual(cell(bad), { text: "—" });
  }
});

test("block links take the page id from the URL path, dashed or not", () => {
  const hex = "0e5e82c3128782a4a3c807e20e40ff02", dashed = "0e5e82c3-1287-82a4-a3c8-07e20e40ff02";
  const [db] = parseBlocks(`<database url="https://www.notion.so/${hex}?v=${"b".repeat(32)}" data-source-url="collection://${dashed}">DB</database>`);
  assert.equal(db.id, dashed);
  assert.equal(parseBlocks(`<page url="https://www.notion.so/${dashed}">P</page>`)[0].id, dashed);
  assert.equal(parseBlocks(`<page url="https://www.notion.so/Cafe-${hex}">P</page>`)[0].id, dashed);
});

test("a tag closes across lines and ignores tags inside fenced code; table rows stay one block", () => {
  const types = (text) => parseBlocks(text).map((b) => [b.type, b.from, b.to]);
  assert.deepEqual(types('<video\n src="x"\n/>\n- [ ] t'), [["raw", 0, 2], ["todo", 3, 3]]);
  assert.deepEqual(types("<details>\n```\n</details>\n```\n</details>\nafter"), [["raw", 0, 4], ["paragraph", 5, 5]]);
  assert.deepEqual(types("| a | b |\n|---|---|\n| 1 | 2 |\nnext"), [["table", 0, 2], ["paragraph", 3, 3]]);
});

test("readable() finds the url attribute in any position", () => {
  assert.equal(readable('<page color="gray" url="u">T</page>'), "📄 [T](u)\n");
});

test("replaceBlock swaps a block's lines, removes them for an empty raw, and refuses a stale block", () => {
  const text = "# Title\nfirst\n> a\n> b\nlast";
  const [h, p, q, l] = parseBlocks(text);
  for (const b of parseBlocks(text)) assert.equal(replaceBlock(text, b, b.raw), text);
  assert.equal(replaceBlock(text, p, "- first\n- second"), "# Title\n- first\n- second\n> a\n> b\nlast");
  assert.equal(replaceBlock(text, q, "quote"), "# Title\nfirst\nquote\nlast");
  assert.equal(replaceBlock(text, h, ""), "first\n> a\n> b\nlast");
  assert.equal(replaceBlock(text, l, ""), "# Title\nfirst\n> a\n> b");
  assert.equal(replaceBlock("only", parseBlocks("only")[0], ""), "");
  // The page changed underneath: a line was inserted above, or the block's text differs.
  assert.equal(replaceBlock("new\n" + text, p, "x"), null);
  assert.equal(replaceBlock(text.replace("first", "edited"), p, "x"), null);
  assert.equal(replaceBlock("# Title", p, "x"), null);
  assert.equal(replaceBlock(text, { from: 3, to: 9, raw: "> b\nlast" }, "x"), null);
  assert.equal(replaceBlock(text, { from: -1, to: 0, raw: "" }, "x"), null);
  assert.equal(replaceBlock(text, undefined, "x"), null);
});

test("insertAfter adds lines below a block and refuses a stale block", () => {
  const text = "# Title\n> a\n> b\nlast";
  const [h, q, l] = parseBlocks(text);
  assert.equal(insertAfter(text, h, "- new"), "# Title\n- new\n> a\n> b\nlast");
  assert.equal(insertAfter(text, q, "one\ntwo"), "# Title\n> a\n> b\none\ntwo\nlast");
  assert.equal(insertAfter(text, l, "- [ ] "), text + "\n- [ ] ");
  assert.equal(insertAfter("new\n" + text, h, "x"), null);
  assert.equal(insertAfter("# Title", q, "x"), null);
});

test("retype rewrites the prefix of a one-line block and keeps its text", () => {
  const prefix = { paragraph: "", h1: "# ", h2: "## ", h3: "### ", todo: "- [ ] ", bullet: "- ", numbered: "1. ", quote: "> " };
  const sources = ["text", "# text", "## text", "### text", "- [ ] text", "- [x] text", "- text", "* text", "1. text", "7) text", "> text"];
  for (const from of sources) for (const [type, p] of Object.entries(prefix)) {
    assert.equal(retype(from, type), p + "text", `${from} -> ${type}`);
  }
  // Lists and paragraphs keep their indentation; headings and quotes drop it.
  const indented = { paragraph: "  ", todo: "  - [ ] ", bullet: "  - ", numbered: "  1. ", h2: "## ", quote: "> " };
  for (const from of ["  note", "  - note", "  * [x] note", "  3. note", "  4) note"]) {
    for (const [type, p] of Object.entries(indented)) assert.equal(retype(from, type), p + "note", `${from} -> ${type}`);
  }
  assert.equal(retype("\t- note", "bullet"), "\t- note");
  assert.equal(retype("\tnote", "todo"), "\t- [ ] note");
  assert.equal(retype("-  two  spaces ", "h1"), "#  two  spaces ");
  assert.equal(retype("- ", "h2"), "## ");
});

test("retype returns the input when it is not a one-line block or the type is unknown", () => {
  assert.equal(retype("a\nb", "bullet"), "a\nb");
  assert.equal(retype("> a\n> b", "paragraph"), "> a\n> b");
  assert.equal(retype("text", "code"), "text");
  assert.equal(retype("text", undefined), "text");
  for (const raw of ["---", "<empty-block/>", "| a |", "```", ""]) assert.equal(retype(raw, "bullet"), raw);
});

test("continuation gives the prefix of the block Enter creates, with the same indentation", () => {
  const next = (raw) => continuation(parseBlocks(raw)[0]);
  assert.equal(next("- a"), "- ");
  assert.equal(next("* a"), "* ");
  assert.equal(next("+ a"), "+ ");
  assert.equal(next("\t\t- nested"), "\t\t- ");
  assert.equal(next("  * nested"), "  * ");
  assert.equal(next("- [x] done"), "- [ ] ");
  assert.equal(next("  * [ ] open"), "  - [ ] ");
  assert.equal(next("1. a"), "2. ");
  assert.equal(next("9. a"), "10. ");
  assert.equal(next("3) a"), "4) ");
  assert.equal(next("  99) a"), "  100) ");
  for (const raw of ["# h", "text", "  text", "> q", "---", "```\ncode\n```", "| a |"]) assert.equal(next(raw), "", raw);
});

test("slashQuery finds a /word at the cursor after a one-character edit", () => {
  assert.deepEqual(slashQuery("", "/"), { start: 0, query: "" });
  assert.deepEqual(slashQuery("/", "/a"), { start: 0, query: "a" });
  assert.deepEqual(slashQuery("/a", "/as"), { start: 0, query: "as" });
  assert.deepEqual(slashQuery("buy milk ", "buy milk /"), { start: 9, query: "" });
  assert.deepEqual(slashQuery("buy  milk", "buy / milk"), { start: 4, query: "" });
  assert.deepEqual(slashQuery("/h", "/h1"), { start: 0, query: "h1" });
  assert.deepEqual(slashQuery("/títul", "/título"), { start: 0, query: "título" });
  // Inserting before text that follows: the cursor is right after the typed character.
  assert.deepEqual(slashQuery("a b", "a /b"), { start: 2, query: "" });
  assert.deepEqual(slashQuery("a\tb", "a\t/b"), { start: 2, query: "" });
  // Deleting back to the slash keeps the menu open; deleting the slash or going past it closes it.
  assert.deepEqual(slashQuery("/as", "/a"), { start: 0, query: "a" });
  assert.deepEqual(slashQuery("/a", "/"), { start: 0, query: "" });
  assert.equal(slashQuery("/", ""), null);
  assert.equal(slashQuery("x /", "x "), null);
  assert.equal(slashQuery("x /a", "x a"), null);
  assert.deepEqual(slashQuery("/as", "/s"), { start: 0, query: "" });
});

test("slashQuery gives null for a slash inside a word, a space, a paste or any other edit", () => {
  assert.equal(slashQuery("a", "a/"), null);
  assert.equal(slashQuery("a/", "a/b"), null);
  assert.equal(slashQuery("http:/", "http://"), null);
  assert.equal(slashQuery("/as", "/as "), null);
  assert.equal(slashQuery("/as", "/as-"), null);
  assert.equal(slashQuery("", "/ab"), null);
  assert.equal(slashQuery("x", "x/ab"), null);
  assert.equal(slashQuery("/a", "/abc"), null);
  assert.equal(slashQuery("/abc", "/"), null);
  assert.equal(slashQuery("/abc", "/x"), null);
  assert.equal(slashQuery("/a", "/b"), null);
  assert.equal(slashQuery("/a", "/a"), null);
  assert.equal(slashQuery("note", ""), null);
  assert.equal(slashQuery("hello world", "hello /"), null);
  assert.equal(slashQuery(undefined, "/"), null);
  assert.equal(replaceBlock(undefined, { from: 0, to: 0, raw: "" }, "x"), null);
});

test("commands filters by prefix of any keyword, in English or Spanish, ignoring case and accents", () => {
  const ids = (q) => commands(q).map((c) => c.id);
  assert.deepEqual(ids(""), ["paragraph", "h1", "h2", "h3", "todo", "bullet", "numbered", "quote"]);
  assert.deepEqual(commands("")[1], { id: "h1", label: "Heading 1" });
  assert.deepEqual(ids("h"), ["h1", "h2", "h3", "divider"]);
  assert.deepEqual(ids("h2"), ["h2"]);
  assert.deepEqual(ids("tit"), ["h1", "h2", "h3"]);
  assert.deepEqual(ids("títu"), ["h1", "h2", "h3"]);
  assert.deepEqual(ids("TITULO"), ["h1", "h2", "h3"]);
  assert.deepEqual(ids("tarea"), ["todo"]);
  assert.deepEqual(ids("todo"), ["todo"]);
  assert.deepEqual(ids("lis"), ["bullet", "numbered"]);
  assert.deepEqual(ids("num"), ["numbered"]);
  assert.deepEqual(ids("q"), ["quote"]);
  assert.deepEqual(ids("sep"), ["divider"]);
  assert.deepEqual(ids("hr"), ["divider"]);
  assert.deepEqual(ids("Text"), ["paragraph"]);
  assert.deepEqual(ids("xyz"), []);
  assert.deepEqual(ids("headings"), []);
});

test("setType retypes a line, and gives a blank line the new marker", () => {
  assert.equal(setType("foo", "h2"), "## foo");
  assert.equal(setType("- [x] foo", "bullet"), "- foo");
  assert.equal(setType("- ", "quote"), "> ");
  assert.equal(setType("", "todo"), "- [ ] ");
  assert.equal(setType("  ", "numbered"), "1. ");
  assert.equal(setType("", "paragraph"), "");
});

test("editParts splits an editable one-line block into its markdown prefix and its text", () => {
  const parts = (raw) => editParts(parseBlocks(raw)[0]);
  assert.deepEqual(parts("plain text"), { prefix: "", text: "plain text" });
  assert.deepEqual(parts("  indented"), { prefix: "  ", text: "indented" });
  assert.deepEqual(parts("## Title"), { prefix: "## ", text: "Title" });
  assert.deepEqual(parts("- item"), { prefix: "- ", text: "item" });
  assert.deepEqual(parts("\t* nested"), { prefix: "\t* ", text: "nested" });
  assert.deepEqual(parts("12) step"), { prefix: "12) ", text: "step" });
  assert.deepEqual(parts("- [x] done"), { prefix: "- [x] ", text: "done" });
  assert.deepEqual(parts("  - [ ] open"), { prefix: "  - [ ] ", text: "open" });
  assert.deepEqual(parts("> quoted"), { prefix: "> ", text: "quoted" });
  assert.deepEqual(parts("- "), { prefix: "- ", text: "" });
  assert.deepEqual(parts("- [ ] "), { prefix: "- [ ] ", text: "" });
  assert.deepEqual(parts("-  two spaces "), { prefix: "- ", text: " two spaces " });
});

test("editParts gives blank and empty blocks an empty prefix, so typing replaces the whole line", () => {
  for (const raw of ["", "   ", "<empty-block/>"]) assert.deepEqual(editParts(parseBlocks("a\n" + raw)[1]), { prefix: "", text: "" }, JSON.stringify(raw));
});

test("editParts gives null for blocks that are not edited in place", () => {
  for (const raw of ["> a\n> b", "```\ncode\n```", "| a |\n| - |", "---", "<callout>\nx\n</callout>", '<page url="https://notion.so/418e82c3128781d494b3fc5ad78fc192">T</page>']) {
    assert.equal(editParts(parseBlocks(raw)[0]), null, raw);
  }
  assert.equal(editParts(undefined), null);
});

test("editParts prefix plus text is always the block's raw line", () => {
  const text = "# T\n- a\n  1. b\n- [ ] c\n> q\nplain\n\n   indented";
  for (const b of parseBlocks(text)) {
    const e = editParts(b);
    if (e && b.type !== "blank") assert.equal(e.prefix + e.text, b.raw);
  }
});

test("nextEditable finds the closest editable block before or after a line", () => {
  const blocks = parseBlocks("# T\n```\nx\n```\ntext\n---\n| a |\n- last");
  const at = (b) => b?.from;
  assert.equal(at(nextEditable(blocks, 4, -1)), 0);
  assert.equal(at(nextEditable(blocks, 4, 1)), 7);
  assert.equal(nextEditable(blocks, 0, -1), undefined);
  assert.equal(nextEditable(blocks, 7, 1), undefined);
  assert.equal(at(nextEditable(blocks, 1, 1)), 4);
  assert.equal(nextEditable([], 0, 1), undefined);
});
