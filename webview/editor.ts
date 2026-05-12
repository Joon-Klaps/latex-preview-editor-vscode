import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import {
  autocompletion, acceptCompletion,
  type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';
import { inlineCompletion, acceptInlineCompletion } from '@marimo-team/codemirror-ai';
import {
  latexDecorations, latexDecorationsTheme,
  envDecorations, envDecorationsTheme,
  diffInitial, buildDiffExtension, clearDiffExtension,
} from './decorations/index';

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
let diffEnabled = true;
let aiEnabled = true;
let lastOriginal: string | null = null;
let citationKeys: string[] = [];
let settingsContentWidth = '780px'; // tracks the last value from settings (not toolbar overrides)

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

// ── Ollama inline completion bridge ─────────────────────────────────────────

const pendingCompletions = new Map<string, (prediction: string) => void>();
const fimStatusEl = document.getElementById('fim-status') as HTMLElement | null;

function requestCompletion(prefix: string, suffix: string): Promise<string> {
  if (!aiEnabled) { return Promise.resolve(''); }
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    pendingCompletions.set(id, resolve);
    if (fimStatusEl) { fimStatusEl.style.display = ''; }
    vscode.postMessage({ type: 'complete', id, prefix, suffix, backend: currentBackend });
  });
}

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

function applyDiff() {
  if (!editor) return;
  const effect = (diffEnabled && lastOriginal !== null)
    ? buildDiffExtension(lastOriginal)
    : clearDiffExtension();
  editor.dispatch({ effects: effect });
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
let currentBackend: 'ollama' | 'claude' = 'ollama';

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
(document.getElementById('tb-backend') as HTMLSelectElement).addEventListener('change', (e) => {
  currentBackend = (e.target as HTMLSelectElement).value as 'ollama' | 'claude';
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
    }, 500);
  };

  const isDark = document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast');

  const latex = StreamLanguage.define(stex);

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      history(),
      keymap.of([
        { key: 'Tab', run: (v) => acceptInlineCompletion(v) || acceptCompletion(v) },
        { key: 'Mod-b', run: (v) => wrapSelection(v, '\\textbf{', '}') },
        { key: 'Mod-i', run: (v) => wrapSelection(v, '\\textit{', '}') },
        { key: 'Mod-u', run: (v) => wrapSelection(v, '\\underline{', '}') },
        { key: 'Mod-Shift-m', run: (v) => wrapSelection(v, '\\texttt{', '}') },
        { key: 'Mod-Shift-r', run: (v) => wrapSelection(v, '\\cite{', '}') },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      autocompletion({ override: [citationCompletionSource] }),
      inlineCompletion({
        fetchFn: (state, _signal) => {
          const pos = state.selection.main.head;
          return requestCompletion(state.sliceDoc(0, pos), state.sliceDoc(pos));
        },
        delay: 600,
      }),
      // Diff compartment BEFORE lineNumbers so gutter bar sits left of line numbers
      diffInitial,
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
        '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground, #AEAFAD)', borderLeftWidth: '2px' },
        '.cm-selectionBackground, ::selection': {
          background: 'var(--vscode-editor-selectionBackground)',
        },
        '.cm-scroller': { overflow: 'auto' },
      }, { dark: isDark }),
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
      case 'toggleAI': {
        aiEnabled = !aiEnabled;
        const aiBtn = document.querySelector<HTMLElement>('[data-cmd="toggleAI"]');
        aiBtn?.classList.toggle('tb-btn-active', aiEnabled);
        break;
      }
    }
  });
}

// ── Messages from extension ──────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; text?: string; original?: string | null };

  if (msg.type === 'settingsUpdate') {
    const s = (msg as { type: string; settings: { contentWidth: string; completionBackend: 'ollama' | 'claude' } }).settings;
    if (s.contentWidth !== settingsContentWidth) {
      settingsContentWidth = s.contentWidth;
      currentMaxWidth = s.contentWidth;
      const widthSel = document.getElementById('tb-width') as HTMLSelectElement | null;
      if (widthSel) widthSel.value = s.contentWidth;
      applyEditorStyles();
    }
    if (s.completionBackend) {
      currentBackend = s.completionBackend;
      const backendSel = document.getElementById('tb-backend') as HTMLSelectElement | null;
      if (backendSel) backendSel.value = s.completionBackend;
    }
    return;
  }

  if (msg.type === 'citations') {
    citationKeys = (msg as { type: string; keys: string[] }).keys ?? [];
    return;
  }

  if (msg.type === 'update') {
    if (msg.original !== undefined) lastOriginal = msg.original;

    if (!editor) {
      createEditor(msg.text!);
      applyDiff();
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
    applyDiff();
    return;
  }

  if (msg.type === 'completion') {
    const { id, prediction } = msg as { type: string; id: string; prediction: string };
    console.log('[LaTeX FIM] ← response', id.slice(0, 6), '| prediction:', JSON.stringify((prediction ?? '').slice(0, 60)));
    pendingCompletions.get(id)?.(prediction ?? '');
    pendingCompletions.delete(id);
    if (pendingCompletions.size === 0 && fimStatusEl) { fimStatusEl.style.display = 'none'; }
    return;
  }

  if (msg.type === 'diff' && msg.original !== undefined) {
    lastOriginal = msg.original;
    applyDiff();
  }
});

// Tell the extension we're ready to receive content
vscode.postMessage({ type: 'ready' });
