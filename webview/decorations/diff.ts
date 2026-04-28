import {
  Decoration,
  DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
} from '@codemirror/view';
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';

// ── Public types ──────────────────────────────────────────────────────────────

export interface DiffLine {
  line: number;   // 1-based line number in the current file
  type: 'added' | 'modified';
}

export interface DiffDeleted {
  afterLine: number; // deletions occurred after this 1-based line (0 = before line 1)
}

export interface InlineSpan {
  line: number;   // 1-based
  from: number;   // char offset within that line (in clean new-file text)
  to: number;     // exclusive
  type: 'add' | 'del';
  text?: string;  // only for 'del': the removed text shown as an inline widget
}

export interface DiffData {
  lines: DiffLine[];
  deletions: DiffDeleted[];
  inline: InlineSpan[];
}

// ── State effect ──────────────────────────────────────────────────────────────

export const setDiffData = StateEffect.define<DiffData>();

// ── Raw DiffData field (used by gutter markers function) ──────────────────────

export const diffDataField = StateField.define<DiffData>({
  create: () => ({ lines: [], deletions: [], inline: [] }),
  update(data, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setDiffData)) return eff.value;
    }
    return data;
  },
});

// ── Line highlight decorations (separate field to avoid sort-order mixing) ────

const addedLineDec = Decoration.line({ class: 'cm-diff-added' });
const modifiedLineDec = Decoration.line({ class: 'cm-diff-modified' });

export const diffLineDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decs, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setDiffData)) {
        const { lines } = eff.value;
        if (!lines.length) return Decoration.none;
        const builder = new RangeSetBuilder<Decoration>();
        const sorted = [...lines].sort((a, b) => a.line - b.line);
        for (const dl of sorted) {
          if (dl.line < 1 || dl.line > tr.state.doc.lines) continue;
          const pos = tr.state.doc.line(dl.line).from;
          builder.add(pos, pos, dl.type === 'added' ? addedLineDec : modifiedLineDec);
        }
        return builder.finish();
      }
    }
    if (tr.docChanged) return decs.map(tr.changes);
    return decs;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Deletion bar widgets (separate field — never at same pos as line decs) ────

class DeletionBarWidget extends WidgetType {
  eq(other: WidgetType) { return other instanceof DeletionBarWidget; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-diff-deletion-bar';
    return el;
  }
  ignoreEvent() { return true; }
}

const deletionBar = new DeletionBarWidget();

export const diffDeletionDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decs, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setDiffData)) {
        const { deletions } = eff.value;
        if (!deletions.length) return Decoration.none;
        const builder = new RangeSetBuilder<Decoration>();
        const sorted = [...deletions].sort((a, b) => a.afterLine - b.afterLine);
        for (const del of sorted) {
          let pos: number;
          if (del.afterLine <= 0) {
            pos = 0;
          } else if (del.afterLine >= tr.state.doc.lines) {
            pos = tr.state.doc.length;
          } else {
            pos = tr.state.doc.line(del.afterLine + 1).from;
          }
          builder.add(pos, pos, Decoration.widget({ widget: deletionBar, side: -1, block: true }));
        }
        return builder.finish();
      }
    }
    if (tr.docChanged) return decs.map(tr.changes);
    return decs;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Inline text mark decorations (added spans green, deleted spans red) ───────

class InlineDeletionWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: WidgetType) {
    return other instanceof InlineDeletionWidget && other.text === this.text;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-diff-inline-del';
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() { return false; }
}

export const diffInlineDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decs, tr) {
    for (const eff of tr.effects) {
      if (eff.is(setDiffData)) {
        const spans = eff.value.inline;
        if (!spans?.length) return Decoration.none;
        const builder = new RangeSetBuilder<Decoration>();
        // Sort: ascending line/from; at same pos put del (side:-1) before add (side:0)
        const sorted = [...spans].sort((a, b) => {
          if (a.line !== b.line) return a.line - b.line;
          if (a.from !== b.from) return a.from - b.from;
          return a.type === 'del' ? -1 : 1;
        });
        for (const span of sorted) {
          if (span.line < 1 || span.line > tr.state.doc.lines) continue;
          const lineInfo = tr.state.doc.line(span.line);
          const docFrom = lineInfo.from + span.from;
          const docTo = lineInfo.from + Math.min(span.to, lineInfo.length);
          if (span.type === 'add' && docFrom < docTo) {
            builder.add(docFrom, docTo, Decoration.mark({ class: 'cm-diff-inline-add' }));
          } else if (span.type === 'del' && span.text) {
            builder.add(
              docFrom, docFrom,
              Decoration.widget({ widget: new InlineDeletionWidget(span.text), side: -1 }),
            );
          }
        }
        return builder.finish();
      }
    }
    if (tr.docChanged) return decs.map(tr.changes);
    return decs;
  },
  provide: f => EditorView.decorations.from(f),
});



class AddedGutterMarker extends GutterMarker {
  eq(other: GutterMarker) { return other instanceof AddedGutterMarker; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-diff-gutter-added';
    return el;
  }
}

class ModifiedGutterMarker extends GutterMarker {
  eq(other: GutterMarker) { return other instanceof ModifiedGutterMarker; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-diff-gutter-modified';
    return el;
  }
}

const addedGutterMarker = new AddedGutterMarker();
const modifiedGutterMarker = new ModifiedGutterMarker();

export const diffGutter = gutter({
  class: 'cm-diff-gutter',
  markers(view) {
    const data = view.state.field(diffDataField);
    if (!data.lines.length) return new RangeSetBuilder<GutterMarker>().finish();
    const builder = new RangeSetBuilder<GutterMarker>();
    const sorted = [...data.lines].sort((a, b) => a.line - b.line);
    for (const dl of sorted) {
      if (dl.line < 1 || dl.line > view.state.doc.lines) continue;
      const pos = view.state.doc.line(dl.line).from;
      builder.add(pos, pos, dl.type === 'added' ? addedGutterMarker : modifiedGutterMarker);
    }
    return builder.finish();
  },
});

// ── Theme ─────────────────────────────────────────────────────────────────────

export const diffTheme = EditorView.baseTheme({
  '.cm-diff-added': {
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
  },
  '.cm-diff-modified': {
    backgroundColor: 'rgba(234, 179, 8, 0.12)',
  },
  '.cm-diff-deletion-bar': {
    display: 'block',
    height: '2px',
    backgroundColor: '#ef4444',
    width: '100%',
    pointerEvents: 'none',
  },
  '.cm-diff-inline-add': {
    color: '#16a34a',
    backgroundColor: 'rgba(34, 197, 94, 0.25)',
    borderRadius: '2px',
  },
  '.cm-diff-inline-del': {
    color: '#dc2626',
    backgroundColor: 'rgba(239, 68, 68, 0.18)',
    textDecoration: 'line-through',
    borderRadius: '2px',
    opacity: '0.85',
  },
  '.cm-diff-gutter': {
    width: '3px',
    padding: '0',
    marginRight: '2px',
  },
  '.cm-diff-gutter .cm-gutterElement': {
    padding: '0',
  },
  '.cm-diff-gutter-added': {
    width: '3px',
    height: '100%',
    backgroundColor: '#22c55e',
    display: 'block',
  },
  '.cm-diff-gutter-modified': {
    width: '3px',
    height: '100%',
    backgroundColor: '#eab308',
    display: 'block',
  },
});

// ── Bundle ────────────────────────────────────────────────────────────────────

export const diffExtensions = [
  diffDataField,
  diffLineDecorations,
  diffDeletionDecorations,
  diffInlineDecorations,
  diffGutter,
  diffTheme,
];
