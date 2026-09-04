# Open Publish: the Obsidian plugin

Publishes part of your vault to storage you own. See the
[main README](../README.md) for what the project is, and
[docs/setup-cloudflare.md](../docs/setup-cloudflare.md) to get started.

Requires Obsidian 1.13 or later. The settings screen is declared through
`getSettingDefinitions`, the folder and note pickers use `AbstractInputSuggest`,
and several rows use `Setting.setErrorMessage`.

## Network access

Obsidian's developer policy requires plugins to list every network endpoint. This
plugin contacts three, and you configure all of them yourself:

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
npm test           # no network, no Obsidian, no browser
npm run build      # produces main.js
```

To load it in a vault, copy `manifest.json`, `main.js` and `styles.css` into
`<vault>/.obsidian/plugins/open-publish/` and enable it in Community Plugins.

`main.js` and `manifest.json` appear here only after a build. Edit the manifest
at the repository root; the copy here is a build artefact.

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
│  ├─ navorder.ts             sidebar order and hidden pages, settings → slugs
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
   ├─ NavigationModal.ts      the customise-navigation dialog: order and hiding
   ├─ FolderRules.ts          rule normalisation and match counting, no DOM
   ├─ RuleList.ts             a list of rules and the control that removes one
   ├─ PathSuggest.ts          the folder and note pickers
   ├─ PickerList.ts           the provider and host row lists, shared by wizard and settings
   ├─ Disclosure.ts           the "Advanced" section, and the rule that it is never opaque
   ├─ StorageFields.ts        the storage form, shared by settings and the wizard
   ├─ BuildFields.ts          the build form, shared by settings and the wizard
   ├─ longpress.ts            press-and-hold, with the timing testable off-device
   ├─ SetupWizard.ts          first-run setup
   ├─ settingDefinitions.ts   the settings tree as data, Obsidian types only
   ├─ FieldsPage.ts           a settings sub-page whose body is drawn by hand
   └─ SettingsTab.ts          settings: the shell that wires the tree to the app
```

### A note on testability

Core modules import Obsidian **types only**, never values. Node strips those
types away, so `npm test` runs the real implementation under plain Node. There
is no mock of Obsidian and no second copy of the logic to drift from what ships.

Two places genuinely need Obsidian at runtime: `obsidian-http.ts` and the UI.
Both are deliberately thin.

`ui/settingDefinitions.ts` is held to the same rule, which is why the settings
tab is split in two. `test/settingdefinitions.test.mjs` skips `test/harness.mjs`,
so nothing rewrites `obsidian` to a stub in that process. The rule then enforces
itself: a value import anywhere in that module's reach fails the file outright.
