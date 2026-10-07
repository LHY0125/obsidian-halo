# Halo-MCP

Publish your Obsidian notes to [Halo](https://github.com/halo-dev/halo), with the
[Halo MCP Server](https://github.com/halo-dev/plugin-mcp-server) as the backend.
> **This is a fork of [`halo-sigs/obsidian-halo`](https://github.com/halo-sigs/obsidian-halo).**
> The publishing backend has been migrated from Halo's REST API to the official MCP Server plugin,
> and the plugin `id` changed from `halo` to `halo-mcp` so that it can coexist with the original.
> It is a **separate plugin**, not an update to the upstream one.

## Features

- **Posts** — publish / update / pull, with a preview dialog before anything is written.
- **Single pages** — push a note as a Halo *page* (not a post), pull, and manage them.
- **Search** — full-text search your site to check whether you have already written something.
  **Drafts are included.**
- **Attachments** — list, copy links, and delete.
- **Recycle bin** — list and restore recycled posts and pages.
- **Batch operations** — push as drafts / publish / unpublish across the whole vault,
  after one aggregate confirmation.
- **Site routing** — route notes to different Halo sites by glob patterns on their path.
- **Metadata fields** — six Halo post fields (`visible`, `pinned`, `priority`, `publishTime`,
  `allowComment`, `template`) readable and writable from a note's frontmatter.

## Requirements

- Halo **≥ 2.26**, with the official
  [MCP Server plugin](https://github.com/halo-dev/plugin-mcp-server) installed and enabled.
- An access key created in the Halo console under **Tools → MCP Service**. It starts with `hmcp_`.
  Grant it the following **four groups, 23 tools in total**:

  | Group | Count | Tools |
  |---|---|---|
  | Posts | 7 | list / get / create / update, publish state, recycle, restore |
  | Single pages | 7 | the same set, for pages |
  | Categories & tags | 4 | list and create, for each |
  | Search & attachments | 5 | full-text search, attachment list / get / delete, attachment upload |

  This list matches `REQUIRED_TOOLS` in `src/mcp-self-check.ts` — **that file is the authority**.
  If you grant fewer, the self-check will report the missing tools by name.
  Comments, theme settings, theme templates and image search are not used by this plugin.

## Connection self-check

Run **`Halo-MCP: MCP connection self-check`** from the command palette. It performs the handshake
and reports whether every required tool is available. When troubleshooting, this is the only
verification method you have — run it first.

## Contract test (optional, needs a real site)

```bash
HALO_MCP_ENDPOINT=https://<your-site>/mcp HALO_MCP_TOKEN="$HALO_MCP_TOKEN" pnpm test:contract
```

It asserts against a real site that every tool in `REQUIRED_TOOLS`
(see `src/mcp-self-check.ts`) exists. There are two cases depending on the environment variables:

- **Neither is set** — this is the expected skip; it stays silent (reports 1 passed, but asserts
  nothing).
- **Only one is set** — almost certainly a misconfiguration. The test writes a warning to stderr
  **naming the missing variable**. If you see that warning, no assertion was made; set both.

## Installation

1. In Obsidian, open **Settings → Community plugins → Browse**.
2. Search for **Halo-MCP** and click **Install**.
3. Enable it, then go to **Settings → Halo-MCP** and add a site:
   - **Site name** — optional.
   - **Site URL** — e.g. `https://blog.example.com`.
   - **MCP token** — the `hmcp_` access key from the step above. **This is required.**
   - **Personal access token** — optional. Only used to upload images **larger than 7 MiB**;
     leave it empty if you do not need that.
4. Run the command **`Halo-MCP: MCP connection self-check`** to verify.

### Upgrading from the upstream plugin

If you previously used `halo-sigs/obsidian-halo`, its settings do **not** carry over — this is a
separate plugin with its own configuration. Add your site again and fill in the `hmcp_` token.

The upstream plugin only stored a PAT. After switching to MCP, **even small image uploads go
through MCP**, so a missing `hmcp_` token makes publishing fail — and because any failed image
upload aborts the whole publish, all you see is "publish failed". Run the self-check command;
it will tell you plainly if the token is invalid.

## Commands

All commands are prefixed with the plugin name by Obsidian; the names below are what you see.

| Command | What it does | Touches local notes |
|---|---|---|
| **Publish to Halo** | Publish the current note to the resolved site | Writes back frontmatter |
| **Publish to Halo (use default settings)** | Publish to the default site, **bypassing routing rules** | Writes back frontmatter |
| **Upload images to Halo** | Upload local images and replace the links | Rewrites image links |
| **Pull posts from Halo** | Pull a post from Halo into a new note | Creates a note |
| **Update content from Halo** | Update the current note from Halo | Rewrites the note |
| **Push as page** | Push the current note as a single page | Writes back frontmatter |
| **Pull page** | Pull a single page into a new note | Creates a note |
| **Manage pages** | List the site's pages and move them to the recycle bin | — |
| **Search site content** | Search the site (**including drafts**) | — |
| **Manage attachments** | List / copy links / **delete** attachments | — |
| **Recycle bin (posts)** / **(pages)** | List recycled content and restore it | — |
| **MCP connection self-check** | Handshake and report missing tools | — |
| **Batch push as drafts** / **Batch publish** / **Batch unpublish** | Act on the whole vault after one confirmation | See below |

## Preview

![settings](./images/settings-en.png)

![commands](./images/commands-en.png)

## Metadata fields

These six fields live under `halo:` in a note's frontmatter and work **in both directions** —
they are sent to the site on publish, and the site's actual values are written back afterwards.

```yaml
halo:
  site: https://blog.example.com
  name: <post metadata.name>
  publish: true
  visible: PUBLIC                  # PUBLIC | INTERNAL | PRIVATE
  pinned: false                    # pin to top
  priority: 0                      # sort weight, integer
  publishTime: ""                  # empty string = publish now; otherwise a scheduled time (RFC 3339)
  allowComment: true               # per-post comment toggle
  template: ""                     # custom rendering template
```

**Deleting a line is not the same as clearing it.** For a note that has **already been published**,
removing the `halo.pinned:` line means "follow whatever the site currently has"; to unpin it you
must write `pinned: false`. Writing an empty value (`pinned:` with nothing after it) is the same
as deleting the line. This holds for `visible` / `pinned` / `priority` / `allowComment` / `template`.

For a note that has **never been published** there is no remote value to follow — the plugin's
built-in defaults apply. Those defaults are deliberately not repeated here; see the code, so that
there is only one source of truth.

**"Empty" means no value, not a pair of quotes.** `visible:` (nothing after the colon) parses as
"no value" in YAML, so it means "follow the site"; `visible: ""` (a pair of quotes) is an explicit
string and will be rejected as an invalid value.

**`publishTime` is the one exception**: `""` (empty string) is a **meaningful** instruction meaning
"publish immediately". To cancel a scheduled publish you must write `publishTime: ""` explicitly —
merely deleting the line leaves it following the site.

Invalid values are caught **before** publishing, locally, without a single network request —
e.g. `visible: public` (lowercase) tells you which line, what you wrote, and what is allowed.

## Site routing rules

Under **Settings → Halo-MCP → Site routing rules**, route notes to sites by their **path within
the vault**:

| Pattern | Meaning |
|---|---|
| `blog/**` | every note under `blog/` (`**` crosses directories) |
| `diary/*.md` | markdown one level below `diary/` (`*` does not cross `/`) |
| `draft?.md` | `?` matches a single non-`/` character |

Patterns are **case-insensitive**, and a leading `./`, `/` or backslash is normalized away.
Rules are evaluated top-down, first match wins; the settings page shows how many notes each
rule currently matches.

**If a rule points at a site you have deleted, the plugin stops and reports an error rather than
falling back to the default site.** That is deliberate: publishing to the wrong site is
irreversible (a post of the same name may already exist there), whereas an error just asks you
to fix one line of configuration.

Site resolution order:

```
halo.site in the note  >  first matching routing rule  >  default site in settings  >  the only site  >  ask you
```

Note that **Publish to Halo (use default settings)** deliberately **bypasses** the routing rules.

## Batch operations

All three batch commands take their candidates from **every markdown note in the vault**, group
them by site, and list them in a confirmation dialog:

- **Batch push as drafts** — create/update each post and set its publish state to draft.
- **Batch publish** — create/update each post and set its publish state to published.
- **Batch unpublish** — set already-published posts back to draft. Does not read the body,
  does not rewrite the body, does not upload images.

Every row has a checkbox (all checked by default), and the "will process N notes" count
**updates live as you toggle them**. Notes that cannot enter the batch — no site, no `halo.name`
(for unpublish), body unreadable (**only for push-as-draft / publish; unpublish does not read
the body**) — are listed separately under "skipped", each with its own reason. They are not
counted as failures.

**Batch push-as-draft and batch publish also rewrite your local notes** (not just the remote
site): they write the post metadata (`title` / `slug` / `cover` / `excerpt` / `categories` /
`tags`) and the whole `halo` block back into the note, including the publish state
`halo.publish`. This happens **regardless of the "replace image links" setting**; with that
setting on, local image paths are also replaced with Halo URLs.

**Batch unpublish only touches the remote site and does not write back to local notes.** It
returns those posts to draft on the site, while `halo.publish` in your notes **keeps its original
value**. This matters because **Batch publish** means "publish this batch" — it passes
"publish" explicitly for every note and **does not look at the local `halo.publish`**. So
**running batch publish again after unpublishing will republish all of them.** To keep them as
drafts, either leave them out of batch publish, or run batch push-as-draft first.

**Batch commands decide the publish state from the command name, not from `halo.publish` in the
note.** `Batch publish` sets every note in the list to published and `Batch push as drafts` sets
every one to draft — even if a note itself says `halo.publish: false`. **The only way to exclude
a note is to uncheck it in the confirmation dialog.** (The single-note **Publish to Halo** command
is unaffected; it still reads `halo.publish`.)

Batch execution **does not stop on failure**: if one note fails, the rest keep going, and a
summary dialog at the end reports "N succeeded, N failed, N skipped before running", listing
the details in **two separate sections** — failures first, then the notes skipped before
execution, each with its reason.

## Pages, search, attachments and the recycle bin

Besides publishing posts, the plugin manages **other content on your site**. First, which of
these touch your local notes (`Manage attachments` / `Search site content` / the two recycle-bin
commands **do not touch local notes at all** — they only read and act on the remote site):

| Command | What it does | Touches local notes |
|---|---|---|
| **Push as page** | Push the current note as a single page | **Yes** — writes back frontmatter |
| **Pull page** | Pull a single page into a new note | **Yes** — creates a note |
| **Manage pages** | List pages not in the recycle bin; move them there one by one | No |
| **Search site content** | Search the site by keyword to see if you already wrote it | No |
| **Manage attachments** | List all attachments; copy links or **delete** | No |
| **Recycle bin (posts)** / **(pages)** | List recycled content and **restore** it | No |

A few behaviours worth knowing:

- **Search includes drafts.** It deliberately does not filter by publish state — the point of
  searching is "have I already written this?", and an unpublished draft is exactly the thing
  you most need to find (otherwise you write it twice). Draft rows carry a **pencil icon**
  (hover shows "draft"); rows with a permalink also get an **Open** button that opens that
  post on your site in the system browser.
- **Deleting an attachment is irreversible.** Attachments have **no recycle bin** — once deleted
  it cannot be recovered, and notes referencing it will show a broken image. So every delete
  requires **a second confirmation** naming the file and its size.
  (Moving posts and pages to the recycle bin *is* recoverable — do not carry this rule over.)
- **A single page's frontmatter has only three `halo` keys**: `site` / `name` / `publish`. The six
  metadata fields (`visible` / `pinned` / `priority` / `publishTime` / `allowComment` /
  `template`) as well as `cover` / `excerpt` / `categories` / `tags` **have no meaning for pages** —
  the page resource simply has no such concepts, and writing them has no effect. After pushing a
  page, the note gets exactly those three keys and is **not** stuffed with extra fields.
- **Pushing a page has no preview dialog and uploads no images.** Pages are usually short
  documents like "About" or "Links"; if you do need images on one, run **Upload images to Halo**
  first.
- **Posts and pages have separate recycle-bin commands.** No column in a list could tell you
  whether a row is a post or a page, so rather than mixing them and making you guess, they are
  split by content type — "I deleted a post by mistake" and "I deleted a page by mistake" are
  two different actions anyway.

## Manual end-to-end checklist

Some of the behaviours above can only be verified with a real Obsidian and a real site
(dialogs, checkboxes, image link write-back). See
**[docs/e2e-manual-checklist.md](./docs/e2e-manual-checklist.md)** for the item-by-item list.
(It is written in Chinese.)

## Development

1. [Create a new Obsidian vault](https://help.obsidian.md/Getting+started/Create+a+vault) for development.
2. Clone this repo into the vault's **plugins folder**:

   ```bash
   cd path/to/vault/.obsidian/plugins

   git clone https://github.com/LHY0125/obsidian-halo
   ```

3. Install dependencies and build:

   ```bash
   cd obsidian-halo

   pnpm install
   pnpm dev     # watch mode; rebuilds main.js on change
   ```

4. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

The plugin `id` must match the directory name.

## Credits

- [halo-sigs/obsidian-halo](https://github.com/halo-sigs/obsidian-halo) — the upstream plugin this
  is forked from.
- [obsidian-wordpress](https://github.com/devbean/obsidian-wordpress) — the original idea came
  from this repo.

## License

GPL-3.0 (inherited from the upstream plugin)
