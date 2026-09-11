# Agent Note: A TypeScript engine for lsp-echo

Status: implemented

English | [中文](2026-09-11-lsp-echo-typescript-engine.zh.md)

## Problem

lsp-echo existed for one language: its registry contained a single engine whose marker was `project.godot` and whose extensions were GDScript and shader files. A TypeScript or JavaScript workspace — including this repository — therefore had no automatic compile diagnostics, even though the plugin's value (a file:line:column error list injected before the next model request) does not depend on the language.

The registry was designed for this: an engine is a directory under `checkers/` with an `engine.json` declaration and a bridge executable, and route/management/UI code reads the registry rather than naming an engine. What was missing was an engine to read.

## Decision

[`checkers/typescript/`](../../../../plugins/lsp-echo/checkers/typescript) implements the same bridge contract as the Godot engine over the `tsserver` stdio protocol.

Its [`engine.json`](../../../../plugins/lsp-echo/checkers/typescript/engine.json) declares the marker `tsconfig.json` and the extensions `.ts`, `.tsx`, `.mjs`, `.cjs`, `.js`, `.jsx`, so a workspace containing a `tsconfig.json` is claimed by this engine and its files route here by extension.

`typescript-lsp.mjs` implements `host|status|stop|check|clientd`, the same command set the plugin's manager calls for every engine, and produces the same payload: files keyed by project-relative path, each with `{errors, warnings, diagnostics}` and diagnostics carrying `severity`, `severityName`, `message`, `source`, `code`, `line`, `column`, `file`. Identical payloads are what let the manager merge two engines' results into one per-project snapshot without engine-specific branches.

The `tsserver` executable resolves in this order: `--ts-server`, then `tsServer` in a machine config `typescript.config.json`, then the project's own `node_modules/typescript/lib/tsserver.js`, then the `TSSERVER_PATH` environment variable. When none of them exists the bridge exits `2` with the resolver's error instead of falling back to a `tsserver` on `PATH`. A project that pins its TypeScript version gets that version's diagnostics; the plugin ships no compiler of its own and adds no dependency.

TypeScript has no embeddable GUI host here, so this engine has no editor-attach mode: it declares no `rescan` capability ([engine bridge note](2026-09-11-lsp-echo-godot-editor-bridge-rescan.md)), and each command owns a `tsserver` session. `clientd` keeps one alive between requests, speaking JSON lines on stdin — `{id, files, sweep}` in, `{id, ok, payload}` out — which is what the manager's persistent-process path expects from any engine. This engine reads `id` and `files` and treats every request as a plain file list; the `sweep` flag has no effect here, because a whole-program TypeScript answer already covers the files a sweep would add.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Run `tsc --noEmit` per check | Reports the whole project rather than the requested files, and pays full-program compilation on every round |
| Host the TypeScript compiler API inside the plugin process | The plugin ships zero dependencies as ESM files; embedding the compiler means shipping and version-pinning the compiler in the plugin |
| Require `typescript-language-server` | Adds a tool the user must install and keep current, for a capability the `typescript` package they already have provides |
| Report only files the editor edited, with no project context | TypeScript diagnostics depend on the program, so a file checked alone reports errors that the project's real configuration removes |
| Mark the engine `rescan: true` and reuse the Godot addon path | The addon is a Godot editor plugin; nothing in a TypeScript workspace can host it, so the capability would be declared without an implementation behind it |

## Consequences

A TypeScript or JavaScript workspace registered in lsp-echo now receives automatic compile diagnostics on the same pre-step path as GDScript, and the registry's engine-count assumptions are exercised by a second entry: extension routing, per-engine enable/disable, the settings-panel engine card, and the multi-engine merge path all run for a real engine rather than a hypothetical one.

Costs accepted: diagnostics depend on the project's installed TypeScript version, so two machines can report different results for the same file; the engine starts a `tsserver` per bridge session, which costs a few hundred milliseconds on first use; and the payload carries tsserver's severity mapping, which the plugin displays without translating codes into its own taxonomy.
