import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import {
  latexDecorations, latexDecorationsTheme,
  mathDecorations, mathDecorationsTheme,
  envDecorations, envDecorationsTheme,
  figureDecorations, figureDecorationsTheme,
} from './decorations/index';

// VSCode webview API — injected by VS Code at runtime
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ── Editor instance ──────────────────────────────────────────────────────────

let editor: EditorView | null = null;

function createEditor(initialContent: string): void {
  // Debounce outgoing edits so we don't hammer the extension on every keystroke
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
      // History (undo/redo)
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),

      // Line numbers + active line highlight
      lineNumbers(),
      highlightActiveLine(),

      // LaTeX syntax highlighting via the legacy stex StreamLanguage
      latex,
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

      // Soft-wrap lines — important for prose-style documents
      EditorView.lineWrapping,

      // Phase 3: cursor-aware text/structure decorations
      latexDecorations,
      latexDecorationsTheme,
      // Phase 4: KaTeX math rendering
      mathDecorations,
      mathDecorationsTheme,
      // Phase 5: comments + list environments
      envDecorations,
      envDecorationsTheme,
      // Phase 5: figures and tables
      figureDecorations,
      figureDecorationsTheme,

      // Listen for document changes and forward to extension
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          sendEdit(update.state.doc.toString());
        }
      }),

      // Base theme overrides to blend with VSCode
      EditorView.theme({
        '&': {
          height: '100vh',
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
        '.cm-activeLine': {
          background: 'var(--vscode-editor-lineHighlightBackground)',
        },
        '.cm-cursor': {
          borderLeftColor: 'var(--vscode-editorCursor-foreground)',
        },
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
}

// ── Messages from extension ──────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as { type: string; text: string };

  if (msg.type === 'update') {
    if (!editor) {
      // First message: bootstrap the editor
      createEditor(msg.text);
      return;
    }

    // External change: only update if content actually differs
    const current = editor.state.doc.toString();
    if (current === msg.text) return;

    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: msg.text },
    });
  }
});

// Tell the extension we're ready to receive content
vscode.postMessage({ type: 'ready' });
