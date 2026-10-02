# Hermes

An outliner, a markdown vault and a database in one local-first app.

- **Outlining from Tana.** Every note is a tree of bullets. Zoom into a bullet, drag to reorder, tag with `#tags`, add fields as child bullets, link with `[[pages]]`.
- **Files from Obsidian.** You open a folder. Every note is a plain `.md` file in that folder, with YAML frontmatter, wikilinks, tasks, headings, code blocks and tables preserved exactly as written.
- **Views from Airtable.** Every tag is a database. Tagged bullets and tagged pages become records you can sort, filter, group, edit in place, and switch between a table and a board.
- **Live editing.** Rows render markdown as you move between them (live preview). Each edit is written to disk about 350 ms after you stop typing. If another app changes a file, the open page updates within a couple of seconds.

No whiteboards and no graph view, by design.

## Run it

```
npm start            # serves http://localhost:8080
```

Any static server works (`python3 -m http.server 8080`). There is no build step and no runtime dependency.

Open it in Chrome, Edge or Arc and choose **Open a folder**, or choose **Try the demo vault** to see a populated workspace first. Install it from the browser menu if you want a standalone window (it is a PWA and works offline once loaded).

Other browsers can run the demo vault, which lives in the browser's private storage. Opening a real folder needs the File System Access API, which today means a Chromium browser.

## How your markdown maps to the app

```markdown
---
tags: [project]            # frontmatter: page-level fields. A tagged page is a record.
status: Active
owner: "[[Ada Lovelace]]"
---
- Planning notes
  - [ ] Write launch post #task      # a tagged bullet is a record
    - status:: In progress           # child `name:: value` bullets are its fields
    - due:: 2026-10-12
    - project:: [[Hermes Launch]]
```

| In the file | In Hermes |
| --- | --- |
| `- bullet`, nested by indentation | Outline node (tabs or spaces, whichever the file already uses) |
| `- [ ]` / `- [x]` | Task checkbox |
| `# Heading` | Heading node that owns the content under it |
| `#tag` | Tag. Tagged bullets and tagged pages are records of that tag |
| `name:: value` child bullet | Field of the parent bullet |
| `[[Page]]`, `[[Page\|alias]]` | Link. Backlinks appear at the bottom of the target page |
| frontmatter keys | Page properties and the fields of page records |
| code fences, tables, quotes, paragraphs | Kept byte for byte and rendered in place |

Hermes only rewrites a file when you edit it, and an edit only changes the lines you touched. Untouched YAML, CRLF line endings, tab indentation and byte order marks are preserved.

Column types, saved views and select options are stored in `.hermes/config.json` inside your vault. Delete that file to reset them. Your notes never depend on it.

## The local database

Hermes parses every note into an in-memory record store and builds its indexes (tags, links, fields, full text) from that. Parsed content is cached in IndexedDB keyed by file modification time, so reopening a vault only re-reads files that changed. Views are queries over that store, so filters, sorting and grouping do not touch the disk.

Measured in headless Chromium on a synthetic vault of 3,000 notes (about 147,000 bullets, 36,000 tagged records):

| Operation | Time |
| --- | --- |
| Cold open | 2.5 s |
| Warm open (IndexedDB cache) | 1.0 s |
| Render the 36,000 record table | 0.4 s |
| Search all records | 0.16 s |
| One change-detection pass over 3,000 files | 0.4 s |
| Keystroke handler | 0.4 ms average |

Run `npm run test:perf` to reproduce it on your machine.

## Keyboard

| Keys | Action |
| --- | --- |
| `Enter` | New bullet. On an empty nested bullet it outdents. `Shift+Enter` adds a line break |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Alt+Up` / `Alt+Down` | Move the bullet |
| `Ctrl/Cmd+Up` / `Down` | Collapse / expand |
| `Ctrl/Cmd+Enter` | Bullet, then task, then done |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` | Undo / redo, including structure changes |
| `Ctrl/Cmd+Shift+Backspace` | Delete the bullet and its children |
| `#`, `[[`, `/` at the start | Tag, link and command menus |
| `Ctrl/Cmd+B`, `Ctrl/Cmd+I` | Bold, italic |
| `Ctrl/Cmd+K` | Search pages, bullets, tags and commands |
| `Alt+N`, `Alt+D` | New page (`Folder/Name` works), today's daily note |
| `Ctrl/Cmd+\` | Toggle the sidebar |
| `Alt+Left` / `Alt+Right` | Back / forward |

Pasting a multi-line list or outline into a bullet creates a node per line.

## Database views

Open a tag from the sidebar, or **All pages** to treat every page as a record.

- **Table.** Click a cell to edit it. Text, number, date, select, checkbox, URL and page-link types. Drag column edges to resize, use the header menu to rename a field, change its type, sort, group or hide it. The footer sums number columns.
- **Board.** Pick any field for the columns, drag cards between columns, add a card to a column.
- **Record editor.** The arrow in the row gutter, or any board card, opens every field in one form.
- **Saved views.** Several views per tag, each with its own filters, sorts, grouping and columns.
- **New.** Adds a tagged bullet to `Inbox.md`. The menu next to it creates a full page record in a `<tag>/` folder instead.

Changing a task's `status` to `Done` checks the task, and checking the task sets `status` to `Done`.

## Layout of the code

```
index.html, styles/app.css      shell and design tokens (light, dark, mobile)
src/md.js                       markdown <-> outline model, frontmatter, inline renderer
src/store.js                    vault: folder access, saving, change detection, indexes
src/idb.js                      IndexedDB cache and the recent-vault list
src/query.js                    records, field types, filter / sort / group
src/outline.js                  the page editor
src/database.js                 table, board and record editor
src/app.js                      sidebar, routing, command palette, vault lifecycle
src/seed.js                     demo vault
tests/                          unit checks and browser tests
```

## Tests

```
npm install
npm test             # unit checks plus browser tests (Playwright)
```

The browser tests drive the real UI against a real directory handle and then read the resulting markdown back, so they check what lands on disk. They cover outline editing and undo, tag and link menus, table and board edits, frontmatter edits, drag and drop, external file changes, renames with link updates, lossless editing of an Obsidian-style note, reload and reopen, and an empty folder.

## Limits you should know about

- One user per vault. If another app changes a file while you have unsaved edits to it, your version is written and the other version is saved to `.hermes/backups/`, with a notice.
- Rename updates `[[links]]` in every note. Moving a file between folders in an external tool is seen as a delete plus a new file.
- Images and attachments are not browsed or embedded from the vault yet. Image links with `http(s)` URLs render.
- Selection across several bullets is not implemented. Drag, indent, move and delete work on one bullet and its children at a time.
- Change detection polls (every 1.5 s or more, scaled to vault size) because browsers have no file watcher API.
