// The read view: the note drawn block by block from parseBlocks. It only changes text through
// toggleTodo on the editor, so uploads still send the editor's text and never one rebuilt from blocks.
import { div } from "gpui-kit";
import { v_flex, h_flex, Checkbox, TextView } from "gpui-base";
import { theme, run } from "herdr";
import { NAME } from "./store.js";
import { readable } from "./notion.js";
import { parseBlocks, toggleTodo } from "./blocks.js";

const INDENT = 18;

// One TextView per block keeps bold, code and links working. Ids are the block's first line,
// which stays unique and stable while a to-do is toggled.
const md = (id, source) => TextView.markdown(id, source).selectable(true);

export const readMethods = {
  toggleBlock(block, cx) {
    if (this.editor && !this.meta.readonly) {
      // null: the text moved under this block since it was drawn.
      const next = toggleTodo(this.editor.value(), block.from, block.label);
      if (next !== null) {
        this.editor.set_value(next);
        // The docs do not say whether set_value emits "change"; edited() is idempotent.
        this.edited(this.meta);
      }
    }
    cx.notify();
  },

  // A page opens in a pane to the right, ⌘-click opens it in Notion; a database only in Notion.
  openBlock(block, e, cx) {
    if (!block.id) return;
    if (block.type === "page" && !e.modifiers?.platform) run("pane.split", { direction: "right", mod: NAME, props: { page: block.id } });
    else this.openInNotion(cx, block.id, block.url);
  },

  renderRead(cx) {
    const t = theme(), ro = Boolean(this.meta?.readonly);
    const row = (block) => {
      const id = `nn-b-${block.from}`;
      const pad = (depth) => h_flex().flex_none().items_start().pl((depth ?? 0) * INDENT);
      switch (block.type) {
        case "todo": {
          const on = block.done;
          return pad(block.depth).gap(8)
            .child(Checkbox.new(`nn-t-${block.from}`).checked(on).disabled(ro).on_change((_v, cx) => this.toggleBlock(block, cx))
              .accessibility_label(block.label).flex().items_center().justify_center().size(15).flex_none().mt(2).rounded(4)
              .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background)
              .when(!ro, (el) => el.cursor_pointer())
              .when(on, (el) => el.child(div().text_size(11).text_color(t.accent_foreground).child("✓"))))
            .when(Boolean(block.label), (el) => el.child(div().flex_1().min_w(0).text_color(on ? t.dim : t.foreground)
              .child(md(id, on ? `~~${block.label}~~` : block.label))));
        }
        case "bullet":
        case "numbered":
          return pad(block.depth).gap(6)
            .child(div().flex_none().text_color(t.muted).child(block.type === "bullet" ? "•" : /\d+[.)]/.exec(block.raw)[0]))
            .child(div().flex_1().min_w(0).child(md(id, block.text)));
        case "paragraph":
          return pad(block.depth).child(div().flex_1().min_w(0).child(md(id, block.text)));
        case "quote":
          return div().flex_none().border_l(2).border_color(t.border).pl(10).text_color(t.muted).child(md(id, block.text));
        case "code":
          return div().flex_none().rounded(6).bg(t.raised).p(8).child(md(id, block.raw));
        case "divider":
          return div().flex_none().h(1).my(6).bg(t.border);
        case "page":
        case "database":
          return h_flex().id(`nn-p-${block.from}`).flex_none().h(28).px(6).gap(8).items_center().rounded(6)
            .when(Boolean(block.id), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((e, cx) => this.openBlock(block, e, cx)))
            .child(div().flex_none().child(block.type === "page" ? "📄" : "🗃️"))
            .child(div().flex_1().min_w(0).truncate().child(block.title));
        case "empty":
        case "blank":
          return div().flex_none().h(8);
        case "heading":
          return md(id, block.raw);
        default:
          return md(id, readable(block.raw));
      }
    };
    return v_flex().id("nn-read").flex_1().min_h(0).overflow_y_scrollbar().px(14).py(10).gap(4)
      .children(parseBlocks(this.editor.value()).map(row));
  },
};
