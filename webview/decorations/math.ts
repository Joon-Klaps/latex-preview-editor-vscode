import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder, StateField, EditorState } from '@codemirror/state';
import katex from 'katex';

// ── Widget ────────────────────────────────────────────────────────────────────

class MathWidget extends WidgetType {
  constructor(readonly math: string, readonly display: boolean) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other instanceof MathWidget &&
      this.math === other.math &&
      this.display === other.display;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.display ? 'cm-latex-math-display' : 'cm-latex-math-inline';
    try {
      katex.render(this.math, el, {
        displayMode: this.display,
        throwOnError: false,
        errorColor: '#cc3333',
        trust: false,
        // Needed for \begin{align} etc. passed as full environments
        strict: false,
      });
    } catch {
      el.textContent = this.display ? `\\[${this.math}\\]` : `$${this.math}$`;
      el.style.color = '#cc3333';
    }
    return el;
  }

  ignoreEvent(): boolean { return false; }
}

// ── Math scanner ──────────────────────────────────────────────────────────────

interface MathRange {
  from: number;
  to: number;
  content: string; // the string passed to KaTeX
  display: boolean;
}

/**
 * Linear scanner that finds all math ranges in the document text.
 * Handles in priority order: \begin{eq-env}, \[..\], $$..$$, $..$.
 * Correctly skips \$ escapes and % comments.
 */
function scanMath(text: string): MathRange[] {
  const ranges: MathRange[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    // ── Skip % comments (to end of line) ──────────────────────────────────
    if (ch === '%') {
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // ── Backslash sequences ───────────────────────────────────────────────
    if (ch === '\\') {
      const next = text[i + 1];

      // \[ ... \]  — display math
      if (next === '[') {
        const start = i;
        i += 2;
        const cStart = i;
        while (i < len && !(text[i] === '\\' && text[i + 1] === ']')) i++;
        if (i < len) {
          ranges.push({ from: start, to: i + 2, content: text.slice(cStart, i), display: true });
          i += 2;
        }
        continue;
      }

      // \begin{equation|align|gather|…}  — display math environment
      const envM = /^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|flalign\*?)\}/.exec(
        text.slice(i)
      );
      if (envM) {
        const envName = envM[1];
        const start = i;
        i += envM[0].length;
        const endTag = `\\end{${envName}}`;
        const endIdx = text.indexOf(endTag, i);
        if (endIdx !== -1) {
          // Pass the full environment to KaTeX so it handles numbering / alignment
          const content = `\\begin{${envName}}${text.slice(i, endIdx)}\\end{${envName}}`;
          ranges.push({ from: start, to: endIdx + endTag.length, content, display: true });
          i = endIdx + endTag.length;
        }
        continue;
      }

      // \$ — escaped dollar, skip
      if (next === '$') { i += 2; continue; }

      // Any other backslash sequence
      i += 2;
      continue;
    }

    // ── Dollar signs ──────────────────────────────────────────────────────
    if (ch === '$') {
      // $$ ... $$  — display math
      if (text[i + 1] === '$') {
        const start = i;
        i += 2;
        const cStart = i;
        while (i < len && !(text[i] === '$' && text[i + 1] === '$')) i++;
        if (i < len) {
          ranges.push({ from: start, to: i + 2, content: text.slice(cStart, i), display: true });
          i += 2;
        }
        continue;
      }

      // $ ... $  — inline math (must not span newlines)
      const start = i;
      i++;
      const cStart = i;
      let closed = false;
      while (i < len && text[i] !== '\n') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$') { closed = true; break; }
        i++;
      }
      if (closed) {
        ranges.push({ from: start, to: i + 1, content: text.slice(cStart, i), display: false });
        i++;
      }
      continue;
    }

    i++;
  }

  return ranges;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * StateField (not ViewPlugin) because CM6 only permits block-replace decorations
 * that span line breaks when provided via StateField, not ViewPlugin.
 */
function buildMathDecorations(state: EditorState): DecorationSet {
  const docText = state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  const selRanges = state.selection.ranges;

  for (const r of scanMath(docText)) {
    const cursorInside = selRanges.some(
      (sel) => sel.from <= r.to && sel.to >= r.from
    );
    if (cursorInside) continue;

    const isMultiLine =
      state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to - 1).number;

    builder.add(
      r.from,
      r.to,
      Decoration.replace({ widget: new MathWidget(r.content, r.display), block: isMultiLine })
    );
  }

  return builder.finish();
}

// ── StateField ────────────────────────────────────────────────────────────────

export const mathDecorations = StateField.define<DecorationSet>({
  create(state) { return buildMathDecorations(state); },
  update(decs, tr) {
    if (tr.docChanged || tr.selection !== undefined) return buildMathDecorations(tr.state);
    return decs.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── Theme ─────────────────────────────────────────────────────────────────────

export const mathDecorationsTheme = EditorView.baseTheme({
  '.cm-latex-math-inline': {
    display: 'inline-block',
    verticalAlign: 'middle',
  },
  '.cm-latex-math-display': {
    display: 'block',
    textAlign: 'center',
    margin: '0.75em 0',
    overflowX: 'auto',
  },
});
