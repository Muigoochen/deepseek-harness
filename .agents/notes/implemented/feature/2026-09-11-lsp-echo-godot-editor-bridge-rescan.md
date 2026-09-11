# Agent Note: lsp-echo engine bridge — asking a running Godot engine to rescan

Status: implemented

English | [中文](2026-09-11-lsp-echo-godot-editor-bridge-rescan.zh.md)

## Problem

Godot registers a script's `class_name` as a global class only while it scans the project filesystem: `EditorFileSystem::_update_script_classes()` reaches `ScriptServer::add_global_class()` from inside a scan. A running engine does not rescan on its own. The editor triggers `EditorFileSystem::scan_changes()` when its window regains focus (`NOTIFICATION_APPLICATION_FOCUS_IN`), and no timer, file watcher, or external entry point calls it — so a `--headless` engine never rescans at all.

The language server exposes no way to ask for one. `gdscript_language_protocol.cpp` registers `textDocument/*` requests plus `initialize`/`initialized`, and the first full scan runs once behind an engine-level `_initialized` guard.

The consequence lands on the agent loop in its most expensive form: a script that declares `class_name X` is written, a second file referencing `X` is checked before the engine has scanned, and the check reports `Could not find type "X" in the current scope.` The diagnostic is false, it arrives immediately after the edit that caused it, and it persists until the engine restarts — the loop is told to fix a file that is already correct.

## Decision

lsp-echo ships a Godot editor plugin beside the engine bridge and asks the running engine to rescan through it.

### The addon and its on-disk record

[`checkers/godot-lsp/addon/dsh_echo_bridge`](../../../../plugins/lsp-echo/checkers/godot-lsp/addon/dsh_echo_bridge) holds the addon (`plugin.cfg` + `plugin.gd`). The plugin's `installAddonInto` copies it into `<project>/addons/dsh_echo_bridge/` and `ensureEditorPluginEnabled` appends `"res://addons/dsh_echo_bridge/plugin.cfg"` to the `[editor_plugins] enabled` `PackedStringArray` in `project.godot`. The `project.godot` rewrite goes through a temp file plus rename, since a half-written copy loses the user's editor settings; the addon copy is a recursive sync copy. Both steps are idempotent. The list rewrite is quote-aware, so a sibling entry whose path contains a closing parenthesis survives, and a commented-out `;enabled=…` line does not count as the addon being enabled.

The plugin writes into the user's project in exactly two places, both listed above; the README documents the matching uninstall steps.

### Control socket and port discovery

The addon binds `127.0.0.1` on the first free port among sixteen starting at `DSH_ECHO_BRIDGE_PORT` (default 6089), and publishes `{"port": N, "pid": P}` to `<project>/.godot/dsh_echo_bridge.json`. One request per line; `rescan` answers `ok`, anything else answers `err unknown command`. `rescan` calls `EditorInterface.get_resource_filesystem().scan_sources()` — the method `EditorFileSystem::scan_changes()` is bound to, so the addon rides the same scan path the focus notification uses.

