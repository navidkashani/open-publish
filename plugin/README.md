# Open Publish: the Obsidian plugin

Publishes part of your vault to storage you own. See the
[main README](../README.md) for what the project is, and
[docs/setup-cloudflare.md](../docs/setup-cloudflare.md) to get started.

Requires Obsidian 1.13 or later: the folder and note pickers are built on
`AbstractInputSuggest`, and the settings screen uses `Setting.setErrorMessage`
for inline validation.

## Network access

Obsidian's developer policy requires full disclosure of network endpoints. This
plugin contacts three, all configured by you:

| Endpoint | Purpose |
|---|---|
| Your storage endpoint | Read the published snapshot; upload notes and attachments |
| Your deploy hook URL | Ask your host to rebuild the site |
| Your site URL, path `/_publish.json` | Check whether the new version is live |

No telemetry. No analytics. No server operated by this project.

## Development

```bash
npm install
npm run dev        # esbuild watch
npm run typecheck
npm test           # 490 tests, no network, no Obsidian
npm run build      # produces main.js
```

To load it in a vault, copy `manifest.json`, `main.js` and `styles.css` into
`<vault>/.obsidian/plugins/open-publish/` and enable it in Community Plugins.

`main.js` and `manifest.json` both appear here only after a build. The manifest
is copied from the repository root, which is the one to edit; the copy in this
directory is a build artefact.

## Source layout

```
src/
├─ main.ts                    commands, ribbon, wiring
├─ settings.ts                data.json schema and migrations
├─ core/
│  ├─ selection.ts            include/exclude/frontmatter → publish flag
│  ├─ scanner.ts              vault walk, hashing, diff against the live snapshot
│  ├─ hasher.ts               metadataCache fast path + crypto.subtle fallback
│  ├─ linkindex.ts            link resolution and embed expansion
│  ├─ slug.ts                 path → URL, plus collision detection
│  ├─ snapshot.ts             snapshot format, diffing, rename detection
│  ├─ publisher.ts            the state machine
│  ├─ session.ts              a publish that outlives the window that started it
│  ├─ limits.ts               platform limits
│  ├─ errors.ts               every user-facing error message
│  └─ gc.ts                   orphan cleanup
├─ destinations/              types.ts, sigv4.ts, s3.ts, http.ts, obsidian-http.ts,
│                             content-types.ts
├─ builders/                  types.ts, webhook.ts: deploy hook + verification
└─ ui/
   ├─ PublishModal.ts         the window: scan, review, progress
   ├─ ReviewView.ts           what is about to change, and what each tick means
   ├─ TreeView.ts             the folder tree and its ticks
   ├─ FileTree.ts             tree building and tick arithmetic, no DOM
   ├─ ProgressView.ts         progress, and the result once it is known
   ├─ ScanNotices.ts          blockers, warnings and "Add linked", shared by two screens
   ├─ StatusBar.ts            background progress; absent on mobile
   ├─ messages.ts             every sentence the publish window can say
   ├─ FolderModal.ts          the manage-folders dialog: both lists, live counts
   ├─ FolderRules.ts          rule normalisation and match counting, no DOM
   ├─ RuleList.ts             a list of rules and the control that removes one
   ├─ PathSuggest.ts          the folder and note pickers
   ├─ longpress.ts            press-and-hold, with the timing testable off-device
   ├─ SetupWizard.ts          first-run setup
   └─ SettingsTab.ts          settings
```

### A note on testability

Core modules import Obsidian **types only**, never values. That keeps them
erasable by Node's TypeScript type stripping, so `npm test` exercises the real
implementation under plain Node: no mock of Obsidian, and no separate copy of
the logic that could drift from what ships.

The two places that genuinely need Obsidian at runtime (`obsidian-http.ts` and
the UI) are deliberately thin.
