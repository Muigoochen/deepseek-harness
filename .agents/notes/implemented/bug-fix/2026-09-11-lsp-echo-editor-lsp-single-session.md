# Agent Note: One lsp-echo bridge session per Godot editor LSP

Status: implemented

English | [中文](2026-09-11-lsp-echo-editor-lsp-single-session.zh.md)

## Problem

The Godot editor's language server accepts one client session. A second connection logs `Connection Taken` and evicts the first, which then loses every in-flight request.

The `clientd` key included the role along with the project and the attach port, and lsp-echo runs checks under two roles: an ordinary per-round check and the full-project baseline sweep. Against an attached editor those two roles held separate connections to one single-session server, so whichever arrived second evicted the first and the evicted role's request failed. The symptom was not a wrong answer — it was a check that returned no diagnostics for files that had them, timed to the baseline sweep running concurrently with the first edits of a session.

## Decision

[`lib/manager.js`](../../../../plugins/lsp-echo/lib/manager.js) keys `clientd` by project and attach port alone. The `role` argument selects which request the process sends (a normal sweep or a full-project sweep); it is not part of process identity. One attached editor has exactly one bridge session, shared by every check in the plugin, and the Godot engine bridge's rescan request ([engine bridge note](../feature/2026-09-11-lsp-echo-godot-editor-bridge-rescan.md)) travels through that same session.

A port or attach-override change still supersedes every older `clientd` for that project, since the previous process's host decision already ran against the old port.

When a `clientd` call fails at transport level — timeout, exited process, or superseded request — the plugin retires any surviving `clientd` before falling back to the one-shot `check`, which opens its own session. Leaving the process alive there would put two sessions on a single-session server during recovery and fail the very request the fallback exists to save. A payload that arrives with engine-reported diagnostics is a healthy session and is kept.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Keep one `clientd` per role and reconnect after an eviction | The eviction is the steady state of two sessions against one single-session server; reconnecting would make every baseline sweep kick the next round's check |
| Open a fresh session for every check and never persist one | Pays session startup on every round, and the editor-attach case exists to avoid exactly that |
| Serialize roles behind a queue while keeping two sessions | Two sessions cannot coexist at all; serialization only decides which one is evicted |
| Fall back to a headless engine whenever a baseline and a check overlap | Drops the attach economy and scans the project a second time for information the editor already holds |

## Consequences

Baseline and ordinary checks share one editor session, so neither can evict the other and the attach path keeps its startup cost. A transport-level failure replaces the session instead of racing it.

Costs accepted: the plugin cannot run two editor-attached checks concurrently — they serialize through one process — and a future role that genuinely needs its own session must ask for one explicitly rather than inheriting isolation from its name.

## Testing

The failure reproduces with a second client attached to one editor LSP session; the fix was verified by running a baseline sweep and an ordinary check against the same attached editor and confirming a single bridge process serves both, with the second check reporting the engine's diagnostics instead of an empty result.