The plugin reads a port from the published record and falls back to the engine's declared `rescanPort`; the bridge CLI reads an explicit port first (`--bridge-port`, the machine config's `bridgePort`, or `DSH_ECHO_BRIDGE_PORT`), then the published record, then the shipped default. A published port counts only while its publisher pid is alive ([`lib/addon.js`](../../../../plugins/lsp-echo/lib/addon.js) `discoverBridgePort`, and the bridge's own lookup), so a state file left by a crashed engine cannot redirect a check to a port that now belongs to something else. Both sides match whole lines (`ok`, `pong`), so an unrelated local service cannot acknowledge a request by containing the word.

### Self-heal triggers

The plugin asks for a rescan in two places, both automatic:

- A structural change — a `.gd` created or deleted, tracked in [`lib/watcher.js`](../../../../plugins/lsp-echo/lib/watcher.js) — is drained before the check runs, so the new file exists in the engine's view before anything references it.
- A payload containing `Could not find type "X"` is treated as suspect only when the project really declares `class_name X` (`missingTypeNames` over this round's files, against an mtime-incremental class index in [`lib/index.js`](../../../../plugins/lsp-echo/lib/index.js)). The plugin then rescans and runs one more check, whose budget is capped and which keeps the first payload if it throws. A missing type that the project does not declare is a real error and triggers nothing.

The request travels through the same bridge process the checks use, whose session ownership the [editor LSP session note](../bug-fix/2026-09-11-lsp-echo-editor-lsp-single-session.md) records.

### Failure is visible

After a failed attempt, that engine/project pair is not asked again for 120 s, and the toast that states the engine has not published its new classes repeats at most every 600 s; a successful rescan suppresses the next request for 3 s. A failed rescan never turns into a clean result: the check payload is the engine's own answer either way. `bridgeStatus` reports `{installed, port, declared, online, error}` and `installAddon` reports `{ok, addonPath, enabled, enableChanged, stoppedForRestart, error}`; the settings panel surfaces both verdicts.

The plugin's HTTP actions that write state or stop engines require the `x-dsh-lsp-echo: 1` header, which a cross-site page cannot attach to a plain GET: another web page cannot make the harness install files into a user's project or stop an engine.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Inject a DLL into the running engine and call the class registration directly | Depends on a private ABI that any engine upgrade breaks, needs debug privileges, and reaches nothing the supported editor-plugin API does not already expose |
| Start a second `--headless` engine per check | Pays a full project scan per edit and still cannot see classes the user's editor has not scanned |
| Send a rescan request over the language-server protocol | The protocol registers only `textDocument/*` plus `initialize`/`initialized`; no rescan request exists |
| Restart the headless engine when new files appear | Costs a full scan and drops the editor-attach session; a rescan request is one line to an already-running engine |
| Poll the engine for class-name freshness instead of rescanning | Nothing observable changes until a scan runs; the check payload is the engine's only output |
| Ship the addon as a separate user-installed download | The plugin's contract is self-contained installation; a manual prerequisite would leave the false diagnostic in place for every project that skipped it |

## Consequences

New `class_name` scripts become visible to a running engine within one request, so the false `Could not find type` disappears in both editor-attach and headless modes. The plugin gains engine-capability fields in its registry (`rescan`, `rescanPort`, `addon` in `engine.json`), and the bridge gains a `rescan` subcommand; an engine that declares no `rescan` capability keeps the previous behavior, which the [TypeScript engine](2026-09-11-lsp-echo-typescript-engine.md) does.

Costs accepted: the plugin writes an addon directory and one `project.godot` entry into the user's project; the addon requires `EditorFileSystem.scan_sources()` to be script-visible (measured on Godot 4.7 — an engine that does not expose it fails the rescan, which is handled as a failure rather than a pass); the control socket is unauthenticated on loopback and any local process can trigger a rescan; a headless engine loads editor plugins only at startup, so installing the addon while our own headless engine runs stops that engine and lets the next check start one that reads the new setting. A user's editor is never stopped — its addon loads when the editor next starts.

## Testing

The addon installer was exercised against five `project.godot` shapes (section at EOF without a trailing newline, an existing list followed by another section, no section, an enabled path containing `)`, and a commented-out entry), each idempotent with exactly one `[editor_plugins]` section afterwards. Port discovery was exercised with no state file, a dead publisher pid, and a live one. End to end, with the default port occupied, the addon bound the next port, published it, and answered both a probe and the bridge's `rescan`, after which a file referencing a class created while the engine ran went from one error to none; against a dead port the bridge exits `2` and reports the failure.

The installer and port checks ran from a throwaway script against temporary projects, so the results are recorded here and in the plugin's design notes rather than shipped as a test file; the engine steps reproduce with the bridge CLI commands the plugin README documents.
