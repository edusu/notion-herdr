// A Notion page as an editable markdown note, through the Notion CLI (`ntn`).
// As a layout block it shows the note mapped to the active space; with props.page it is a
// pane; opened as an overlay (`mod.open`) it is the dialog that chooses or creates a note.
// The save chain is adapted from tab-notes in ozcberkay/herdr-coban (Apache-2.0).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { exec, theme, settings, props, run, shared, layout, panes, focused, readTextFile } from "herdr";
import { client, upload, serial, refreshDecision, pageUrl, validId, canonicalId } from "./notion.js";
import { replaceBlock, appendedPage, withoutPage } from "./blocks.js";
import { pickerMethods } from "./picker.js";
import { ui, setSizes } from "./ui.js";
import { readMethods, sourcesChanged, release } from "./read.js";
import { NAME, MAP_REV, MOVE_TO, REFRESH_EVERY, dir, mapPath, cachePath, metaPath, uploadPath, draftPath, spaceKey, spacePage, readJson, put, loadSettings, mapSpace } from "./store.js";
import * as fs from "fs/promises";

const UPLOAD_AFTER = 3000;
// readTextFile reads at most 1 MiB, and UTF-8 needs up to 3 bytes per UTF-16 unit.
const MAX_CHARS = 340000;

const putMeta = (id, m) => put(metaPath(id), JSON.stringify({ base: m.base, title: m.title, url: m.url, pending: m.pending, partial: m.partial }));
// The meta goes first: a pending flag without the newest text keeps older local edits,
// while new text without the flag would be replaced by Notion's on the next open. A partial
// (read-only, possibly oversized) page keeps no local copy: it is always read from Notion.
const persist = async (id, m, text, meta = true) => {
  if (meta) await putMeta(id, m);
  if (!m.partial) await put(cachePath(id), text);
};
// What a read from Notion sets on a note.
const fromPage = (p) => ({ base: p.markdown, savedText: p.markdown, title: p.title, url: p.url, partial: p.partial || p.markdown.length > MAX_CHARS });
// Bumping rev tells an upload already in flight that newer text exists.
const changed = (m) => { m.pending = true; m.rev++; };
// Which copy edits each page: a second view of the same page opens read-only, so two
// editors never write the same files. Module scope is shared by this mod's copies.
const owners = new Map();
// Per page, across copies: when Notion was last read or a read started, which also keeps a
// second refresh from starting while one runs.
const fetchedAt = new Map();
// The start-up upload of notes left pending runs once per app session, whatever the number
// of copies; an open of a note waits for its start-up upload to finish.
let swept = false;
let listed = Promise.resolve();
const sweeping = new Map();
// Compact id -> rev of pages renamed in this app session: a view whose note links one reads Notion again,
// since the parent's markdown now carries the new title.
const renamed = new Map();
let renamedRev = 0;
// notion:// opens the desktop app; once `open` fails for it, https is used for the session.
let viaApp = true;

// Herdr tells a layout block nothing when it is shown, and a hidden copy gets no renders,
// but layout() carries every node's `hidden` and each stack's `active` child.
const isPanel = (node) => node.content?.mod === NAME && !node.content.props?.page;
const shownIn = (node) => {
  if (!node || node.hidden) return false;
  if (isPanel(node)) return true;
  const kids = node.children ?? [];
  return (node.type === "stack" ? [kids.find((c) => c.id === node.active) ?? kids[0]] : kids).some(shownIn);
};

// The layout nodes from the root down to the panel copy, or null when the layout has none.
const panelPath = (node = layout(), trail = []) => {
  if (!node) return null;
  if (isPanel(node)) return [...trail, node];
  for (const c of node.children ?? []) { const p = panelPath(c, [...trail, node]); if (p) return p; }
  return null;
};

