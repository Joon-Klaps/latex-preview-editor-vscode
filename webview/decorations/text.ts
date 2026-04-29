import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMMAND_RE =
  /\\(textbf|textit|emph|underline|texttt|section\*?|subsection\*?|subsubsection\*?|title|label|ref|eqref|cref|Cref|autoref|pageref|cite|citep|citet|url|footnote)\{/g;

const CMD_CLASS: Record<string, string> = {
  // Formatting
  textbf: 'cm-latex-bold',
  textit: 'cm-latex-italic',
  emph: 'cm-latex-italic',
  underline: 'cm-latex-underline',
  texttt: 'cm-latex-monospace',
  // Structure
  title: 'cm-latex-title',
  'section': 'cm-latex-section',
  'section*': 'cm-latex-section',
  'subsection': 'cm-latex-subsection',
  'subsection*': 'cm-latex-subsection',
  'subsubsection': 'cm-latex-subsubsection',
  'subsubsection*': 'cm-latex-subsubsection',
  // Cross-references
  label: 'cm-latex-label',
  ref: 'cm-latex-ref',
  eqref: 'cm-latex-ref',
  cref: 'cm-latex-ref',
  Cref: 'cm-latex-ref',
  autoref: 'cm-latex-ref',
  pageref: 'cm-latex-ref',
  // Citations
  cite: 'cm-latex-cite',
  citep: 'cm-latex-cite',
  citet: 'cm-latex-cite',
  // Other inline
  url: 'cm-latex-url',
  footnote: 'cm-latex-footnote',
};

const HIDE = Decoration.replace({});

// ── Helpers ───────────────────────────────────────────────────────────────────

function findClosingBrace(docText: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < docText.length; i++) {
    if (docText[i] === '{') depth++;
    else if (docText[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function anyCursorIn(view: EditorView, from: number, to: number): boolean {
  for (const range of view.state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

interface DecoRange {
  from: number;
  to: number;
  dec: Decoration;
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildDecorations(view: EditorView): DecorationSet {
  const collected: DecoRange[] = [];
  const docText = view.state.doc.toString();

  for (const { from: vpFrom, to: vpTo } of view.visibleRanges) {
    const slice = docText.slice(vpFrom, vpTo);
    COMMAND_RE.lastIndex = 0;

    let m: RegExpExecArray | null;
    while ((m = COMMAND_RE.exec(slice)) !== null) {
      const cmdFrom = vpFrom + m.index;
      const braceAbs = vpFrom + m.index + m[0].length - 1;
      const closingAbs = findClosingBrace(docText, braceAbs);
      if (closingAbs === -1) continue;

      const prefixTo = braceAbs + 1;
      const contentTo = closingAbs;
      const cmdTo = closingAbs + 1;

      if (anyCursorIn(view, cmdFrom, cmdTo)) continue;

      const cls = CMD_CLASS[m[1]];
      if (!cls) continue;

      if (prefixTo < contentTo) {
        collected.push({ from: cmdFrom, to: prefixTo, dec: HIDE });
        collected.push({ from: prefixTo, to: contentTo, dec: Decoration.mark({ class: cls }) });
        collected.push({ from: contentTo, to: cmdTo, dec: HIDE });
      }
    }
  }

  collected.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, dec } of collected) {
    builder.add(from, to, dec);
  }
  return builder.finish();
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const latexDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildDecorations(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Theme ─────────────────────────────────────────────────────────────────────

export const latexDecorationsTheme = EditorView.baseTheme({
  // Formatting
  '.cm-latex-bold': { fontWeight: 'bold' },
  '.cm-latex-italic': { fontStyle: 'italic' },
  '.cm-latex-underline': { textDecoration: 'underline' },
  '.cm-latex-monospace': { fontFamily: 'monospace', fontSize: '0.9em' },

  // Structure
  '.cm-latex-title': { fontSize: '2em', fontWeight: 'bold', letterSpacing: '-0.01em' },
  '.cm-latex-section': { fontSize: '1.5em', fontWeight: 'bold' },
  '.cm-latex-subsection': { fontSize: '1.25em', fontWeight: 'bold' },
  '.cm-latex-subsubsection': { fontSize: '1.1em', fontWeight: 'bold' },

  // Cross-references — styled as clickable-looking chips
  '.cm-latex-label': {
    color: 'var(--vscode-editorLineNumber-foreground, #858585)',
    background: 'rgba(128,128,128,0.12)',
    borderRadius: '3px',
    padding: '0 3px',
    fontSize: '0.82em',
    fontFamily: 'monospace',
  },
  '.cm-latex-ref': {
    color: 'var(--vscode-textLink-foreground, #4a9eff)',
    background: 'rgba(74,158,255,0.10)',
    borderRadius: '3px',
    padding: '0 3px',
    fontSize: '0.82em',
    fontFamily: 'monospace',
  },
  '.cm-latex-cite': {
    color: 'var(--vscode-terminal-ansiGreen, #23d18b)',
    background: 'rgba(35,209,139,0.10)',
    borderRadius: '3px',
    padding: '0 3px',
    fontSize: '0.82em',
    fontFamily: 'monospace',
  },

  // URL
  '.cm-latex-url': {
    color: 'var(--vscode-textLink-foreground, #4a9eff)',
    textDecoration: 'underline',
    fontSize: '0.9em',
  },

  // Footnote — dim and small; content stays visible so it can be edited
  '.cm-latex-footnote': {
    color: 'var(--vscode-editorLineNumber-foreground, #858585)',
    fontSize: '0.82em',
    verticalAlign: 'super',
    background: 'rgba(128,128,128,0.08)',
    borderRadius: '3px',
    padding: '0 2px',
  },
});
