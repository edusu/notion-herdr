// The read view: the note drawn block by block from parseBlocks. It only changes text through
// toggleTodo, moveBlock and the open block's write-back on the editor, so uploads still send the editor's text and never one rebuilt from blocks.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Checkbox, Collapsible, TextView, Input, InputState, Popup } from "gpui-base";
import { theme, run } from "herdr";
import { NAME, REFRESH_EVERY } from "./store.js";
import { ui } from "./ui.js";
import { readable } from "./notion.js";
import { parseBlocks, children, toggleTodo, cell, replaceBlock, insertAfter, moveBlock, retype, continuation, editParts, nextEditable, slashQuery, commands, editableCell } from "./blocks.js";

const INDENT = 18;

// Notion colour name → Herdr theme token; anything else is muted.
const TAG_COLORS = { red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", purple: "ansi5", pink: "ansi13", orange: "ansi11", brown: "ansi3" };

// Data source id → { at, busy, data, error }, shared by every view. `at` is set when a read
// starts, so a failed read waits out the same throttle as a good one.
const sources = new Map();
// Bumped when any read ends: every view showing that data source redraws on its next tick, not
// only the one that started the read.
let sourcesRev = 0;
export const sourcesChanged = () => sourcesRev;

const tag = (t, text, color) => {
  const ink = t[TAG_COLORS[color] ?? "muted"];
  return div().min_w(0).truncate().rounded(10).border_1().border_color(ink).bg(t.raised).px(6).text_size(ui.text.small).text_color(ink).child(text);
};

// One TextView per block keeps bold, code and links working. Ids are the block's first line,
// which stays unique and stable while a to-do is toggled.
const md = (id, source) => TextView.markdown(id, source).selectable(true);

const HEADING_TEXT = [null, "title", "h2", "h3"];
const LISTS = new Set(["bullet", "numbered", "todo"]);
// Enter and Backspace on an empty field of these types turn it into a paragraph first.
const LEAVES_TYPE = new Set([...LISTS, "heading", "quote"]);
const sameBlock = (a, b) => a.from === b.from && a.raw === b.raw;
// Released late because closing can run inside the state's own submit or blur event.
export const release = (state, cx) => (cx ? cx.timer.after(300, () => state.release()) : state.release());
const menuBox = (id, w, t) => v_flex().id(id).w(w).p(4).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover);
const menuRow = (id, on, t) => h_flex().id(id).h(ui.size.row).px(8).items_center().rounded(4).cursor_pointer()
  .when(on, (r) => r.bg(t.hover)).hover((s) => s.bg(t.hover));

