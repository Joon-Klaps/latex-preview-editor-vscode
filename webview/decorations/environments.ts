import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// ── Widgets ───────────────────────────────────────────────────────────────────

/** Replaces \item (or \item[label]) with a visible bullet or number. */
class ItemWidget extends WidgetType {
  constructor(readonly label: string) { super(); }

  eq(other: ItemWidget): boolean {
    return other instanceof ItemWidget && this.label === other.label;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-latex-item-marker';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.label;
    return span;
  }

  // Allow cursor to pass through so clicking near an item still works
  ignoreEvent(): boolean { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ListEnv {
  type: 'itemize' | 'enumerate';
  from: number;      // start of \begin{…}
  beginEnd: number;  // end of \begin{…}
  endStart: number;  // start of \end{…}
  to: number;        // end of \end{…}
  items: Array<{ from: number; to: number }>; // each \item token span
}

const BEGIN_RE = /\\begin\{(itemize|enumerate)\}/g;

/** Scan the full document for itemize/enumerate environments. */
function scanLists(text: string): ListEnv[] {
  const envs: ListEnv[] = [];
  BEGIN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = BEGIN_RE.exec(text)) !== null) {
    const type = m[1] as 'itemize' | 'enumerate';
    const from = m.index;
    const beginEnd = m.index + m[0].length;

    const endTag = `\\end{${type}}`;
    const endStart = text.indexOf(endTag, beginEnd);
    if (endStart === -1) continue;
    const to = endStart + endTag.length;

    // Collect \item tokens inside the environment body
    const body = text.slice(beginEnd, endStart);
    const itemRe = /\\item(?:\[[^\]]*\])?/g;
    const items: ListEnv['items'] = [];
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(body)) !== null) {
      items.push({ from: beginEnd + im.index, to: beginEnd + im.index + im[0].length });
    }

    envs.push({ type, from, beginEnd, endStart, to, items });
  }

  return envs;
}

// ── Builder ───────────────────────────────────────────────────────────────────

const HIDE = Decoration.replace({});
const COMMENT_MARK = Decoration.mark({ class: 'cm-latex-comment' });

function buildEnvDecorations(view: EditorView): DecorationSet {
  const docText = view.state.doc.toString();
  const collected: { from: number; to: number; dec: Decoration }[] = [];
  const selRanges = view.state.selection.ranges;
  const anyCursorIn = (from: number, to: number) =>
    selRanges.some((r) => r.from <= to && r.to >= from);

  // ── Comments: % … <EOL> ───────────────────────────────────────────────────
  // Only process visible range for comments (they're frequent)
  for (const { from: vpFrom, to: vpTo } of view.visibleRanges) {
    const slice = docText.slice(vpFrom, vpTo);
    // Match % not preceded by \ (lookbehind is safe in modern V8)
    const commentRe = /(?<!\\)%[^\n]*/g;
    let cm: RegExpExecArray | null;
    while ((cm = commentRe.exec(slice)) !== null) {
      const from = vpFrom + cm.index;
      const to = from + cm[0].length;
      collected.push({ from, to, dec: COMMENT_MARK });
    }
  }

  // ── List environments ─────────────────────────────────────────────────────
  for (const env of scanLists(docText)) {
    // Expand to raw when cursor is anywhere inside
    if (anyCursorIn(env.from, env.to)) continue;

    // Hide \begin{itemize/enumerate}
    collected.push({ from: env.from, to: env.beginEnd, dec: HIDE });

    // Replace each \item with bullet or number widget
    env.items.forEach(({ from, to }, idx) => {
      const label = env.type === 'itemize' ? '•' : `${idx + 1}.`;
      collected.push({ from, to, dec: Decoration.replace({ widget: new ItemWidget(label) }) });
    });

    // Hide \end{itemize/enumerate}
    collected.push({ from: env.endStart, to: env.to, dec: HIDE });
  }

  // Sort by (from, to) before building — required by RangeSetBuilder
  collected.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, dec } of collected) {
    builder.add(from, to, dec);
  }
  return builder.finish();
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const envDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildEnvDecorations(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildEnvDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Theme ─────────────────────────────────────────────────────────────────────

export const envDecorationsTheme = EditorView.baseTheme({
  '.cm-latex-comment': {
    color: 'var(--vscode-editorLineNumber-foreground, #858585)',
    fontStyle: 'italic',
    opacity: '0.75',
  },
  '.cm-latex-item-marker': {
    color: 'var(--vscode-terminal-ansiBrightGreen, #23d18b)',
    fontWeight: 'bold',
    fontFamily: 'sans-serif',
    marginRight: '0.3em',
    userSelect: 'none',
  },
});