// Shows the panel copy: unhides every node on its path and picks it in each stack.
const showPanel = (path) => {
  path.forEach((n, i) => {
    if (n.hidden) run("layout.show", { id: n.id });
    if (n.type === "stack" && path[i + 1]) run("layout.select", { stack: n.id, child: path[i + 1].id });
  });
};

class NotionNotes extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.page ? "pane" : p.overlay ? "picker" : "panel";
    this.setup = loadSettings().then((cfg) => { this.cfg = cfg; this.api = client(exec, cfg.ntn); setSizes(cfg.scale, cfg.font_size); cx.notify(); });
    if (this.mode === "picker") return this.initPicker(cx);

    // Local files go through `disk` and Notion calls through `net`, so a slow upload never
    // holds back saving what is typed.
    this.disk = serial(); this.net = serial();
    this.page = null; this.meta = null; this.editor = null; this.dirty = false;
    this.conflict = null; this.creating = null; this.errors = {}; this.gen = 0; this.changedAt = 0;
    try { this.reading = localStorage.getItem("view") !== "edit"; } catch { this.reading = true; }
    this.setup.catch((e) => { this.errors.settings = `Settings in mod.json: ${e.message}`; cx.notify(); });
    cx.timer.every(800, (cx) => this.tick(cx));
    // Emptied rather than removed once taken, so only one view shows it.
    this.setup.then(() => this.disk(async () => {
      const draft = await readTextFile(draftPath());
      if (!draft) return;
      await put(draftPath(), "");
      this.errors.draft ??= draft;
      cx.notify();
    })).catch(() => {});
    // Before a pane's open: its load() waits on `listed`, which sweep() sets right away.
    if (!swept) { swept = true; this.sweep(cx); }
    if (this.mode === "pane") {
      if (validId(p.page)) this.open(p.page, cx);
      else this.errors.open = "Not a Notion page id";
      return;
    }
    this.renamedSeen = renamedRev;
    this.key = undefined; this.map = null; this.mapRev = shared(MAP_REV);
    this.loadMap(cx);
  }

  // Uploads every note left pending by an earlier session, one at a time, through the same
  // conflict check. Failures and conflicts are left pending, silently: the note shows them
  // when it is opened, and the next start tries again.
  // Every candidate is registered in `sweeping` before the first upload, and load() waits for
  // the listing, so an open can never race the sweep for the same note.
  sweep(cx) {
    listed = (async () => {
      let names = [];
      try { await this.setup; names = await fs.readdir(dir()); } catch { return; }
      let prev = Promise.resolve();
      for (const name of names) {
        const id = name.slice(0, -5);
        if (!name.endsWith(".json") || !validId(id)) continue;
        prev = prev.then(() => (owners.has(id) ? null : this.sweepOne(id))).catch(() => {});
        const job = prev;
        sweeping.set(id, job);
        job.then(() => sweeping.delete(id));
      }
    })();
  }

  // The sweep is already sequential and skips pages a view holds, so it needs no queue of its own.
  async sweepOne(id) {
    const m = await this.disk(() => readJson(metaPath(id)));
    if (!m?.pending || m.partial) return;
    const text = await this.disk(() => readTextFile(cachePath(id)));
    if (text == null) return;
    const r = await upload(this.api, id, text, m.base, uploadPath(id), put);
    if (r.conflict) return;
    fetchedAt.set(id, Date.now());
    await this.disk(() => putMeta(id, { ...m, base: r.base, pending: false }));
  }

  loadMap(cx) {
    cx.spawn(async (cx) => {
      try { this.map = (await readJson(mapPath())) ?? {}; this.errors.map = null; }
      catch (e) { this.errors.map = `Cannot read map.json: ${e.message}`; this.map = {}; }
      this.key = undefined;
      cx.notify();
    });
  }

  openPicker() {
    run("mod.open", { name: NAME });
  }

  canUpload(m) {
    return m?.pending && !m.uploading && !m.held && !m.readonly && !this.conflict && !this.creating && !this.moving;
  }

  // Local saves every 0.8 s, like tab-notes; an upload once typing has stopped for 3 s.
  // Its timer keeps running while the panel is hidden, so this is where showing is noticed.
  tick(cx) {
    // A shown note is read again every REFRESH_EVERY, so edits from another device arrive.
    // After a space change while hidden, render opens the new note and refreshes it there.
    // shortcut: a pane view counts as shown whenever the focused tab holds any note pane (panes() does not say which page a pane shows); fine while one note pane per tab is the norm.
    const tab = this.mode === "pane" && focused()?.tab;
    const shown = this.mode === "panel" ? shownIn(layout()) && spaceKey() === this.key
      : tab && panes().some((p) => p.mod === NAME && p.tab === tab);
    if (shown) this.refresh(cx);
    // A read-only second view takes the note over once the view that edited it is gone.
    if (this.meta?.elsewhere && !owners.has(this.page)) this.open(this.page, cx);
    if (this.renamedSeen !== renamedRev) {
      const text = this.editor?.value() ?? "";
      const hit = [...renamed].some(([hex, rev]) => rev > this.renamedSeen && text.includes(hex));
      if (hit) fetchedAt.delete(this.page);
      // A refresh held back by local edits leaves the rename to a later tick.
      if (!hit || this.refresh(cx)) this.renamedSeen = renamedRev;
    }
    // The picker opened by a block's Move to answers here, under the request's token.
    const pick = shared(MOVE_TO);
    if (this.moveReq && pick?.token === this.moveReq.token) {
      const { block, m } = this.moveReq;
      this.moveReq = null;
      if (this.meta === m) this.moveTo(block, pick.id, cx);
    }
    if (this.reading && this.sourcesSeen !== sourcesChanged()) { this.sourcesSeen = sourcesChanged(); cx.notify(); }
    if (this.dirty && this.editor) this.save(cx);
    if (this.canUpload(this.meta) && Date.now() - this.changedAt >= UPLOAD_AFTER) this.push(this.page, this.meta, false, cx);
  }

  save(cx) {
    const id = this.page, m = this.meta, text = this.editor.value();
    // Staying dirty keeps a refresh from replacing the unsaved text and retries once it is short enough.
    if (text.length > MAX_CHARS) { this.errors.save = "Note too large to save locally"; return; }
    this.dirty = false;
    // The meta only changes when the note turns pending; later saves rewrite just the text.
    const flips = !m.pending;
    changed(m);
    const rev = m.rev;
    cx.spawn(async (cx) => {
      try {
        await this.disk(async () => { await persist(id, m, text, flips); m.savedText = text; m.savedRev = rev; });
        if (this.meta === m) this.errors.save = null;
      } catch (e) {
        if (this.meta === m) { this.errors.save = `Save failed: ${e.message}`; this.dirty = true; }
      }
      cx.notify();
    });
  }

  // Uploads the last text saved to disk. A failure holds further uploads until the next edit,
  // so an offline note does not retry against Notion every tick.
  push(id, m, force, cx) {
    m.uploading = true;
    cx.spawn(async (cx) => {
      try {
        await this.net(async () => {
          // A save queued just before (as leaving a note does) must land first, or the older text goes up.
          await this.disk(() => {});
          const text = m.savedText, rev = m.savedRev;
          const r = await upload(this.api, id, text, m.base, uploadPath(id), put, force);
          if (r.conflict) { if (this.meta === m) this.conflict = r.conflict; return; }
          m.base = r.base;
          m.pending = m.rev !== rev;
          fetchedAt.set(id, Date.now());
          await this.disk(() => putMeta(id, m));
        });
        if (this.meta === m) this.errors.upload = null;
      } catch (e) {
        m.held = true;
        if (this.meta === m) this.errors.upload = `Upload failed: ${e.message}`;
      }
      m.uploading = false;
      cx.notify();
    });
  }

  // Creates a subpage in place of `block`. The remote steps share the upload queue, so they never
  // interleave with an upload comparing `base`; canUpload stops new ones from queuing meanwhile.
  createPage(block, title, cx) {
    const id = this.page, m = this.meta;
    this.creating = block;
    cx.spawn(async (cx) => {
      let made = null;
      try {
        await this.net(async () => {
          made = await this.api.create(title, `page:${id}`);
          // The page exists now: a failed read must not keep its tag out of the note.
          const remote = await this.api.get(id).catch(() => null);
          const found = remote && appendedPage(remote.markdown, m.base, made.id);
          // Notion refuses an upload that lacks the new tag ("would delete 1 child page"), so it is never dropped.
          const line = found ?? `<page url="${pageUrl(made.id)}">${title}</page>`;
          const place = (text) => replaceBlock(text, block, line) ?? (text ? `${text}\n${line}` : line);
          // The old base would read as a conflict now; with no tag found it stays, and the upload reports it.
          if (found) m.base = remote.markdown;
          await this.rewrite(id, m, place, found);
        });
        if (this.meta === m) {
          this.errors.page = null;
          this.openPage(made.id, null, {}, cx);
        }
      } catch (e) {
        if (this.meta === m) this.errors.page = `Cannot create page: ${e.message}${made ? " (the subpage exists in Notion)" : ""}`;
      }
      this.creating = null;
      cx.notify();
    });
  }

  // Applies `place` to note `m`'s text, inside the upload queue; `based`: `m.base` changed and is saved too.
  async rewrite(id, m, place, based) {
    if (this.meta === m) {
      this.setText(place(this.editor.value()), m);
      if (based) await this.disk(() => putMeta(id, m));
      return;
    }
    // The note was left meanwhile: its saved copy changes, queued after the save that leaving started.
    await this.disk(async () => {
      const text = place(m.savedText);
      changed(m);
      await persist(id, m, text);
      m.savedText = text; m.savedRev = m.rev;
    });
  }

  // Moves this note's subpage in `block` to Notion's trash, or under page `to`, then takes its line out of the
  // note. As in createPage, `base` follows Notion only when its markdown is `base` without that line, or the
  // upload would report a conflict. A page that is not this note's child (a link to one elsewhere) only loses
  // its line, so a page elsewhere is never trashed or moved from here.
  detachPage(block, to, cx) {
    const id = this.page, m = this.meta;
    this.creating = { ...block, busy: to ? "Moving page…" : "Deleting page…" };
    cx.spawn(async (cx) => {
      try {
        await this.net(async () => {
          const child = (await this.api.parent(block.id)) === canonicalId(id);
          if (!child && to) throw new Error("only a subpage of this note can be moved");
          let found = false;
          if (child) {
            await (to ? this.api.move(block.id, to) : this.api.trash(block.id));
            const remote = await this.api.get(id).catch(() => null);
            found = Boolean(remote) && remote.markdown !== m.base && withoutPage(m.base, block.id) === remote.markdown;
            if (found) m.base = remote.markdown;
          }
          await this.rewrite(id, m, (text) => withoutPage(text, block.id), found);
        });
        if (to) fetchedAt.delete(to);
        if (this.meta === m) this.errors.page = null;
      } catch (e) {
        if (this.meta === m) this.errors.page = `Cannot ${to ? "move" : "delete"} page: ${e.message}`;
      }
      this.creating = null;
      cx.notify();
    });
  }

  // Move to for a top-level block. Text is appended to page `to` first and only then taken out of this note,
  // so a failure can leave a copy behind but never loses the block; a subpage is moved by Notion itself.
  moveTo(block, to, cx) {
    const m = this.meta;
    cx.spawn(async (cx) => {
      try {
        if (!validId(to)) throw new Error("not a Notion page id");
        // As bin/notion-note-append: writing under the target's unsent edits would force a choice between them.
        if ((await this.disk(() => readJson(metaPath(to))))?.pending) throw new Error("that page has edits in Herdr not yet uploaded; try again once it shows Synced");
        if (block.type === "page") return this.detachPage(block, to, cx);
        if (this.meta !== m || replaceBlock(this.editor.value(), block, null) === null) throw new Error("the block changed meanwhile");
        await this.net(() => this.api.append(to, block.raw.replace(/^[ \t]+/, "")));
        // Another view showing that page reads it again on its next tick.
        fetchedAt.delete(to);
        const next = this.meta === m ? replaceBlock(this.editor.value(), block, null) : null;
        if (next === null) throw new Error("it was copied there, but changed here meanwhile; remove it yourself");
        this.setText(next, m);
        this.errors.move = null;
      } catch (e) {
        if (this.meta === m) this.errors.move = `Cannot move block: ${e.message}`;
      }
      cx.notify();
    });
  }

  // Makes this pane's note the panel's note for the current space, shows the panel and closes the pane.
  // The panel opens it read-only until this pane's close() has saved and released it.
  toPanel(cx) {
    if (!this.endEdit(cx)) return;
    if (!panelPath()) { this.errors.panel = "No side panel in this layout"; cx.notify(); return; }
    const id = this.page;
    if (this.dirty) this.save(cx);
    // No new upload starts here: the panel takes the note over, and two copies uploading would conflict.
    this.moving = true;
    cx.spawn(async (cx) => {
      try {
        // Uploads, renames and saves already queued land before the panel reads the note.
        await this.net(() => {});
        await this.disk(() => {});
        await mapSpace(id);
        showPanel(panelPath() ?? []);
        // A mod pane is not told its own id. The pane is closed by explicit id, so a terminal pane is never hit.
        // shortcut: with several note panes in the tab the focused one is taken, which may not be this one; fine while one is the norm.
        const tab = focused()?.tab, mine = panes().filter((p) => p.mod === NAME && p.tab === tab);
        const own = mine.length === 1 ? mine[0] : mine.find((p) => p.focused);
        if (own) return run("pane.close", { pane: own.pane });
        this.errors.panel = "Close this pane to edit the note in the panel";
      } catch (e) {
        this.errors.panel = `Cannot move to the panel: ${e.message}`;
      }
      this.moving = false;
      cx.notify();
    });
  }

  // The page title above the note, in both views; a click edits it unless the note is read-only.
  renderTitle(t) {
    const m = this.meta, row = h_flex().id("nn-page-title").flex_none().px(14).pt(12).pb(2).min_w(0).text_size(ui.text.title).font_semibold();
    if (this.titleEdit) {
      return row.child(h_flex().flex_1().min_w(0).track_focus(this.fieldFocus)
        .on_key_down((e, cx) => { if (e.keystroke === "escape") { this.closeTitle(cx); cx.notify(); } })
        .child(Input.new(this.titleEdit).flex_1().text_size(ui.text.title).text_color(t.foreground)));
    }
    return row.when(!m.readonly, (el) => el.cursor_pointer().on_click((_e, cx) => this.editTitle(cx)))
      .child(div().min_w(0).truncate().text_color(m.title ? t.foreground : t.dim).child(m.title || "Untitled"));
  }

  editTitle(cx) {
    if (!this.endEdit(cx)) return;
    const state = InputState.new({ value: this.meta.title ?? "" });
    const done = (_e, cx) => { if (this.titleEdit === state) { this.endTitle(cx); cx.notify(); } };
    state.on("blur", done);
    state.on("submit", done);
    this.fieldFocus ??= cx.focus_handle();
    this.titleEdit = state;
    state.focus();
    cx.notify();
  }

  closeTitle(cx) {
    const state = this.titleEdit;
    if (!state) return;
    this.titleEdit = null;
    release(state, cx);
  }

  // Renames the page in Notion through the upload queue; with no `cx` (the view is going away) the draft is dropped.
  // The new title shows at once and goes back if Notion refuses it.
  endTitle(cx) {
    const title = this.titleEdit?.value().replace(/\s+/g, " ").trim();
    this.closeTitle(cx);
    const id = this.page, m = this.meta, before = m?.title ?? "";
    if (title === undefined || !cx || title === before) return;
    m.title = title;
    cx.spawn(async (cx) => {
      try {
        // The title property's id is "title" in every page, database rows included.
        // The meta is written inside the upload queue, so a move to the panel waits for it.
        await this.net(async () => {
          await this.api.setProperty(id, { name: "title", type: "title" }, title);
          renamed.set(id.replace(/-/g, ""), ++renamedRev);
          await this.disk(() => putMeta(id, m));
        });
        if (this.meta === m) this.errors.title = null;
      } catch (e) {
        if (m.title === title) m.title = before;
        if (this.meta === m) this.errors.title = `Cannot rename page: ${e.message}`;
      }
      cx.notify();
    });
  }

  // The local copy opens at once and refresh() checks Notion; unsent edits always win.
  // An unreadable meta file stops the open rather than risk replacing them.
  async load(id, fresh) {
    await this.setup;
    await listed;
    await sweeping.get(id);
    const saved = await this.disk(() => readJson(metaPath(id)));
    const cached = saved && !saved.partial ? await this.disk(() => readTextFile(cachePath(id))) : null;
    if (cached != null && (saved.pending || !fresh)) {
      const rev = saved.pending ? 1 : 0;
      return { ...saved, rev, savedRev: rev, savedText: cached };
    }
    const p = await this.api.get(id);
    fetchedAt.set(id, Date.now());
    const m = { ...fromPage(p), pending: false, rev: 0, savedRev: 0 };
    await this.disk(() => persist(id, m, p.markdown));
    return m;
  }

  release() {
    if (owners.get(this.page) === this) owners.delete(this.page);
  }

  // Leaving a note saves it and starts its upload.
  leave(cx) {
    this.endEdit(cx, true);
    if (!this.meta) return;
    if (this.dirty && this.editor) this.save(cx);
    if (this.canUpload(this.meta)) this.push(this.page, this.meta, false, cx);
  }

  editorFor(m) {
    const editor = EditorState.new({ language: "md", value: m.savedText, line_numbers: false, folding: false, soft_wrap: true,
      readonly: m.readonly, font_family: settings().font_family, font_size: ui.text.body });
    editor.on("change", () => this.edited(m));
    return editor;
  }

  // Every local change goes through here, so a held upload is released by any edit.
  edited(m) {
    this.dirty = true; this.changedAt = Date.now(); m.held = false;
  }

  // Reads the page again when it comes into view, unless local edits are waiting (the upload
  // and its conflict check handle those). A failure keeps the text and only shows the error. True when a read started.
  refresh(cx) {
    const id = this.page, m = this.meta;
    if (!m || m.elsewhere || m.pending || m.uploading || this.dirty || this.conflict || this.editing || this.creating) return;
    const started = Date.now(), title = m.title;
    if (started - (fetchedAt.get(id) ?? 0) < REFRESH_EVERY) return;
    fetchedAt.set(id, started);
    cx.spawn(async (cx) => {
      try {
        const p = await this.api.get(id);
        if (this.meta !== m) return;
        const decision = refreshDecision({ typed: this.changedAt > started, remote: p.markdown, base: m.base });
        this.errors.refresh = null;
        // A rename made while the read was in flight is newer than the title it returns.
        const name = m.title === title ? p.title : m.title;
        if (decision === "same" && (m.url !== p.url || m.title !== name)) {
          Object.assign(m, { url: p.url, title: name });
          await this.disk(() => putMeta(id, m));
        }
        // A block opened while the read was in flight: its text stays for the next refresh.
        if (decision !== "apply" || this.editing || this.creating) return;
        Object.assign(m, fromPage(p), { title: name });
        m.readonly = m.partial;
        this.editor.release();
        this.editor = this.editorFor(m);
        await this.disk(() => persist(id, m, p.markdown));
      } catch (e) {
        // The throttle stays set, so polling retries a failed read after REFRESH_EVERY, not every tick.
        if (this.meta === m) this.errors.refresh = `Refresh failed: ${e.message}`;
      } finally {
        cx.notify();
      }
    });
    return true;
  }

  open(id, cx, fresh = false) {
    this.endEdit(cx, true);
    this.release();
    this.editor?.release();
    this.editor = null; this.page = id; this.meta = null; this.conflict = null; this.dirty = false;
    this.errors = { settings: this.errors.settings, map: this.errors.map, draft: this.errors.draft };
    if (!id) return;
    const gen = ++this.gen;
    cx.spawn(async (cx) => {
      try {
        const m = await this.load(id, fresh);
        if (this.gen !== gen) return;
        m.elsewhere = owners.has(id) && owners.get(id) !== this;
        if (!m.elsewhere) owners.set(id, this);
        m.readonly = m.partial || m.elsewhere;
        this.meta = m;
        this.editor = this.editorFor(m);
        this.refresh(cx);
      } catch (e) {
        // No editor: typing into an empty one would later overwrite the page.
        if (this.gen === gen) this.errors.open = `Cannot open note: ${e.message}`;
      }
      cx.notify();
    });
  }

  // Drops local edits: the note is read again from Notion.
  reload(cx) {
    const id = this.page, m = this.meta;
    m.pending = false;
    this.disk(() => putMeta(id, m)).catch(() => {});
    this.open(id, cx, true);
  }

  openInNotion(cx, id = this.page, url = this.meta?.url) {
    cx.spawn(async (cx) => {
      try {
        // Without an app for notion://, `open` exits non-zero and the https URL is used instead.
        let r = viaApp ? await exec("open", [pageUrl(id, url, true)]) : null;
        if (r?.code !== 0) {
          viaApp = false;
          r = await exec("open", [pageUrl(id, url, false)]);
        }
        if (r.code !== 0) throw new Error(r.stderr.trim() || `open exited with ${r.code}`);
        this.errors.link = null;
      } catch (e) {
        this.errors.link = `Cannot open in Notion: ${e.message}`;
      }
      cx.notify();
    });
  }

  toggleView(cx) {
    if (!this.endEdit(cx)) return;
    this.reading = !this.reading;
    try { localStorage.setItem("view", this.reading ? "read" : "edit"); } catch {}
    cx.notify();
  }

  overwrite(cx) {
    this.conflict = null;
    this.push(this.page, this.meta, true, cx);
  }

  async close() {
    this.endEdit(undefined, true);
    // Released after the save: a view waiting for the note reads it from disk once it is free.
    try {
      if (this.errors.draft) await this.disk(() => put(draftPath(), this.errors.draft)).catch(() => {});
      if (!this.dirty || !this.editor || !this.meta) return;
      // An upload does not fit in close's 250 ms: keep it pending for the next start.
      const id = this.page, m = this.meta, text = this.editor.value();
      // Past MAX_CHARS readTextFile would read the file back cut off, and that would be uploaded.
      if (text.length > MAX_CHARS) return;
      changed(m);
      await this.disk(() => persist(id, m, text));
    } finally {
      this.release();
    }
  }

  statusText(m) {
    if (!m) return "";
    if (m.uploading) return "Syncing…";
    if (m.elsewhere) return "Read-only: open in another view";
    if (m.partial) return "Read-only: partial page";
    return m.pending || this.dirty ? "Not synced" : "Synced";
  }

  render(cx) {
    if (this.mode === "picker") return this.renderPicker(cx);
    if (this.mode === "panel") {
      const rev = shared(MAP_REV);
      if (rev !== this.mapRev) { this.mapRev = rev; this.loadMap(cx); }
      const key = spaceKey();
      if (this.map && key !== this.key) {
        this.key = key;
        const id = spacePage(this.map);
        if ((id ?? null) !== this.page) { this.leave(cx); this.open(validId(id) ? id : null, cx); }
        else this.refresh(cx);
      }
    }
    const t = theme(), m = this.meta, pane = this.mode === "pane";
    const error = Object.values(this.errors).find(Boolean);
    const status = this.statusText(m);
    const button = (id, label, primary, action) => h_flex().id(id).h(ui.size.button).px(10).items_center().rounded(6).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(ui.text.small).cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => action(cx)).child(label);
    // The editor state stays alive while reading, so cursor and undo survive the switch.
    const body = this.reading && this.editor ? this.renderRead(cx)
      : this.editor ? Editor.new(this.editor).flex_1().min_h(0).p(6)
      : !this.page && this.mode === "panel" ? v_flex().flex_1().items_center().justify_center().gap(10)
          .child(div().text_color(t.dim).child("No note for this space"))
          .child(button("nn-choose", "Choose note", true, () => this.openPicker()))
      : div().p(12).text_color(t.dim).child(error || !this.page ? "" : "Loading note…");
    return v_flex().id("notion-notes").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(ui.text.body)
      // A pane already has Herdr's header (it shows the mod's name and no mod can change it), so
      // the pane drops the "Notes" label and keeps one compact row: page title, status, controls.
      .child(h_flex().h(pane ? ui.size.paneHeader : ui.size.header).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(!pane, (el) => el.child(div().flex_none().font_semibold().child("Notes")))
        .child(h_flex().id("nn-title").flex_1().min_w(0).when(!pane, (el) => el.justify_end()).cursor_pointer()
          .when(this.mode === "panel", (el) => el.on_click(() => this.openPicker()))
          .child(div().min_w(0).truncate().text_size(pane ? ui.text.body : ui.text.small).text_color(pane ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
            // A pane shows the title only in the editable row below; the panel keeps it here as the picker's button.
            .child(pane && this.editor ? "" : m?.title ?? (this.mode === "panel" ? "Choose note" : ""))))
        .when(Boolean(status), (el) => el.child(div().flex_none().text_size(ui.text.tiny).text_color(t.dim).child(status)))
        // Skips the 30 s throttle; refresh() still declines while local edits wait to upload.
        .when(Boolean(this.editor), (el) => el.child(button("nn-refresh", svg(`mods/${NAME}/refresh.svg`).size(ui.size.icon).text_color(t.foreground), false,
          (cx) => { fetchedAt.delete(this.page); this.refresh(cx); }).px(6)))
        .when(Boolean(this.editor), (el) => el
          .when(pane, (el) => el.child(button("nn-to-panel", "To panel", false, (cx) => this.toPanel(cx))))
          .child(button("nn-view", this.reading ? "Markdown" : "Read", false, (cx) => this.toggleView(cx)))
          .child(button("nn-notion", svg(`mods/${NAME}/external-link.svg`).size(ui.size.icon).text_color(t.foreground), false, (cx) => this.openInNotion(cx)).px(6))))
      .when(Boolean(error), (el) => el.child(div().px(14).py(6).text_size(ui.text.tiny).text_color(t.ansi1).child(error)))
      .when(Boolean(this.conflict), (el) => el.child(h_flex().px(14).py(8).gap(8).items_center().bg(t.raised).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(ui.text.small).text_color(t.blocked).child("Changed in Notion"))
        .child(button("nn-reload", "Reload", false, (cx) => this.reload(cx)))
        .child(button("nn-overwrite", "Overwrite", true, (cx) => this.overwrite(cx)))))
      .when(Boolean(this.editor), (el) => el.child(this.renderTitle(t)))
      .child(body);
  }
}

Object.assign(NotionNotes.prototype, pickerMethods, readMethods);
export default NotionNotes;
