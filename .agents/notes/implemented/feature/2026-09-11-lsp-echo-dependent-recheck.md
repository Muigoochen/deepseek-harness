# Agent Note: lsp-echo rechecks the callers of a changed GDScript

Status: implemented

English | [中文](2026-09-11-lsp-echo-dependent-recheck.zh.md)

## Problem

A Godot engine answers diagnostics for the file it is handed, so the file a signature change breaks is never the file that changed: editing `func foo(x: int)` into `func foo()` leaves `a.gd` clean, and the fallout lands in the callers. The pre-step check covered only the files whose mtime moved since the last step, which makes a signature change indistinguishable from no change at all — the snapshot keeps its old result and no error reaches the model.

## Decision

A pre-step that finds changed GDScript resolves what those files can be referenced by — their `class_name`, and their `res://` path — and adds the watched files that mention either to the same round's check list, `addons/` included because an addon script can reference a project class. The reference test is a word-boundary match on the declared name and a case-insensitive path-literal match on the load string, so `extends StaleA`, `var a: StaleA`, `StaleA.new()` and `preload("res://a.gd")` all count, while a longer identifier like `StaleAB` and a different file like `res://a.gdshader` do not.

A round that deletes or renames a GDScript rechecks the project instead: the gone file cannot be read for the name its callers used, and those callers carry an unknown type until something opens them. The case where a caller reports `Could not find type` after a script appears is what the [engine bridge note](2026-09-11-lsp-echo-godot-editor-bridge-rescan.md) covers from the other side.

The reference index is rebuilt per round rather than cached. On the project this was measured against (about 500 GDScript files) one pass costs 18 ms, which is below the cost of keeping a cache coherent with created, deleted, and renamed scripts.

## Alternatives considered

| Rejected | Why |
| --- | --- |
| Sweep the whole project whenever a script changes | 502 files per round. The engine supports it, but paying a full-project pass for a one-line edit is exactly the cost the incremental path exists to avoid. |
| Check only the changed file's directory | Most references in a modular project cross directories — measured on the real project, the widest-referenced script is referenced by 233 files spread across the tree. |
| Ask the engine for whole-project diagnostics | The engine publishes `publishDiagnostics` only for files the client opened; it has no project-wide diagnostics channel to ask for. |
| Keep a durable reference graph | The graph is 18 ms to rebuild, and a durable copy would need invalidation on create, delete, rename, and path changes — more machinery than the work it saves. |

## Consequences

A changed script that many files reference pulls those files into that round's check. Measured on the real project (about 500 GDScript files): an average of 5.4 referencing files per `class_name` script; the widest-referenced script (`CommonName`) is referenced by 233 files, and a change to it checks those 233 alongside it. A deleted or renamed script costs one project-wide recheck in that round instead.

The match is deliberately an over-approximation: a mention inside a comment counts as a reference. The cost of the over-approximation is one extra clean file in a batch the engine processes in bulk; the cost of the opposite error is a stale snapshot, which is the failure this note exists to prevent.

## Testing

`lib/dependents.js` is covered by a 20-case check run against a throwaway tree (direct reference, `extends`, type annotation, `preload` path, trailing-comment declaration, case-insensitive path, addon-directory reference, comment mention, longer identifier, unrelated file, `.gdshader` path prefix, self-exclusion, shader files, no-target changes, spent-iterator contract, exact-set assertion). The check is a run-once script rather than a packaged test, because the repository test include covers `packages/`, `apps/`, and `scripts/`, not `plugins/`.

The index was measured read-only against the real project: 14–27 ms per pass over about 500 GDScript files, 385 `class_name` scripts scanned in 6.0 s, 11 scripts with no dependents, 5.4 average dependents, 233 maximum.

Engine behaviour was verified separately against a real headless engine: after editing `a.gd` from `foo(x: int)` to `foo()`, checking `b.gd` reports `Too many arguments for "foo()" call` immediately with no engine rescan and no wait — measured with the dependency opened first and with it never opened. A self-started engine reads a changed dependency from disk, so the missing check was the whole cause; the mode where the engine can instead hold its own pre-edit copy is editor attach, which the [engine bridge note](2026-09-11-lsp-echo-godot-editor-bridge-rescan.md) covers.
