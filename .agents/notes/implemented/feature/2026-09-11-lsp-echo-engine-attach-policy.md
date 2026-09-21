# Agent Note: One engine per project — lsp-echo's attach policy

Status: implemented

English | [中文](2026-09-11-lsp-echo-engine-attach-policy.zh.md)

## Problem

lsp-echo resolves which engine serves a project only when it needs one: a check that runs while no editor is reachable starts our own headless Godot engine, and that decision held for as long as the engine lived. A Godot editor opened afterwards never changed it. Two engines then served one project — the user's editor with its own filesystem scan and language server, ours with a second copy of both — for as long as the headless engine stayed alive. Nothing in the loop reported it: checks kept passing, only the machine paid.

Two smaller problems sat next to it. The bridge recorded host state inside its own engine directory, so two copies of the same bridge (the repository checkout and the profile install) read and wrote different state files: `status` answered `stopped: no live host` while an engine was running, depending on which copy asked. And the trust model behind editor attach — "a live peer on the editor port is this project's editor" — is wrong when the editor has a different project open: the check is answered by a language server that knows nothing about the files, and empty diagnostics read as a clean pass.

## Decision

### The engine decision is re-made per request

The persistent bridge client ([`checkers/godot-lsp/godot-lsp.mjs`](../../../../plugins/lsp-echo/checkers/godot-lsp/godot-lsp.mjs) `cmdClientd`) calls `ensureHost` before every request it serves, not only at startup. A changed endpoint is followed by a reconnect: the old socket is dropped without its close handler exiting the process, a new session is opened against the decided endpoint, and the request proceeds. Cold-start behavior is unchanged — an editor that is already running when the first check arrives is still attached directly.

### `attachPolicy` decides what happens when the editor arrives later

The engine's machine config carries `attachPolicy`:

- `prefer-editor` (default) — a check that finds our own headless engine live while the editor's port answers moves the project onto the editor: it stops the headless engine we spawned, records the editor as the engine, and reconnects. One project, one engine.
- `cold-start` — whichever engine started first keeps serving the project. This is the setting for a machine that runs an editor-plugin LSP client of its own (VSCode's Godot plugin), because moving onto the editor opens a new session on a single-session server and evicts that client once.

`attachEditor: false` outranks both: a machine configured headless-only keeps its own engine even when the editor is reachable, so the policy only decides among the choices that setting allows.

The move runs under the existing host-start lock, so two bridge processes cannot both stop the engine and attach, and it never touches the user's editor process.

### A peer serving another project is rejected

After the LSP handshake, the client checks what the peer announced in `gdscript_client/changeWorkspace`, and the persistent client repeats that check before every request it serves, so a notification arriving after the handshake window is caught too. A peer serving a different project is treated as a bad editor: the port is blacklisted with the same five-minute record the unresponsive-editor path uses, and the check falls back to our own engine. The record survives the state rewrites that follow — starting our own engine, or moving onto an editor — so the refused port is not probed again while it is blacklisted. The alternative — using the peer — turns a wrong-project answer into a false clean check.

The session this decision moves and reconnects is the one the [editor LSP session note](../bug-fix/2026-09-11-lsp-echo-editor-lsp-single-session.md) records.

### Host state lives under the DSH home

Host state, host logs, and the engine's own diagnostics copy moved from `<engine>/.runtime/` to `$DSH_HOME/lsp-echo-runtime/godot-lsp/`, which sits under the same runtime root as the snapshot the plugin writes. The old location stays a **read** fallback so an upgrade keeps reusing an engine that is already running, and every write retires the old copy, so a stale record cannot answer for a live one. Both copies of the bridge now observe one state.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Keep the cold-start rule and only document it | Two engines per project stay the steady state whenever the editor opens after the first check, and the loop cannot report it |
| Offer a settings-page button instead of a default | Leaves the resource cost in place until someone notices it; the policy is a one-line config change either way |
| Detect an active client on the editor port and move only when it is free | The editor's LSP is single-session, so every probe that could tell an idle port from a busy one is the same handshake that evicts the busy one |
| Decide in the plugin's host half instead of the bridge | The decision needs the state file, the editor probe, and ownership of the engine process — all of which the bridge already owns |
| Keep reading and writing the old state location and sync the copies | Two writers for one fact; the failure mode (a `status` answer from the wrong file) is exactly what the move removes |
| Treat a wrong-project editor as usable and filter its diagnostics | TypeScript-style per-file filtering does not exist here: the peer answers about a different project and reports nothing about these files |

## Consequences

By default one engine serves a project, whichever of the two started first, so a long-lived session converges after the editor opens instead of holding a second engine. A per-request decision costs one state read plus one TCP reachability check on the editor port, and it reuses the started engine until the editor answers. Moving onto the editor evicts any other client attached to that editor's LSP once; `cold-start` is the documented escape for machines where that client matters. A check that lands on a wrong-project editor now fails over to our own engine instead of passing silently. `status`, `stop`, and the plugin's own tooling agree on one state file regardless of which copy of the bridge runs them.

## Testing

Two experiments ran the bridge from a throwaway copy with its own config and legacy state directory, against temporary projects, with stand-in TCP listeners for the engines:

- The decision cases: a legacy-location headless record plus a reachable editor moved onto the editor, stopped the headless process, wrote the new state, and retired the old file; a second call reused the editor without moving; `attachPolicy=cold-start` reused the headless engine and left it running; an unreachable editor kept the headless engine.
- The session case: a long-lived clientd started on a headless engine answered a request, then the editor appeared and the next request moved the session, stopped the headless engine, reconnected, and answered; no further switch happened on later requests, and dropping the old socket did not exit the process.
- The wrong-project case: an editor announcing a different project was refused with the blacklist message and the check fell back to our own engine.

The engine-authoring Godot processes those experiments started were terminated afterwards and the runtime state they wrote was removed.
