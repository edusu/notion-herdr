# notion-notes

A Herdr Desktop mod that opens a Notion page as an editable markdown note, through the
[Notion CLI](https://developers.notion.com/cli/reference/commands) (`ntn`).

- **Panel** (a layout block, no props): the note mapped to the active space. Click the title
  (or **Choose note**) to open the picker.
- **Pane**: `pane.split {direction: "right", mod: "notion-notes", props: {page: "<page id>"}}`.
- **Picker** (dialog, `mod.open {name: "notion-notes"}`): with an empty query it lists the configured data source (or recently
  edited pages); typing searches the workspace (300 ms debounce). The last row creates a page
  with the typed title. `↑`/`↓` move, `Enter` opens in the panel, `⌘Enter` opens a pane to the
  right, `Esc` closes. With more than one configured parent, creating asks which one.

## Install

1. Install and log in to the CLI: `ntn login`; check with `ntn whoami`.
2. Copy `mods/notion-notes` to `~/.config/herdr-app/mods/notion-notes`, then
   `herdr-app check ~/.config/herdr-app/mods/notion-notes`.
3. Put it in your layout as a block, `{ "mod": "notion-notes" }`, for example as another
   child of a panel stack, with a Better Tabs button:

   ```json
   { "id": "notes", "label": "Notes", "icon": "mods/notion-notes/notes.svg",
     "when": { "node": "notion-notes" },
     "action": { "type": "panel", "container": "panel", "stack": "panel-body", "target": "notion-notes" } }
   ```

4. Optional key: `"cmd-shift-n": "mod.open:notion-notes"` in `keys.json` opens the picker
   (a copy opened with `mod.open` is the picker), whether or not the panel is shown.

## Read mode

The header's **Read** / **Edit** button switches the note (the choice is remembered) between
**Read**, a view drawn block by block, and **Edit**, the plain markdown text and the only place to
change anything but to-dos. What you can click in Read:

- **To-dos**: the checkbox marks or unmarks the item in the note, and the edit uploads like any
  other (see Sync rules). Done items show struck through. Not clickable in read-only notes, nor
  for to-dos nested inside callouts, toggles or other tags.
- **Subpages**: click opens the page in a pane to the right, ⌘-click opens it in Notion.
- **Inline databases**: a table of the first 50 rows, title column first and then the schema's order
  (the API does not give a view's column order, so filters, sorting and hidden columns of the
  Notion view are not applied). Click a row to open it in a pane to the right, ⌘-click for Notion.
  `status` and `select` values show as tags in theme colours. With more rows the footer reads
  "Showing first 50 · Open in Notion". A linked database (no data source of its own) shows as a link
  only. If the rows cannot be read the block shows one error line and the rest of the page still renders.

Callouts, toggles/details, columns, simple tables and other tags are not drawn specially: they show
as the plain markdown fallback, with child pages and databases inside them as links.

## Appending from an agent

`bin/notion-note-append` (node, no dependencies) appends markdown from stdin to the note
mapped to a folder: `--folder` (default: the current directory, then each parent until one is
in `map.json`) or `--page <id>`. It runs `ntn api v1/pages/<id>/markdown -X PATCH -d <json>`
with an `insert_content` at the end of the page, so the page body is not rewritten (Notion marks
that operation deprecated but it is the markdown endpoint's only append), using the `ntn` from
the installed mod's settings. It exits 1 with one line when no note is mapped, stdin is empty
or `ntn` fails. For an agent prompt:

```sh
printf '## Agent summary\n- what changed\n' | ~/ai/herdr/custom-mods/notion-herdr/bin/notion-note-append
```

It refuses (exit 1) while the note has edits in Herdr not yet uploaded, so an append never
forces a choice between them; retry once the note shows Synced. The check reads the note's saved
state, so typing from the last 0.8 s before the panel's next local save is not seen; that
case still ends at **Changed in Notion** in the panel, nothing is overwritten silently. An open note picks the
appended text up on its next refresh.



In the installed `mod.json`, under `settings`:

| Key | Default | Meaning |
| --- | --- | --- |
| `parents` | `[]` | `[{ "name": "Inbox", "ref": "page:<id>" }]`; `ref` is `page:<id>`, `database:<id>` or `data-source:<id>`. None: new pages are private workspace pages. |
| `datasource` | `""` | Data source (or database) id listed when the query is empty. Empty: recently edited pages. |
| `ntn` | `"ntn"` | Path to the `ntn` binary. |

## What it runs

Only `ntn`, with ids and titles passed as separate arguments, never inside a shell string:

- `ntn pages get <id> --json` to open or refresh a note and before and after each upload;
- `ntn pages edit <id>` through `sh -c '"$1" pages edit "$2" < "$3"'` (exec has no stdin).
  It never passes `--allow-deleting-content`, so child pages and databases are kept;
- `ntn pages create --json --content <frontmatter title> [--parent <ref>]`;
- `ntn datasources query <id> --limit 50 --json` for the picker's list and for an inline
  database's rows in Read mode, `ntn api v1/data_sources/<id>` for that database's columns, and
  `ntn api v1/search -d <json>`.
- once per app session, when the picker first opens, `ntn api v1/search` filtered to data
  sources, to name database parents in picker rows (failure is silent; rows show without it).

The header's open button runs `open notion://www.notion.so/<id>` (the Notion app); if that
fails it uses, for the rest of the session, `open` with the page's own https URL when it is on
a notion.so/notion.site/notion.com domain, else `https://www.notion.so/<id>`.

Uploads only follow edits: 3 s after typing stops, and when the panel switches note. There is
no polling of Notion.

## What it writes

Everything goes to `~/.config/herdr-app/notion-notes/` (not the mod folder, where a save
would reload the mod):

- `map.json`: space folder (prefixed with `machine:` for remote spaces) → page id. A local
  space without its own entry shows the note of the nearest mapped parent folder;
- `<page id>.md`: the local copy, saved every 0.8 s while typing (none for partial,
  read-only pages, which are always read from Notion);
- `<page id>.json`: `{ base, title, url, pending, partial }`. `base` is Notion's markdown at the last read
  or upload; `pending` means local edits are not in Notion yet;
- `<page id>.upload.md`: the text of the last upload.

## Sync rules

- Before uploading, the page's current markdown is compared with `base`. If Notion changed,
  nothing is written and the note shows **Changed in Notion** with **Reload** (take
  Notion's version, dropping local edits) and **Overwrite** (upload local edits anyway).
  Content is compared rather than `last_edited_time` because Notion rounds that time to the
  minute.
- A note opens from its local copy, then is read again from Notion when it is opened, when
  the panel is shown again, or when the space changes back to it: at most once per 15 s per
  page, and only without unsent edits. A Notion change replaces the text unless you typed
  meanwhile; a failed read only shows an error line.
- Pages Notion returns as truncated or with unsupported blocks, and notes over 340,000
  characters (Herdr reads at most 1 MiB per file), open read-only.
- A page already open in another view (panel and pane) opens read-only in the second one.
- Known limits: after `pages edit`, the new `base` comes from a second `pages get`, so a Notion
  edit landing between the two is not detected. An upload cut off by quitting can show
  **Changed in Notion** on the next start even though Notion has your own text; Overwrite is
  then safe.
- Closing Herdr leaves unsent edits marked `pending`. The first panel copy of the next app
  session uploads every pending note, one at a time and with the same conflict check; a
  conflict or failure stays pending, without an error until that note is opened.
- Marking a to-do in Read mode uploads the whole page through `ntn pages edit`, like any edit. If
  Notion recreates blocks on upload, comments attached to blocks could be lost; this has not been
  tested, so try it on a scratch page with a block comment before using real pages.
- A note starting with `---` is uploaded behind an empty frontmatter block, because
  `ntn pages edit` strips a leading frontmatter.

## Self-check

`node tests/self-check.mjs` runs the CLI parsing, upload ordering and conflict decision
against `tests/fake-ntn.mjs`.

## Credits

The save chain follows `tab-notes` from
[ozcberkay/herdr-coban](https://github.com/ozcberkay/herdr-coban), Apache-2.0
(`LICENSE-tab-notes`). `notes.svg` and `external-link.svg` are Lucide's `file-text` and `external-link`, ISC (`mods/notion-notes/LICENSE-lucide`).
