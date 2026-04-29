import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import {
  autocompletion, acceptCompletion,
  type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';
import {
  latexDecorations, latexDecorationsTheme,
  envDecorations, envDecorationsTheme,
  diffExtensions, setDiffData,
} from './decorations/index';
import type { DiffData } from './decorations/index';

// VSCode webview API — injected by VS Code at runtime
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Module-level state ───────────────────────────────────────────────────────

let editor: EditorView | null = null;
let rawMode = false;
let diffEnabled = false;
let lastDiffData: DiffData = { lines: [], deletions: [], inline: [] };
let citationKeys: string[] = [];
let settingsContentWidth = '780px'; // tracks the last value from settings (not toolbar overrides)

// ── Sync state (scroll + cursor sync with native split view) ──────────────────
let splitViewEnabled = false;
let syncScrollUntil = 0;    // timestamp until which CM scroll events are suppressed
let nativeCursorIgnore = 0; // ignore CM cursor events while > 0 (programmatic move)
let scrollSyncDebounce: ReturnType<typeof setTimeout> | null = null;
let cursorSyncDebounce: ReturnType<typeof setTimeout> | null = null;

// ── Citation autocomplete ────────────────────────────────────────────────────

/** Matches \cite, \citet, \citep, \autocite, \parencite, etc. (with optional * and optional [...]) */
const CITE_CONTEXT_RE = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])?\{[^}]*/;

function citationCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const match = ctx.matchBefore(CITE_CONTEXT_RE);
  if (!match) return null;

  const braceIdx = match.text.indexOf('{');
  const insideBrace = match.text.slice(braceIdx + 1);
  const lastComma = insideBrace.lastIndexOf(',');
  const currentPartial = lastComma === -1
    ? insideBrace
    : insideBrace.slice(lastComma + 1).replace(/^\s+/, '');
  const from = ctx.pos - currentPartial.length;

  const lower = currentPartial.toLowerCase();
  const prefix: string[] = [];
  const contains: string[] = [];
  for (const key of citationKeys) {
    const k = key.toLowerCase();
    if (k.startsWith(lower)) { prefix.push(key); }
    else if (k.includes(lower)) { contains.push(key); }
  }
  const options = [...prefix, ...contains].map(label => ({ label, type: 'keyword' as const }));

  // Only show dropdown if there are matches, or on an explicit trigger
  if (options.length === 0 && !ctx.explicit) return null;

  return { from, options };
}

// ── Formatting helper ────────────────────────────────────────────────────────

function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to) {
    view.dispatch({
      changes: { from, insert: before + after },
      selection: { anchor: from + before.length },
    });
  } else {
    const sel = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: before + sel + after },
      selection: { anchor: from + before.length + sel.length + after.length },
    });
  }
  view.focus();
  return true;
}

// ── Raw-mode toggle ──────────────────────────────────────────────────────────

function enterRawMode() {
  if (!editor) return;
  rawMode = true;
  rawTextarea.value = editor.state.doc.toString();
  document.getElementById('editor')!.style.display = 'none';
  rawView.style.display = 'flex';
  reopenBtn.textContent = '◀ Preview';
  reopenBtn.title = 'Back to LaTeX preview';
  rawTextarea.focus();
}

function exitRawMode() {
  rawMode = false;
  rawView.style.display = 'none';
  document.getElementById('editor')!.style.display = '';
  reopenBtn.textContent = '⊞ Text';
  reopenBtn.title = 'Switch to plain text view';
  if (editor) {
    const current = editor.state.doc.toString();
    const next = rawTextarea.value;
    if (current !== next) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: next } });
    }
    editor.focus();
  }
}

// ── Diff helpers ─────────────────────────────────────────────────────────────

const emptyDiff: DiffData = { lines: [], deletions: [], inline: [] };

function applyDiff() {
  if (!editor) return;
  editor.dispatch({ effects: setDiffData.of(diffEnabled ? lastDiffData : emptyDiff) });
}

// ── DOM refs (available at script-run time — script is deferred after body) ──

const rawView = document.getElementById('raw-view') as HTMLDivElement;
const rawTextarea = document.getElementById('raw-text') as HTMLTextAreaElement;
const reopenBtn = document.querySelector<HTMLElement>('[data-cmd="reopen"]')!;
const diffBtn = document.querySelector<HTMLElement>('[data-cmd="toggleDiff"]')!;

// ── View settings ─────────────────────────────────────────────────────────────

let currentFont = '';   // '' = use VS Code default (CSS variable)
let currentFontSize = 14;
let currentAlign: 'left' | 'justify' = 'left';
let currentMaxWidth = '780px';

