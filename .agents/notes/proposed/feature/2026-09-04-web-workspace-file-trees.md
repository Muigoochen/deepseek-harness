# Agent Note: Per-workspace file trees with drag-to-composer references in the Web sidebar

Status: proposed

English | [中文](2026-09-04-web-workspace-file-trees.zh.md)

## Problem

The Web sidebar groups Sessions under Workspaces, but it never shows a Workspace's files. Referencing a file from a conversation requires typing `@` and searching the [`@`-mention discovery surface](../../implemented/feature/2026-08-27-web-at-mention-discovery-and-row-content.md); the discovery surface is query-shaped, so it cannot present a stable structure the way an editor's file explorer does, and a user who does not know a name or a folder layout must guess queries.

Sessions accumulate inside one Workspace over a long project, so the flat list under the Workspace grows without bound. A [Workspace's folding state](../../implemented/feature/2026-08-11-workspace-sidebar-order-and-folding.md) bounds what is visible, but the two long tails — many files and many conversations — share one axis, so neither gets a stable, collapsible home.

The product's closing-message surface already renders [inline file mentions](../../implemented/feature/2026-08-07-web-inline-file-mentions.md), and a dynamic-plugin prototype validated the missing interaction: a per-workspace file tree beside the conversation list, with files dragged into the composer to become `@`-style file references. The prototype also exposed the trap that a production design must own: dropping a tree row into the Lexical composer without explicit handling lets the editor insert the drag's plain-text payload verbatim (an absolute path), so drop handling must live in the product input seam, not in an overlay that races the editor.

## Proposal

Give every Workspace its own file tree inside the sidebar and route file drops through the existing composer reference machine.

### Sidebar information architecture

Each Workspace node in the sidebar browsing region gets two independently collapsible child branches: **Conversations** and **Files**.

```
Workspace A
 ├─ Conversations ▸ (n)   existing session rows
 └─ Files ▸               A's lazy directory tree
Workspace B
 ├─ Conversations ▸ (n)
 └─ Files ▸               B's lazy directory tree
```

Conversations reuse the shipped session-row rendering unchanged — running/completed indicators, pending-interaction dots, the provisional blank row, relative time, and row actions — so the feature adds grouping, never a second session-row implementation. Files is a new read-only directory tree rooted at the Workspace path. Each Workspace's tree state (expanded directories, loaded cache, scroll offset, filtering toggles) is independent and is never shared with another Workspace's tree. Workspace search, ordering, the Ungrouped bucket, archiving, and blank-session reuse keep their current behavior.

### Host listing capability

The existing directory-picker listing returns child directories only, because it exists to choose a directory. The file-reference search is query-shaped. Add a read-only directory listing on the filesystem seam that returns files and directories per level, bounded like the file-reference discovery: same excluded-directory defaults, cancellable via `AbortSignal`, never reading file contents. Relative paths resolve against the session cwd exactly as `fs.resolve` already defines, and the tree roots itself at the Workspace registry path of the owning Workspace.

### Composer drop seam

Tree rows drag with a custom DataTransfer payload that names the workspace root, the relative path, and file-vs-folder kind. The composer accepts drops in the product editor layer, before the editor's default plain-text handling, and converts them into the same `ReferenceInsert` file/folder chips that picking from the `@` menu produces, using the shared `formatFileMention` grammar for quoting. A file outside the receiving session's cwd degrades to an absolute plain path rather than a false `@` mention.

### Persistence

Per-Workspace expansion, filtering, and scroll state persist in browser `localStorage`, keyed by `WorkspaceId`, following the existing [`localStorage` precedent for conversation content width](../../implemented/feature/2026-08-18-conversation-adaptive-content-width.md). No host or account-server storage is added.

### Enablement and adaptation

The feature ships as a Web client feature package registered in the web-app bundle composition, enabled by default and disableable with one composition row. It adapts to another project or repository without code changes: the tree root comes from the Workspace registry path, mention relativity comes from the receiving session's cwd, excluded-directory defaults and toggles are configuration, and path separators are normalized before any comparison.

## Alternatives considered

- **A frame-level drawer overlay** (the validated prototype). Rejected for the product: the drawer duplicates sidebar chrome, floats above product surfaces, and cannot host per-Workspace adjacency with the real session rows.
- **One file tree that re-roots on Workspace switch.** Rejected by the product owner: each Workspace must keep its own independent tree, because the trees of parallel projects evolve separately.
- **Reusing the directory-picker listing for the tree.** Rejected: it returns directories only and is owned by the choose-a-directory flow.
- **Inserting dragged paths as plain text.** Rejected: plain text loses chip identity, quoting consistency, and the canonical mention form that the `@` surface already provides.
- **Persisting tree state on the host or account server.** Rejected: browser-local state matches the interaction, and the shipped tree is a presentation of workspace files, not durable product state.

## Acceptance criteria

- Each Workspace in the shipped Web sidebar shows independent, collapsible Conversations and Files branches, with search, session order, the Ungrouped bucket, archiving, and blank-session reuse unchanged.
- Expanding or scrolling Workspace A's tree never affects Workspace B's tree, and a reload restores each tree's stored state.
- Dragging a current-Workspace file or folder into the composer inserts a file/folder reference chip identical to picking it from the `@` menu, including whitespace quoting; a cross-Workspace drag degrades to an absolute path.
- Directory listing never reads file contents, honors the excluded-directory defaults, and aborts cleanly.
- A keyboard route exists to insert the same reference without dragging.
- Enablement is one documented composition row, and disabling removes the whole feature from the UI.
- Component suites cover branch rendering and per-Workspace state; the Host listing suite covers exclusion, cancellation, and bounds; an assembled keyless scenario exercises browse, drag, and insert; product copy lives in the locale dictionary; i18n and snapshot gates pass.

## Risks

- Restructuring the workspace browsing region can regress ordering, search, or session-row behavior; the mitigation is to reuse the existing tree derivation and row components and to keep their defaults byte-identical.
- Deep or huge directories make lazy loading expensive; per-level bounds, aborted listings, and never expanding on hover keep the cost user-driven.
- Drop handling races the editor's default plain-text insertion, which the prototype observed; the drop handler must live in the product input seam and be covered by a browser-level acceptance scenario.
- Windows drive-letter casing and separators must normalize before path comparison, and mention quoting must come from the shared grammar rather than a second implementation.