export const readMethods = {
  toggleBlock(block, cx) {
    // The open block is saved first, so a click on its own checkbox ticks the saved text and does not leave the field stale.
    if (this.editor && !this.meta.readonly && this.endEdit(cx)) {
      const cur = this.blocks().find((b) => b.from === block.from) ?? block;
      // null: the text moved under this block since it was drawn.
      const next = toggleTodo(this.editor.value(), cur.from, cur.label);
      if (next !== null) this.setText(next);
    }
    cx.notify();
  },

  // Every change the read view makes to the note goes through here.
  setText(next, m = this.meta) {
    this.editor.set_value(next);
    // The docs do not say whether set_value emits "change"; edited() is idempotent.
    this.edited(m);
  },

  isEditing(block) {
    return Boolean(this.editing) && sameBlock(this.editing.block, block);
  },

  // Opens `block` in a field that holds only its text. The caller has closed the previous block.
  startEdit(block, cx, atEnd = false) {
    const parts = editParts(block);
    if (!parts || this.meta.readonly) return;
    const state = InputState.new({ value: parts.text });
    // Only the open block reacts: a state that was just closed may still deliver its blur.
    state.on("blur", (_e, cx) => { if (this.editing?.state === state) this.endEdit(cx); });
    // Enter reaches submit after the wrapper's key handler, so an open menu is settled here.
    state.on("submit", (_e, cx) => {
      if (this.editing?.state !== state) return;
      const pick = this.menu()[this.editing.slash?.at];
      if (pick) this.command(pick.id, cx); else this.enter(cx);
      cx.notify();
    });
    state.on("change", (_e, cx) => {
      const ed = this.editing;
      if (ed?.state !== state) return;
      const value = state.value();
      if (ed.block.after && value && !this.addLine()) return cx.notify();
      const hit = slashQuery(ed.last, value);
      ed.last = value;
      ed.slash = hit && { ...hit, at: 0 };
      cx.notify();
    });
    this.fieldFocus ??= cx.focus_handle();
    this.errors.draft = null;
    this.editing = { block, state, ...parts, stale: false, last: parts.text, slash: null };
    state.focus();
    if (atEnd) state.set_selected_range({ start: parts.text.length, end: parts.text.length });
  },

  // Puts the line a click below the note opened into the note, on the first key typed in it.
  addLine() {
    const ed = this.editing;
    if (!this.apply(insertAfter(this.editor.value(), ed.block.after, ""))) return false;
    ed.block = this.blocks().find((b) => b.from === ed.block.from);
    ed.added = true;
    return true;
  },

  closeEdit(cx) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    release(ed.state, cx);
  },

  // The raw line the open field stands for; a single line, and the block's own raw when untouched.
  draft() {
    const { block, state, prefix, text } = this.editing;
    const value = state.value().replace(/\r?\n/g, " ");
    return value === text ? block.raw : prefix + value;
  },

  // Puts the note's new text into the editor. A null `next` means the open block is stale:
  // the field is flagged and false is returned.
  apply(next) {
    this.editing.stale = next === null;
    if (this.editing.stale) return false;
    this.setText(next);
    return true;
  },

  // Replaces the open block's lines by `raw`.
  write(raw) {
    return this.apply(replaceBlock(this.editor.value(), this.editing.block, raw));
  },

  commit() {
    const raw = this.draft();
    return raw === this.editing.block.raw || this.write(raw);
  },

  // Saves and closes the open block. A stale one stays open with its draft unless `force`d
  // (the page or view is going away). True when nothing is left open.
  endEdit(cx, force = false) {
    // Every path that ends or switches block editing also ends a cell or title edit, so only one field is ever open.
    this.endCell(cx);
    this.endTitle(cx);
    if (!this.editing) return true;
    // A line added by a click below the note is taken out again when nothing was typed in it.
    const ok = this.editing.added && !this.editing.state.value() ? this.write(null) : this.commit();
    if (!ok && force) this.errors.draft = `Not saved, the block changed in Notion: ${this.draft()}`;
    if (ok || force) this.closeEdit(cx);
    cx?.notify();
    return ok || force;
  },

  // Closes the open block and opens the one that starts at `line` of the current text, if editable.
  openAt(line, cx, atEnd = false) {
    this.closeEdit(cx);
    const block = this.blocks().find((b) => b.from === line);
    if (block) this.startEdit(block, cx, atEnd);
  },

  // Replaces the open block by `raw` and keeps editing the block that takes its place.
  swap(raw, cx) {
    const line = this.editing.block.from;
    if (this.write(raw)) this.openAt(line, cx);
  },

  // The commands shown under the open field; none while the block is stale.
  menu() {
    const ed = this.editing;
    return ed?.slash && !ed.stale ? commands(ed.slash.query).filter((c) => c.id !== "page" || !this.creating) : [];
  },

  // Removes the typed `/query`, closes the menu and turns the block into `id`, puts a divider below it, or creates a subpage in its place.
  command(id, cx) {
    const { block, state, prefix, slash } = this.editing;
    const end = slash.start + 1 + slash.query.length, value = state.value();
    const clean = value.slice(0, slash.start) + value.slice(end);
    state.set_value(clean);
    this.editing.slash = null;
    const text = clean.replace(/\r?\n/g, " ");
    if (id === "page") {
      this.closeEdit(cx);
      return this.createPage(block, text.trim() || "Untitled", cx);
    }
    if (id !== "divider") return this.swap(retype(prefix + text, id), cx);
    // `---` under a text line would read as a setext heading. write("***\n") leaves an empty line below the divider; that line is the one that opens.
    if (this.write(text === "" ? "***\n" : `${prefix + text}\n***\n`)) this.openAt(block.from + (text === "" ? 1 : 2), cx);
  },

  enter(cx) {
    const { block, state, prefix } = this.editing;
    if (!state.value() && LISTS.has(block.type)) return this.swap(retype(prefix, "paragraph"), cx);
    if (!this.commit()) return;
    const cur = this.blocks().find((b) => b.from === block.from);
    // The draft opened a block that takes the lines below (a code fence, a table, a toggle): nothing is inserted.
    if (!cur || cur.to !== cur.from) return this.closeEdit(cx);
    if (this.apply(insertAfter(this.editor.value(), cur, continuation(cur)))) this.openAt(cur.to + 1, cx);
  },

  backspace(cx) {
    const { block, state, prefix } = this.editing;
    if (state.value()) return;
    if (block.after) return this.endEdit(cx);
    if (LEAVES_TYPE.has(block.type)) return this.swap(retype(prefix, "paragraph"), cx);
    const prev = nextEditable(this.blocks(), block.from, -1);
    if (!this.apply(replaceBlock(this.editor.value(), block, null))) return;
    // Blocks above the deleted lines keep their line numbers.
    if (prev) this.openAt(prev.from, cx, true);
    else this.closeEdit(cx);
  },

  move(step, cx) {
    const target = nextEditable(this.blocks(), this.editing.block.from, step);
    if (target && this.commit()) this.openAt(target.from, cx, true);
  },

  fieldKey(e, cx) {
    // Enter is left to the field's submit event. Backspace only arrives here when the field is empty.
    const n = this.menu().length, slash = this.editing.slash;
    switch (e.keystroke) {
      case "escape": if (n) this.editing.slash = null; else { this.endEdit(cx); return; } break;
      case "up": if (n) slash.at = (slash.at + n - 1) % n; else this.move(-1, cx); break;
      case "down": if (n) slash.at = (slash.at + 1) % n; else this.move(1, cx); break;
      case "backspace": this.backspace(cx); break;
      default: return;
    }
    cx.notify();
  },

  // A click below the last block writes at the end of the note: in its trailing empty line, or in a new one
  // that addLine puts in the note once something is typed, so a click alone changes nothing.
  writeAtEnd(e, cx) {
    if (e.modifiers?.platform || this.meta.readonly || !this.endEdit(cx)) return;
    const last = this.blocks().at(-1);
    if (last.type === "blank") this.startEdit(last, cx);
    // A last tag that takes the lines below it (a code fence, a table) has no line to write in.
    else if (parseBlocks(`${this.editor.value()}\n`).at(-1).type === "blank") {
      this.startEdit({ type: "blank", from: last.to + 1, to: last.to + 1, raw: "", after: last }, cx);
    }
    cx.notify();
  },

  // A click on block B runs before the blur of the open block A, so A is saved here first.
  editBlock(block, e, cx) {
    if (e.modifiers?.platform || this.meta.readonly || !this.endEdit(cx)) return;
    this.startEdit(block, cx);
    cx.notify();
  },

  field(t, size) {
    const ed = this.editing, items = this.menu();
    return v_flex().flex_1().min_w(0).gap(2)
      .child(Popup.new("nn-slash", h_flex().id("nn-field").track_focus(this.fieldFocus).on_key_down((e, cx) => this.fieldKey(e, cx))
        .child(Input.new(ed.state).flex_1().text_size(size).text_color(t.foreground))).anchor("bottom_left")
        .when(items.length > 0, (el) => el.content(menuBox("nn-menu", ui.size.menu, t)
          .children(items.map((c, i) => menuRow(`nn-cmd-${c.id}`, i === ed.slash.at, t).text_size(ui.text.small).text_color(t.foreground)
            .on_click((_e, cx) => { this.command(c.id, cx); cx.notify(); }).child(c.label))))))
      .when(ed.stale, (el) => el.child(h_flex().gap(8).items_center().text_size(ui.text.tiny).text_color(t.blocked)
        .child(div().flex_1().min_w(0).child("This block changed in Notion; copy your text or discard it"))
        .child(h_flex().id("nn-discard").h(ui.size.smallButton).px(8).items_center().flex_none().rounded(6).border_1().border_color(t.input)
          .bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => { this.closeEdit(cx); cx.notify(); }).child("Discard"))));
  },

  // Closes the open cell edit (a select menu or an input) without saving.
  closeCell(cx) {
    const c = this.cellEdit;
    if (!c) return;
    this.cellEdit = null;
    if (c.state) release(c.state, cx);
  },

  // Saves and closes the open cell edit; with no `cx` (the view is going away) a draft is dropped.
  endCell(cx) {
    const c = this.cellEdit, value = c?.state?.value();
    this.closeCell(cx);
    if (value === undefined || !cx) return;
    if (!c.row) { if (value.trim()) this.addRow(c, value.trim(), cx); } else if (value !== c.text) this.writeCell(c, value, cx);
    cx.notify();
  },

  // Runs a write on the serial Notion queue. Nothing is drawn before Notion answers: success marks
  // the table stale so the next render reads it again, failure shows under its row until a read succeeds.
  mutate(c, job, cx, done) {
    const e = c.e, key = c.id;
    (e.writing ??= new Set()).add(key);
    cx.spawn(async (cx) => {
      try {
        const r = await this.net(job);
        e.at = 0;
        done?.(r);
      } catch (err) {
        (e.errors ??= new Map()).set(c.row?.id ?? key, err.message);
      } finally {
        e.writing.delete(key);
        sourcesRev++;
        cx.notify();
      }
    });
  },

  writeCell(c, value, cx) {
    this.mutate(c, () => this.api.setProperty(c.row.id, c.col, value), cx);
  },

  addRow(c, title, cx) {
    const m = this.meta;
    this.mutate(c, () => this.api.addRow(c.source, c.col.name, title), cx, (made) => {
      if (this.meta === m) this.openPage(made.id, made.url, {}, cx);
    });
  },

  openInput(c, cx) {
    const state = InputState.new({ value: c.text });
    const done = (_e, cx) => { if (this.cellEdit?.state === state) { this.endCell(cx); cx.notify(); } };
    state.on("blur", done);
    state.on("submit", done);
    this.fieldFocus ??= cx.focus_handle();
    this.cellEdit = { ...c, state };
    state.focus();
  },

  // A click on a cell edits it instead of opening the row; ⌘-click is left to the row.
  clickCell(c, e, cx) {
    if (e.modifiers?.platform) return;
    cx.stop_propagation();
    // The press that closes an open menu arrives just before this click: it must not reopen it.
    const again = this.menuClosed?.id === c.id && Date.now() - this.menuClosed.at < 400;
    if (again || c.e.writing?.has(c.id) || !this.endEdit(cx)) return;
    if (c.col.type === "checkbox") this.writeCell(c, !c.prop?.checkbox, cx);
    else if (c.col.type === "select" || c.col.type === "status") this.cellEdit = c;
    else this.openInput(c, cx);
    cx.notify();
  },

  pickOption(c, name, cx) {
    cx.stop_propagation();
    this.closeCell(cx);
    if ((name ?? "") !== c.text) this.writeCell(c, name, cx);
    cx.notify();
  },

  cellInput(t) {
    return h_flex().id("nn-cell-input").flex_1().min_w(0).track_focus(this.fieldFocus)
      .on_click((_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => { if (e.keystroke === "escape") { this.closeCell(cx); cx.notify(); } })
      .child(Input.new(this.cellEdit.state).flex_1().text_size(ui.text.small).text_color(t.foreground));
  },

  // The options of a select or status cell, each drawn as its tag; only select can be emptied.
  cellMenu(c, t) {
    const items = [...(c.col.type === "select" ? [{ name: null }] : []), ...c.col.options];
    return menuBox(`${c.id}-menu`, ui.size.cellMenu, t)
      .on_click((_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((_e, cx) => { this.menuClosed = { id: c.id, at: Date.now() }; this.closeCell(cx); cx.notify(); })
      .children(items.map((o) => menuRow(`${c.id}-o-${o.name ?? ""}`, (o.name ?? "") === c.text, t)
        .on_click((_e, cx) => this.pickOption(c, o.name, cx))
        .child(o.name === null ? div().text_size(ui.text.small).text_color(t.muted).child("Empty") : tag(t, o.name, o.color))));
  },

  // A page opens in a pane to the right, ⌘-click opens it in Notion.
  openPage(id, url, e, cx) {
    if (e.modifiers?.platform) this.openInNotion(cx, id, url);
    else run("pane.split", { direction: "right", mod: NAME, props: { page: id } });
  },

  // A database opens only in Notion: pane mode reads pages.
  openBlock(block, e, cx) {
    if (!block.id) return;
    if (block.type === "page") this.openPage(block.id, block.url, e, cx);
    else this.openInNotion(cx, block.id, block.url);
  },

  // A press on a block's handle starts dragging it; the open field is saved first, as a click on another block does.
  startDrag(block, cx) {
    cx.stop_propagation();
    if (!this.endEdit(cx)) return;
    this.drag = { block: this.blocks().find((b) => b.from === block.from) ?? block, before: null, text: this.editor.value() };
    // Escape reaches the read view only while it holds the keyboard.
    (this.readFocus ??= cx.focus_handle()).focus();
    cx.notify();
  },

  // `before` is the line the dragged block would land above, as moveBlock takes it.
  dragTo(before, cx) {
    if (!this.drag || this.drag.before === before) return;
    this.drag.before = before;
    cx.notify();
  },

  // Ends a drag, moving the block to where the indicator is when `drop`. A text that changed during the
  // drag (a refresh, another page) cancels it: `before` was picked on the old lines.
  endDrag(drop, cx) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const text = this.editor?.value();
    const next = drop && d.before !== null && text === d.text && !this.meta?.readonly && !this.creating ? moveBlock(text, d.block, d.before) : null;
    if (next !== null && next !== text) this.setText(next);
    cx.notify();
  },

  // The rows under a database's title: the table, "Loading…" or the read error. Draws from the
  // cache and starts a read when it is older than REFRESH_EVERY.
  renderSource(block, t, cx) {
    let e = sources.get(block.source);
    if (!e) sources.set(block.source, (e = {}));
    if (!e.busy && Date.now() - (e.at ?? 0) >= REFRESH_EVERY) {
      e.busy = true;
      e.at = Date.now();
      cx.spawn(async (cx) => {
        try {
          await this.setup;
          e.data = await this.api.source(block.source);
          e.error = null;
          e.errors = null;
        } catch (err) {
          e.error = err.message;
        } finally {
          e.busy = false;
          sourcesRev++;
          cx.notify();
        }
      });
    }
    const note = (text, color) => div().flex_none().px(6).text_size(ui.text.small).text_color(color).child(text);
    const errorOf = (k) => (e.errors?.has(k) ? [note(e.errors.get(k), t.ansi1)] : []);
    const action = (id, label, onClick) => h_flex().id(id).flex_none().px(6).py(4).cursor_pointer().text_size(ui.text.small).text_color(t.muted)
      .on_click(onClick).child(label);
    const d = e.data;
    if (!d) return [e.error ? note(e.error, t.ansi1) : note("Loading…", t.dim)];
    const ro = Boolean(this.meta?.readonly), title = d.columns.find((col) => col.type === "title");
    // The cell's own state is named by the table's first line and the row, so two tables never share one.
    const cells = (r) => d.columns.map((col, c) => {
      const prop = r.properties[col.name], { text, color } = cell(prop);
      const id = `nn-c-${block.from}-${r.id}-${c}`, edit = !ro && editableCell(col, prop);
      const menu = edit && (col.type === "select" || col.type === "status");
      const view = (el) => el.flex_1().flex_grow(c === 0 ? 2 : 1).min_w(0).overflow_hidden().when(e.writing?.has(id), (v) => v.opacity(0.5));
      const body = color !== undefined && text ? tag(t, text, color)
        : col.type === "checkbox" && edit && !text ? div().text_color(t.muted).child("☐") : div().min_w(0).truncate().child(text);
      if (!edit) return view(h_flex()).child(body);
      const mine = this.cellEdit?.id === id, data = { id, e, row: r, col, prop, text };
      if (mine && this.cellEdit.state) return view(h_flex()).child(this.cellInput(t));
      const click = h_flex().id(id).w_full().min_w(0).cursor_pointer().on_click((ev, cx) => this.clickCell(data, ev, cx)).child(body);
      return view(h_flex()).child(menu ? Popup.new(`${id}-pop`, click).anchor("bottom_left").w_full().min_w(0)
        .when(mine, (p) => p.content(this.cellMenu(data, t))) : click);
    });
    const adding = `nn-n-${block.from}`;
    const newRow = () => this.cellEdit?.id === adding ? h_flex().flex_none().px(6).py(2).child(this.cellInput(t))
      : e.writing?.has(adding) ? note("Creating row…", t.muted)
      : action(adding, "+ New", (ev, cx) => this.clickCell({ id: adding, e, source: block.source, col: title, prop: {}, text: "" }, ev, cx));
    return [
      h_flex().flex_none().px(6).py(2).gap(8).border_b(1).border_color(t.border).text_size(ui.text.small).text_color(t.muted)
        .children(d.columns.map((col, c) => div().flex_1().flex_grow(c === 0 ? 2 : 1).min_w(0).truncate().child(col.name))),
      ...d.rows.flatMap((r, i) => [h_flex().id(`nn-r-${block.from}-${i}`).flex_none().min_h(ui.size.row).px(6).gap(8).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((ev, cx) => this.openPage(r.id, r.url, ev, cx))
        .children(cells(r)), ...errorOf(r.id)]),
      ...(!ro && title ? [newRow(), ...errorOf(adding)] : []),
      ...(d.more ? [action(`nn-m-${block.from}`, "Showing first 50 · Open in Notion", (ev, cx) => this.openBlock(block, ev, cx))] : []),
      ...(e.error ? [note(e.error, t.ansi1)] : []),
    ];
  },

  renderRead(cx) {
    const t = theme(), ro = Boolean(this.meta?.readonly);
    this.openToggles ??= new Set();
    // `base` is set for a container's children: they are indented from the container's own edge and are never edited in place.
    const row = (block, base = null) => {
      const id = `nn-b-${block.from}`;
      const pad = (depth) => h_flex().flex_none().items_start().pl(Math.max(0, depth - (base ?? 0)) * INDENT);
      const editable = !ro && base === null && editParts(block) !== null;
      // A text cell opens its block for editing on click; while open, the field takes its place.
      const inPlace = (view, size = ui.text.body) => this.isEditing(block) ? this.field(t, size)
        : editable ? view.id(`nn-e-${block.from}`).on_click((e, cx) => this.editBlock(block, e, cx)) : view;
      if (this.creating && sameBlock(this.creating, block)) return pad(0).child(div().text_color(t.muted).child("Creating page…"));
      switch (block.type) {
        case "todo": {
          const on = block.done;
          return pad(block.depth).gap(8)
            .child(Checkbox.new(`nn-t-${block.from}`).checked(on).disabled(ro).on_change((_v, cx) => this.toggleBlock(block, cx))
              .accessibility_label(block.label).flex().items_center().justify_center().size(ui.size.check).flex_none().mt(2).rounded(4)
              .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background)
              .when(!ro, (el) => el.cursor_pointer())
              .when(on, (el) => el.child(div().text_size(ui.text.tiny).text_color(t.accent_foreground).child("✓"))))
            .when(Boolean(block.label) || editable, (el) => el.child(inPlace(div().flex_1().min_w(0).min_h(ui.size.line).text_color(on ? t.dim : t.foreground)
              .when(Boolean(block.label), (d) => d.child(md(id, on ? `~~${block.label}~~` : block.label))))));
        }
        case "bullet":
        case "numbered":
          return pad(block.depth).gap(6)
            .child(div().flex_none().text_color(t.muted).child(block.type === "bullet" ? "•" : block.marker))
            .child(inPlace(div().flex_1().min_w(0).min_h(ui.size.line).child(md(id, block.text))));
        case "paragraph":
          return pad(block.depth).child(inPlace(div().flex_1().min_w(0).child(md(id, block.text))));
        case "quote":
          return div().flex_none().border_l(2).border_color(t.border).pl(10).text_color(t.muted).child(inPlace(div().min_w(0).child(md(id, block.text))));
        case "code":
          return div().flex_none().rounded(6).bg(t.raised).p(8).child(md(id, block.raw));
        case "divider":
          return div().flex_none().h(1).my(6).bg(t.border);
        case "page":
        case "database": {
          const link = h_flex().id(`nn-p-${block.from}`).flex_none().h(ui.size.block).px(6).gap(8).items_center().rounded(6)
            .when(Boolean(block.id), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((e, cx) => this.openBlock(block, e, cx)))
            .child(div().flex_none().child(block.type === "page" ? "📄" : "🗃️"))
            .child(div().flex_1().min_w(0).truncate().child(block.title));
          // A linked database has no data source of its own, so it stays a link.
          return block.type === "database" && block.source
            ? v_flex().flex_none().gap(2).child(link).children(this.renderSource(block, t, cx))
            : link;
        }
        case "empty":
        case "blank":
          return pad(0).child(inPlace(div().flex_none().h(8)));
        case "heading":
          return pad(0).child(inPlace(div().flex_1().min_w(0).child(md(id, block.raw)), ui.text[HEADING_TEXT[block.level]]));
        default: {
          const inner = children(block);
          if (!inner) return md(id, readable(block.raw));
          const body = v_flex().flex_1().min_w(0).gap(4).children(inner.blocks.map((b) => row(b, inner.nest)));
          if (block.tag === "callout") {
            return h_flex().flex_none().items_start().gap(8).p(10).rounded(8).bg(t.raised)
              .when(Boolean(inner.icon), (el) => el.child(div().flex_none().child(inner.icon))).child(body);
          }
          const open = this.openToggles.has(block.from);
          return Collapsible.new().flex().flex_col().flex_none().open(open)
            .child(h_flex().id(`nn-d-${block.from}`).flex_none().min_h(ui.size.block).gap(6).items_center().cursor_pointer()
              .on_click((_e, cx) => { if (open) this.openToggles.delete(block.from); else this.openToggles.add(block.from); cx.notify(); })
              .child(div().flex_none().w(ui.size.arrow).text_color(t.muted).child(open ? "▾" : "▸"))
              .child(div().flex_1().min_w(0).child(md(`nn-s-${block.from}`, inner.summary ?? ""))))
            .content(h_flex().flex_none().pl(INDENT).child(body));
        }
      }
    };
    const blocks = this.blocks(), ed = this.editing, d = this.drag, last = blocks.at(-1);
    const handles = !ro && !this.creating;
    // The gap the dragged block would land in; none while it would stay where it is.
    const gap = d && d.before !== null && (d.before < d.block.from || d.before > d.block.to + 1) ? d.before : null;
    // Each top-level block sits beside a gutter holding its drag handle, shown while the pointer is on the row.
    const grip = (b, el) => h_flex().id(`nn-g-${b.from}`).relative().flex_none().items_start()
      .on_hover((on, cx) => {
        const h = on ? b.from : this.hoverBlock === b.from ? null : this.hoverBlock;
        if (h !== this.hoverBlock) { this.hoverBlock = h; cx.notify(); }
      })
      .on_mouse_move((e, cx) => this.dragTo(e.local_position.y < e.bounds.height / 2 ? b.from : b.to + 1, cx))
      .when(d?.block.from === b.from, (r) => r.opacity(0.4))
      .child(div().id(`nn-h-${b.from}`).flex_none().w(ui.size.grip).h(ui.size.line).flex().items_center().justify_center().cursor_grab()
        .when(!handles || (this.hoverBlock !== b.from && d?.block.from !== b.from), (h) => h.invisible())
        .when(handles, (h) => h.on_mouse_down("left", (_e, cx) => this.startDrag(b, cx)))
        .child(svg(`mods/${NAME}/grip-vertical.svg`).size(ui.size.icon).text_color(t.muted)))
      .child(v_flex().flex_1().min_w(0).child(el))
      .when(gap === b.from || (b === last && gap === b.to + 1), (r) => r.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(gap === b.from, (l) => l.top(-3)).when(gap !== b.from, (l) => l.bottom(-3))));
    const rows = blocks.map((b) => grip(b, row(b)));
    // The open block no longer matches any block of the note: keep its draft on screen with the notice.
    // A line not yet added (writeAtEnd) is drawn there as well, and is only stale if adding it failed.
    if (ed && !blocks.some((b) => sameBlock(b, ed.block))) { ed.stale ||= !ed.block.after; rows.push(h_flex().flex_none().pl(ui.size.grip).child(this.field(t, ui.text.body))); }
    if (!ro) {
      rows.push(div().id("nn-tail").flex_grow(1).min_h(64).pl(ui.size.grip).cursor_pointer().text_color(t.dim)
        .on_click((e, cx) => this.writeAtEnd(e, cx)).on_mouse_move((_e, cx) => this.dragTo(last.to + 1, cx))
        .when(!ed && this.parsedText === "", (el) => el.child("Click to write")));
    }
    return v_flex().id("nn-read").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).gap(4)
      // A release anywhere in the list ends the drag; leaving the list or Escape cancels it.
      .on_mouse_up("left", (_e, cx) => this.endDrag(true, cx))
      .on_hover((on, cx) => { if (!on) this.endDrag(false, cx); })
      .when(Boolean(d), (el) => el.cursor_grabbing().track_focus(this.readFocus)
        .on_key_down((e, cx) => { if (e.keystroke === "escape") this.endDrag(false, cx); }))
      .children(rows);
  },

  // Renders happen far more often than edits, so the parse is kept until the text changes.
  blocks() {
    const text = this.editor.value();
    // An empty note gets one blank block, so there is always a line to click and Backspace never removes the last one.
    if (text !== this.parsedText) { this.parsedText = text; this.parsed = text ? parseBlocks(text) : [{ type: "blank", from: 0, to: 0, raw: "" }]; }
    return this.parsed;
  },
};