function applyEditorStyles() {
  const content = document.querySelector<HTMLElement>('.cm-content');
  if (content) {
    content.style.fontFamily = currentFont;
    content.style.fontSize = currentFont !== '' || currentFontSize !== 14
      ? currentFontSize + 'px' : '';
    content.style.textAlign = currentAlign;
    content.style.maxWidth = currentMaxWidth;
    editor?.requestMeasure();
  }
  rawTextarea.style.fontFamily = currentFont;
  rawTextarea.style.fontSize = currentFontSize + 'px';
  rawTextarea.style.textAlign = currentAlign;
}

(document.getElementById('tb-font') as HTMLSelectElement).addEventListener('change', (e) => {
  currentFont = (e.target as HTMLSelectElement).value;
  applyEditorStyles();
});
(document.getElementById('tb-size') as HTMLSelectElement).addEventListener('change', (e) => {
  currentFontSize = parseInt((e.target as HTMLSelectElement).value, 10);
  applyEditorStyles();
});
(document.getElementById('tb-align') as HTMLSelectElement).addEventListener('change', (e) => {
  currentAlign = (e.target as HTMLSelectElement).value as 'left' | 'justify';
  applyEditorStyles();
});
(document.getElementById('tb-width') as HTMLSelectElement).addEventListener('change', (e) => {
  currentMaxWidth = (e.target as HTMLSelectElement).value;
  applyEditorStyles();
});

// Textarea → extension (only fires when rawMode is active)
let rawDebounce: ReturnType<typeof setTimeout> | null = null;
rawTextarea.addEventListener('input', () => {
  if (!rawMode) return;
  if (rawDebounce) clearTimeout(rawDebounce);
  rawDebounce = setTimeout(() => {
    vscode.postMessage({ type: 'edit', text: rawTextarea.value });
  }, 200);
});

// ── Editor creation ──────────────────────────────────────────────────────────

function createEditor(initialContent: string): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const sendEdit = (text: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      vscode.postMessage({ type: 'edit', text });
    }, 200);
  };

  const latex = StreamLanguage.define(stex);

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      history(),
      keymap.of([
        { key: 'Tab', run: acceptCompletion },
        { key: 'Mod-b', run: (v) => wrapSelection(v, '\\textbf{', '}') },
        { key: 'Mod-i', run: (v) => wrapSelection(v, '\\textit{', '}') },
        { key: 'Mod-u', run: (v) => wrapSelection(v, '\\underline{', '}') },
        { key: 'Mod-Shift-m', run: (v) => wrapSelection(v, '\\texttt{', '}') },
        { key: 'Mod-Shift-r', run: (v) => wrapSelection(v, '\\cite{', '}') },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      autocompletion({ override: [citationCompletionSource] }),
      // Diff gutter BEFORE lineNumbers so colour bar sits left of line numbers
      ...diffExtensions,
      lineNumbers(),
      highlightActiveLine(),
      latex,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      latexDecorations,
      latexDecorationsTheme,
      envDecorations,
      envDecorationsTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          sendEdit(update.state.doc.toString());
        }
        // Sync cursor to native editor on navigation (selection change without doc change)
        if (update.selectionSet && !update.docChanged && splitViewEnabled && nativeCursorIgnore === 0) {
          if (cursorSyncDebounce) { clearTimeout(cursorSyncDebounce); }
          cursorSyncDebounce = setTimeout(() => {
            if (!editor || !splitViewEnabled || nativeCursorIgnore > 0) { return; }
            const line = editor.state.doc.lineAt(editor.state.selection.main.head).number;
            vscode.postMessage({ type: 'cursorSync', line });
          }, 50);
        }
      }),
      EditorView.theme({
        '&': {
          height: '100%',
          background: 'var(--vscode-editor-background)',
          color: 'var(--vscode-editor-foreground)',
        },
        '.cm-content': {
          fontFamily: 'var(--vscode-editor-font-family, "Courier New", monospace)',
          fontSize: 'var(--vscode-editor-font-size, 14px)',
          lineHeight: '1.6',
          padding: '16px 0',
          maxWidth: '780px',
          margin: '0 auto',
        },
        '.cm-gutters': {
          background: 'var(--vscode-editor-background)',
          borderRight: '1px solid var(--vscode-panel-border)',
          color: 'var(--vscode-editorLineNumber-foreground)',
        },
        '.cm-activeLine': { background: 'var(--vscode-editor-lineHighlightBackground)' },
        '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
        '.cm-selectionBackground, ::selection': {
          background: 'var(--vscode-editor-selectionBackground)',
        },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
  });

  editor = new EditorView({
    state,
    parent: document.getElementById('editor')!,
  });

  // Apply current view settings to the freshly-created editor
  applyEditorStyles();

  // Attach scroll listener directly to the scroller element (scroll events don't bubble to root)
  editor.scrollDOM.addEventListener('scroll', () => {
    if (!splitViewEnabled || Date.now() < syncScrollUntil) { return; }
    if (scrollSyncDebounce) { clearTimeout(scrollSyncDebounce); }
    scrollSyncDebounce = setTimeout(() => {
      if (!editor || !splitViewEnabled || Date.now() < syncScrollUntil) { return; }
      const block = editor.lineBlockAtHeight(editor.scrollDOM.scrollTop);
      const line = editor.state.doc.lineAt(block.from).number;
      vscode.postMessage({ type: 'scrollSync', line });
    }, 50);
  });

  // ── Toolbar event delegation ───────────────────────────────────────────────
  document.getElementById('toolbar')!.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-cmd]');
    if (!btn) return;
    switch (btn.dataset.cmd) {
      case 'bold':      if (!rawMode && editor) wrapSelection(editor, '\\textbf{', '}'); break;
      case 'italic':    if (!rawMode && editor) wrapSelection(editor, '\\textit{', '}'); break;
      case 'underline': if (!rawMode && editor) wrapSelection(editor, '\\underline{', '}'); break;
      case 'code':      if (!rawMode && editor) wrapSelection(editor, '\\texttt{', '}'); break;
      case 'cite':      if (!rawMode && editor) wrapSelection(editor, '\\cite{', '}'); break;
      case 'reopen':
        rawMode ? exitRawMode() : enterRawMode();
        break;
      case 'toggleDiff':
        diffEnabled = !diffEnabled;
        diffBtn.classList.toggle('tb-btn-active', diffEnabled);
        applyDiff();
        break;
    }
  });
}

