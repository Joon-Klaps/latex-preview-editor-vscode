# LaTeX Preview Editor — Claude Code Instructions

## Project Overview

A VS Code extension that turns `.tex` files into an Overleaf-style hybrid WYSIWYG editor.
The user sees rendered output (bold, math, sections, lists) inline while the raw LaTeX source
is always editable — decorations collapse back to source when the cursor enters them.

## Architecture

```
Extension host (Node)          Webview (Browser)
─────────────────────          ──────────────────
src/extension.ts               webview/editor.ts
src/LaTeXEditorProvider.ts     webview/decorations/
  │  message: {type:'update'}       text.ts
  │  message: {type:'edit'}         environments.ts
  └──────────────────────────       diff.ts          ← @codemirror/merge
                                    index.ts
```

- **Extension ↔ Webview** communicates exclusively via `webviewPanel.webview.postMessage` / `window.addEventListener('message', …)`.
- `suppressNextUpdate` flag in `LaTeXEditorProvider` prevents echo-loops when the webview applies an edit.
- Debounce (200 ms) on the webview side before sending `edit` messages.
- Bundled with **esbuild** (`build.mjs`) into `dist/extension.js` (CJS/Node) and `dist/webview.js` (IIFE/Browser).

## Tech Stack

| Layer | Library |
|---|---|
| Editor | CodeMirror 6 (`@codemirror/view`, `state`, `language`, `commands`) |
| Diff | `@codemirror/merge` — `unifiedMergeView` with git HEAD as original |
| LaTeX syntax | `@codemirror/legacy-modes` `stex` StreamLanguage |
| Math rendering | KaTeX 0.16 |
| Bundler | esbuild 0.20 |
| Language | TypeScript 5 |
| VS Code API | `^1.74.0` |

## Diff System

The diff is always on by default. The extension host runs `git show HEAD:./file.tex` to get the committed baseline and sends it as `original: string | null` in the `update` and `diff` messages. The webview passes it to `unifiedMergeView({ original })` from `@codemirror/merge`, wrapped in a `Compartment` for toggling. Diff is refreshed on every file save.

Message protocol:
- `{ type: 'update', text, original }` — full content + HEAD baseline on open/external change
- `{ type: 'diff', original }` — updated HEAD baseline after save

## Decoration System

All decoration layers are **CodeMirror `ViewPlugin`s** that rebuild on `docChanged | selectionSet | viewportChanged`.

### `text.ts` — inline command decorations
- Regex `COMMAND_RE` scans the **visible range only** for commands like `\textbf`, `\section`, `\cite`, etc.
- Uses `findClosingBrace()` (depth-counting) to locate the matching `}`.
- Hides the `\cmd{` prefix and `}` suffix (`Decoration.replace({})`), marks the content with a CSS class.
- **Cursor-aware**: skips the whole command range if any cursor selection overlaps it.

### `environments.ts` — list environments and comments
- `scanLists()` uses `BEGIN_RE` to find `\begin{itemize|enumerate}` … `\end{…}` pairs.
- `\item` tokens replaced with bullet (`•`) or counter widgets; `\begin`/`\end` tags hidden.
- **Entire environment** expands to raw source when cursor is anywhere inside it.
- Comments (`%…<EOL>`) are marked with `cm-latex-comment` in the visible range only.
- All collected decorations must be sorted by `(from, to)` before `RangeSetBuilder` — required.

## Build Steps

```bash
npm install          # install all dependencies
npm run build        # one-shot build → dist/
npm run watch        # incremental watch build

# Press F5 in VS Code to launch Extension Development Host
```

Build output:
- `dist/extension.js` — extension entry point
- `dist/webview.js` — webview bundle

## Code Conventions

- All source in TypeScript; no `any` unless unavoidable.
- Keep extension (Node) and webview (Browser) code strictly separated — no shared runtime modules.
- Regex constants are defined at module scope and have `.lastIndex = 0` reset before each use if they have the `g` flag.
- No `console.log` in production paths; use `vscode.window.showInformationMessage` for user-facing messages from the extension side.
- When adding new LaTeX commands to `text.ts`, add both the regex alternative in `COMMAND_RE` and the CSS class mapping in `CMD_CLASS`.
- Do not add comments unless the WHY is non-obvious.
