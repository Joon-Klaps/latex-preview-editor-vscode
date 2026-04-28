import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder, StateField, EditorState } from '@codemirror/state';

// ── Widgets ───────────────────────────────────────────────────────────────────

/** Replaces figure/table environments with a visual preview of the caption. */
class FigureWidget extends WidgetType {
  constructor(
    readonly envFrom: number,
    readonly envType: 'figure' | 'table',
    readonly caption: string,
    readonly label: string | null,
    readonly imagePath: string | null,
    readonly docBaseUri: string,
  ) {
    super();
  }

  eq(other: FigureWidget): boolean {
    return (
      other instanceof FigureWidget &&
      this.envFrom === other.envFrom &&
      this.envType === other.envType &&
      this.caption === other.caption &&
      this.label === other.label &&
      this.imagePath === other.imagePath &&
      this.docBaseUri === other.docBaseUri
    );
  }

  /** Suppress CM6's coordinate→position mapping for mouse events; we handle mousedown ourselves. */
  ignoreEvent(event: Event): boolean {
    return event instanceof MouseEvent;
  }

  toDOM(view: EditorView): HTMLElement {
    const div = document.createElement('div');
    div.className = `cm-latex-${this.envType}`;
    div.style.cursor = 'text';
    // Use mousedown (not click) — CM6 updates selection on mousedown, so we must
    // intercept it before CM6 does. stopPropagation prevents the contentDOM handler
    // from receiving it; preventDefault stops browser native cursor placement.
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ selection: { anchor: this.envFrom } });
      view.focus();
    });

    // Image preview (figures only, not tables)
    if (this.envType === 'figure' && this.imagePath && this.docBaseUri) {
      div.appendChild(this.buildImagePreview());
    }

    const footer = document.createElement('div');
    footer.className = `cm-latex-${this.envType}-footer`;

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

    footer.appendChild(badge);
    footer.appendChild(captionEl);
    div.appendChild(footer);

    return div;
  }

  private buildImagePreview(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-latex-figure-img-container';

    const img = document.createElement('img');
    img.className = 'cm-latex-figure-img';
    img.loading = 'lazy';
    img.alt = this.caption || 'figure';

    const base = this.docBaseUri.replace(/\/$/, '');
    const hasExtension = /\.[a-zA-Z0-9]{2,4}$/.test(this.imagePath!);

    if (hasExtension) {
      img.src = `${base}/${this.imagePath}`;
      img.onerror = () => { container.style.display = 'none'; };
    } else {
      // LaTeX searches common extensions; try in order
      const exts = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];
      let idx = 0;
      const tryNext = () => {
        if (idx >= exts.length) { container.style.display = 'none'; return; }
        img.src = `${base}/${this.imagePath}${exts[idx++]}`;
      };
      img.onerror = tryNext;
      tryNext();
    }

    container.appendChild(img);
    return container;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface FigureEnv {
  type: 'figure' | 'table';
  from: number;
  beginEnd: number;
  endStart: number;
  to: number;
  caption: string;
  label: string | null;
  imagePath: string | null;
}

const BEGIN_RE = /\\begin\{(figure|table)\*?\}/g;

/** Extract caption text from LaTeX. */
function extractCaption(text: string): string {
  const m = /\\caption\s*\{([^}]*)\}/.exec(text);
  return m ? m[1].trim() : '';
}

/** Extract label for cross-references. */
function extractLabel(text: string): string | null {
  const m = /\\label\{([^}]+)\}/.exec(text);
  return m ? m[1] : null;
}

/** Extract the first \includegraphics path. */
function extractIncludeGraphics(text: string): string | null {
  const m = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/.exec(text);
  return m ? m[1].trim() : null;
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
    envs.push({
      type, from, beginEnd, endStart, to,
      caption: extractCaption(body),
      label: extractLabel(body),
      imagePath: extractIncludeGraphics(body),
    });
  }

  return envs;
}

// ── Builder + StateField factory ──────────────────────────────────────────────

/**
 * Factory function so the resolved document base URI (for loading images)
 * is captured in the closure and available to the widget at render time.
 * StateField is used (not ViewPlugin) because block-replace decorations that
 * span line breaks are only permitted in StateField extensions.
 */
export function createFigureDecorations(docBaseUri: string) {
  function build(state: EditorState): DecorationSet {
    const docText = state.doc.toString();
    const builder = new RangeSetBuilder<Decoration>();
    const selRanges = state.selection.ranges;

    for (const env of scanFigures(docText)) {
      const cursorInside = selRanges.some(
        (sel) => sel.from <= env.to && sel.to >= env.from
      );
      if (cursorInside) continue;

      builder.add(
        env.from,
        env.to,
        Decoration.replace({
          widget: new FigureWidget(env.from, env.type, env.caption, env.label, env.imagePath, docBaseUri),
          block: true,
        })
      );
    }

    return builder.finish();
  }

  return StateField.define<DecorationSet>({
    create(state) { return build(state); },
    update(decs, tr) {
      if (tr.docChanged || tr.selection !== undefined) return build(tr.state);
      return decs.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ── Theme ─────────────────────────────────────────────────────────────────────

export const figureDecorationsTheme = EditorView.baseTheme({
  '.cm-latex-figure': {
    display: 'block',
    margin: '1em 0',
    padding: '0',
    backgroundColor: 'var(--vscode-badge-background, #007acc)',
    color: 'var(--vscode-badge-foreground, #ffffff)',
    borderRadius: '4px',
    fontSize: '0.95em',
    lineHeight: '1.5',
    overflow: 'hidden',
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
  '.cm-latex-figure-img-container': {
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
    padding: '0.5em',
  },
  '.cm-latex-figure-img': {
    maxHeight: '160px',
    maxWidth: '100%',
    objectFit: 'contain',
    borderRadius: '2px',
    display: 'block',
    margin: '0 auto',
  },
  '.cm-latex-figure-footer, .cm-latex-table-footer': {
    padding: '0.5em 1em',
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
});