// ── Messages from extension ──────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; text?: string; diff?: DiffData };

  if (msg.type === 'settingsUpdate') {
    const s = (msg as { type: string; settings: { contentWidth: string; splitViewEnabled: boolean } }).settings;
    splitViewEnabled = s.splitViewEnabled ?? false;
    // Only apply contentWidth if the setting value itself changed (preserves toolbar per-session overrides)
    if (s.contentWidth !== settingsContentWidth) {
      settingsContentWidth = s.contentWidth;
      currentMaxWidth = s.contentWidth;
      const widthSel = document.getElementById('tb-width') as HTMLSelectElement | null;
      if (widthSel) widthSel.value = s.contentWidth;
      applyEditorStyles();
    }
    return;
  }

  if (msg.type === 'citations') {
    citationKeys = (msg as { type: string; keys: string[] }).keys ?? [];
    return;
  }

  if (msg.type === 'update') {
    // Cache diff data — only apply to CM6 if the toggle is on
    if (msg.diff) {
      lastDiffData = msg.diff;
      if (diffEnabled && editor) {
        editor.dispatch({ effects: setDiffData.of(lastDiffData) });
      }
    }

    if (!editor) {
      createEditor(msg.text!);
      return;
    }

    if (rawMode) {
      if (rawTextarea.value !== msg.text) rawTextarea.value = msg.text!;
    } else {
      const current = editor.state.doc.toString();
      if (current !== msg.text) {
        editor.dispatch({
          changes: { from: 0, to: editor.state.doc.length, insert: msg.text! },
        });
      }
    }
    return;
  }

  if (msg.type === 'diff' && msg.diff) {
    lastDiffData = msg.diff;
    if (diffEnabled && editor) {
      editor.dispatch({ effects: setDiffData.of(lastDiffData) });
    }
  }

  if (msg.type === 'scrollSync') {
    if (!editor || !splitViewEnabled) { return; }
    const line = Math.max(1, Math.min((msg as { line: number }).line, editor.state.doc.lines));
    const pos = editor.state.doc.line(line).from;
    syncScrollUntil = Date.now() + 150;
    editor.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) });
    return;
  }

  if (msg.type === 'cursorSync') {
    if (!editor || !splitViewEnabled) { return; }
    const line = Math.max(1, Math.min((msg as { line: number }).line, editor.state.doc.lines));
    const pos = editor.state.doc.line(line).from;
    nativeCursorIgnore++;
    syncScrollUntil = Date.now() + 150;
    editor.dispatch({
      selection: { anchor: pos, head: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });
    setTimeout(() => nativeCursorIgnore--, 300);
    return;
  }
});

// Tell the extension we're ready to receive content
vscode.postMessage({ type: 'ready' });
