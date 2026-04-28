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

/** Replaces figure/table environments with a visual preview of the caption. */
class FigureWidget extends WidgetType {
  constructor(
    readonly envType: 'figure' | 'table',
    readonly caption: string,
    readonly label: string | null
  ) {
    super();
  }

  eq(other: FigureWidget): boolean {
    return (
      other instanceof FigureWidget &&
      this.envType === other.envType &&
      this.caption === other.caption &&
      this.label === other.label
    );
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = `cm-latex-${this.envType}`;

    const badge = document.createElement('span');
    badge.className = `cm-latex-${this.envType}-badge`;
    badge.textContent = this.envType === 'figure' ? '🖼 Figure' : '📊 Table';

    const captionEl = document.createElement('span');
    captionEl.className = `cm-latex-${this.envType}-caption`;
    captionEl.textContent = this.caption || `[${this.envType} content]`;

    if (this.label) {
      const labelEl = document.createElement('span');
      labelEl.className = `cm-latex-${this.envType}-label`;
      labelEl.textContent = ` (${this.label})`;
      captionEl.appendChild(labelEl);
    }

    div.appendChild(badge);
    div.appendChild(captionEl);

    return div;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FigureEnv {
  type: 'figure' | 'table';
  from: number;      // start of \begin{…}
  beginEnd: number;  // end of \begin{…}
  endStart: number;  // start of \end{…}
  to: number;        // end of \end{…}
  caption: string;   // extracted caption text
  label: string | null; // extracted label (if present)
}

const BEGIN_RE = /\\begin\{(figure|table)\*?\}/g;

/** Extract caption text from LaTeX. Handles nested braces. */
function extractCaption(text: string): string {
  const captionM = /\\caption\s*\{([^}]*)\}/.exec(text);
  return captionM ? captionM[1].trim() : '';
}

/** Extract label (for cross-references). */
function extractLabel(text: string): string | null {
  const labelM = /\\label\{([^}]+)\}/.exec(text);
  return labelM ? labelM[1] : null;
}

/** Scan the full document for figure and table environments. */
function scanFigures(text: string): FigureEnv[] {
  const envs: FigureEnv[] = [];
  BEGIN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = BEGIN_RE.exec(text)) !== null) {
    const type = m[1] as 'figure' | 'table';
    const from = m.index;
    const beginEnd = m.index + m[0].length;

    const endTag = `\\end{${type}${m[0].includes('*') ? '*' : ''}}`;
    const endStart = text.indexOf(endTag, beginEnd);
    if (endStart === -1) continue;
    const to = endStart + endTag.length;

    const body = text.slice(beginEnd, endStart);
    const caption = extractCaption(body);
    const label = extractLabel(body);

    envs.push({ type, from, beginEnd, endStart, to, caption, label });
  }

  return envs;
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildFigureDecorations(view: EditorView): DecorationSet {
  const docText = view.state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();

  for (const env of scanFigures(docText)) {
    // Expand to raw when cursor is anywhere inside
    const cursorInside = view.state.selection.ranges.some(
      (sel) => sel.from <= env.to && sel.to >= env.from
    );
    if (cursorInside) continue;

    // Get line boundaries for hiding
    const startLine = view.state.doc.lineAt(env.from);
    const endLine = view.state.doc.lineAt(env.to - 1);

    // Add widget at the start of the environment
    builder.add(
      env.from,
      env.from,
      Decoration.widget({
        widget: new FigureWidget(env.type, env.caption, env.label),
        side: -1,
      })
    );

    // Hide all lines within the environment
    for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
      const line = view.state.doc.line(lineNum);
      builder.add(line.from, line.from, Decoration.line({ class: 'cm-latex-figure-hidden' }));
    }
  }

  return builder.finish();
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const figureDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFigureDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildFigureDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Theme ─────────────────────────────────────────────────────────────────────

export const figureDecorationsTheme = EditorView.baseTheme({
  '.cm-latex-figure': {
    display: 'block',
    margin: '1em 0',
    padding: '0.75em 1em',
    backgroundColor: 'var(--vscode-badge-background, #007acc)',
    color: 'var(--vscode-badge-foreground, #ffffff)',
    borderRadius: '4px',
    fontSize: '0.95em',
    lineHeight: '1.5',
  },
  '.cm-latex-table': {
    display: 'block',
    margin: '1em 0',
    padding: '0.75em 1em',
    backgroundColor: 'var(--vscode-badge-background, #007acc)',
    color: 'var(--vscode-badge-foreground, #ffffff)',
    borderRadius: '4px',
    fontSize: '0.95em',
    lineHeight: '1.5',
  },
  '.cm-latex-figure-badge, .cm-latex-table-badge': {
    display: 'inline-block',
    marginRight: '0.5em',
    fontWeight: 'bold',
  },
  '.cm-latex-figure-caption, .cm-latex-table-caption': {
    display: 'inline',
  },
  '.cm-latex-figure-label, .cm-latex-table-label': {
    opacity: '0.85',
    fontStyle: 'italic',
    fontSize: '0.9em',
  },
  '.cm-latex-figure-hidden, .cm-latex-table-hidden': {
    opacity: '0',
    pointerEvents: 'none',
    height: '0',
    margin: '0',
    padding: '0',
    lineHeight: '0',
  },
});
