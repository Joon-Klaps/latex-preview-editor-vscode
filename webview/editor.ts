import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
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
        { key: 'Mod-b', run: (v) => wrapSelection(v, '\\textbf{', '}') },
        { key: 'Mod-i', run: (v) => wrapSelection(v, '\\textit{', '}') },
        { key: 'Mod-u', run: (v) => wrapSelection(v, '\\underline{', '}') },
        { key: 'Mod-Shift-m', run: (v) => wrapSelection(v, '\\texttt{', '}') },
        { key: 'Mod-Shift-c', run: (v) => wrapSelection(v, '\\cite{', '}') },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
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
});

// Tell the extension we're ready to receive content
vscode.postMessage({ type: 'ready' });
