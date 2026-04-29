import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getSettings } from './settings';

// ── Diff types (mirrored from webview/decorations/diff.ts) ───────────────────

interface DiffLine { line: number; type: 'added' | 'modified'; }
interface DiffDeleted { afterLine: number; }
interface InlineSpan {
  line: number;   // 1-based line in new file
  from: number;   // char offset within that line (0-based, in clean new-file text)
  to: number;     // exclusive
  type: 'add' | 'del';
  text?: string;  // only for 'del': the removed text to show inline
}
interface DiffData { lines: DiffLine[]; deletions: DiffDeleted[]; inline: InlineSpan[]; }

export class LaTeXEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'latex-preview.editor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };

    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

    // Track whether the current document change originated from the webview,
    // so we don't echo it back and cause an infinite loop.
    let suppressNextUpdate = false;

    // ── Split view ─────────────────────────────────────────────────────────────
    // Tracks whether THIS panel was responsible for opening the native split tab.
    let didOpenNativeSplit = false;

    // Loop-prevention counters / debounce timers for scroll + cursor sync
    let nativeSyncScrollIgnore = 0;
    let nativeScrollDebounce: ReturnType<typeof setTimeout> | null = null;
    let lastSentScrollLine = -1;

    /** Returns the first visible native TextEditor for this document, if any. */
    const getNativeEditor = (): vscode.TextEditor | undefined =>
      vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === document.uri.toString()
      );

    /** Opens the file in a native VS Code text editor to the side (if not already open). */
    const openNativeSplit = async () => {
      const uriStr = document.uri.toString();
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText &&
              tab.input.uri.toString() === uriStr) {
            return; // A native text tab for this file already exists — don't duplicate
          }
        }
      }
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: true,
      });
      didOpenNativeSplit = true;
    };

    /** Closes the native split tab — only if this panel opened it. */
    const closeNativeSplit = async () => {
      if (!didOpenNativeSplit) { return; }
      didOpenNativeSplit = false;
      const uriStr = document.uri.toString();
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText &&
              tab.input.uri.toString() === uriStr) {
            await vscode.window.tabGroups.close(tab);
            return;
          }
        }
      }
    };

    const sendCitations = async () => {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const pattern = workspaceFolder
        ? new vscode.RelativePattern(workspaceFolder, '**/*.bib')
        : '**/*.bib';
      const bibFiles = await vscode.workspace.findFiles(pattern);
      const keys: string[] = [];
      for (const uri of bibFiles) {
        try {
          const content = fs.readFileSync(uri.fsPath, 'utf8');
          keys.push(...parseBibKeys(content));
        } catch { /* skip unreadable files */ }
      }
      const unique = [...new Set(keys)].sort();
      webviewPanel.webview.postMessage({ type: 'citations', keys: unique });
    };

    // Debounced watcher for .bib file changes
    let bibDebounce: ReturnType<typeof setTimeout> | null = null;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const watchPattern = workspaceFolder
      ? new vscode.RelativePattern(workspaceFolder, '**/*.bib')
      : '**/*.bib';
    const bibWatcher = vscode.workspace.createFileSystemWatcher(watchPattern);
    const onBibChange = () => {
      if (bibDebounce) clearTimeout(bibDebounce);
      bibDebounce = setTimeout(() => sendCitations(), 500);
    };
    bibWatcher.onDidChange(onBibChange);
    bibWatcher.onDidCreate(onBibChange);
    bibWatcher.onDidDelete(onBibChange);

    const sendContent = (diff?: DiffData) => {
      webviewPanel.webview.postMessage({
        type: 'update',
        text: document.getText(),
        diff: diff ?? computeGitDiff(document.uri),
      });
    };

    // Messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          sendContent();
          sendCitations();
          webviewPanel.webview.postMessage({ type: 'settingsUpdate', settings: getSettings() });
          if (getSettings().splitViewEnabled) { openNativeSplit(); }
          break;

        case 'edit': {
          suppressNextUpdate = true;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length)
            ),
            msg.text
          );
          await vscode.workspace.applyEdit(edit);
          suppressNextUpdate = false;
          break;
        }

        case 'reopen':
          // Handled entirely in the webview (raw-mode toggle) — no-op here.
          break;

        case 'scrollSync': {
          if (!getSettings().splitViewEnabled || nativeSyncScrollIgnore > 0) { break; }
          const ne = getNativeEditor();
          if (!ne) { break; }
          const rawLine = (msg as { line: number }).line;
          const line = Math.max(0, Math.min(rawLine - 1, document.lineCount - 1));
          const pos = new vscode.Position(line, 0);
          nativeSyncScrollIgnore++;
          ne.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
          setTimeout(() => nativeSyncScrollIgnore--, 300);
          break;
        }

        case 'cursorSync': {
          if (!getSettings().splitViewEnabled) { break; }
          const ne = getNativeEditor();
          if (!ne) { break; }
          const rawLine = (msg as { line: number }).line;
          const line = Math.max(0, Math.min(rawLine - 1, document.lineCount - 1));
          const pos = new vscode.Position(line, 0);
          ne.selection = new vscode.Selection(pos, pos);
          nativeSyncScrollIgnore++;
          ne.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          setTimeout(() => nativeSyncScrollIgnore--, 300);
          break;
        }
      }
    });

    // External document changes (git checkout, other editors, VSCode undo)
    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        !suppressNextUpdate
      ) {
        sendContent();
      }
    });

    // Recompute diff on save so decorations reflect the committed baseline
    const saveSubscription = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() === document.uri.toString()) {
        webviewPanel.webview.postMessage({
          type: 'diff',
          diff: computeGitDiff(document.uri),
        });
      }
    });

    // Propagate settings changes (from sidebar or settings.json) to this panel
    let prevSplitViewEnabled = getSettings().splitViewEnabled;
    const configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('latex-preview-editor')) {
        const settings = getSettings();
        webviewPanel.webview.postMessage({ type: 'settingsUpdate', settings });
        if (settings.splitViewEnabled && !prevSplitViewEnabled) {
          openNativeSplit();
        } else if (!settings.splitViewEnabled && prevSplitViewEnabled) {
          closeNativeSplit();
        }
        prevSplitViewEnabled = settings.splitViewEnabled;
      }
    });

    // ── Native → webview scroll sync ──────────────────────────────────────────
    const visibleRangesSubscription = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (!getSettings().splitViewEnabled) { return; }
      if (e.textEditor.document.uri.toString() !== document.uri.toString()) { return; }
      if (nativeSyncScrollIgnore > 0) { return; }
      const topLine = (e.visibleRanges[0]?.start.line ?? 0) + 1; // 1-based
      if (topLine === lastSentScrollLine) { return; }
      if (nativeScrollDebounce) { clearTimeout(nativeScrollDebounce); }
      nativeScrollDebounce = setTimeout(() => {
        if (nativeSyncScrollIgnore > 0) { return; }
        lastSentScrollLine = topLine;
        webviewPanel.webview.postMessage({ type: 'scrollSync', line: topLine });
      }, 30);
    });

    // ── Native → webview cursor sync ──────────────────────────────────────────
    const selectionSubscription = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!getSettings().splitViewEnabled) { return; }
      if (e.textEditor.document.uri.toString() !== document.uri.toString()) { return; }
      // Only sync user-initiated movements (Keyboard/Mouse), not programmatic ones
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard &&
          e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) { return; }
      const line = e.selections[0].active.line + 1; // 1-based
      // Suppress the visible-range change that follows cursor movement
      nativeSyncScrollIgnore++;
      setTimeout(() => nativeSyncScrollIgnore--, 200);
      webviewPanel.webview.postMessage({ type: 'cursorSync', line });
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
      saveSubscription.dispose();
      configSubscription.dispose();
      visibleRangesSubscription.dispose();
      selectionSubscription.dispose();
      bibWatcher.dispose();
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             font-src ${webview.cspSource};
             script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>LaTeX Editor</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      height: 100%; width: 100%;
      display: flex; flex-direction: column;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      overflow: hidden;
    }
    /* ── Toolbar ─────────────────────────────────────────── */
    #toolbar {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 0 8px;
      height: 34px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border, #454545);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      user-select: none;
    }
    .tb-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 26px;
      height: 22px;
      padding: 0 6px;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      white-space: nowrap;
    }
    .tb-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
      border-color: var(--vscode-toolbar-hoverOutline, transparent);
    }
    .tb-btn:active {
      background: var(--vscode-toolbar-activeBackground, rgba(99,102,103,0.31));
    }
    .tb-btn-active {
      background: var(--vscode-toolbar-activeBackground, rgba(99,102,103,0.31));
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .tb-sep {
      width: 1px;
      height: 16px;
      margin: 0 4px;
      background: var(--vscode-panel-border, #454545);
      flex-shrink: 0;
    }
    .tb-select {
      height: 22px;
      padding: 0 4px;
      border: 1px solid var(--vscode-panel-border, #454545);
      border-radius: 3px;
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #cccccc);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      outline: none;
    }
    .tb-select:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    /* ── Editor area ─────────────────────────────────────── */
    #editor, #raw-view {
      flex: 1 1 0;
      min-height: 0;
      overflow: hidden;
    }
    #raw-view {
      display: none;
    }
    #raw-text {
      width: 100%;
      height: 100%;
      resize: none;
      border: none;
      outline: none;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family, "Courier New", monospace);
      font-size: var(--vscode-editor-font-size, 14px);
      line-height: 1.6;
      padding: 16px;
      box-sizing: border-box;
    }
    .cm-editor { height: 100%; }
    .cm-scroller { overflow: auto; }
  </style>
</head>
<body>
  <div id="toolbar">
    <button class="tb-btn" data-cmd="bold"      title="Bold (Ctrl+B)"><b>B</b></button>
    <button class="tb-btn" data-cmd="italic"    title="Italic (Ctrl+I)"><i>I</i></button>
    <button class="tb-btn" data-cmd="underline" title="Underline (Ctrl+U)" style="text-decoration:underline">U</button>
    <button class="tb-btn" data-cmd="code"      title="Monospace / Code (Ctrl+Shift+M)" style="font-family:monospace">TT</button>
    <button class="tb-btn" data-cmd="cite"      title="Cite (Ctrl+Shift+C)">Cite</button>
    <div class="tb-sep"></div>
    <select id="tb-font" class="tb-select" title="Font family">
      <option value="">Default</option>
      <option value="'Courier New', monospace">Courier New</option>
      <option value="'Consolas', 'Monaco', 'Menlo', monospace">Consolas</option>
      <option value="'Georgia', serif">Georgia</option>
      <option value="'Times New Roman', Times, serif">Times New Roman</option>
      <option value="'Arial', 'Helvetica Neue', sans-serif">Arial</option>
    </select>
    <select id="tb-size" class="tb-select" title="Font size" style="width:52px">
      <option value="11">11px</option>
      <option value="12">12px</option>
      <option value="13">13px</option>
      <option value="14" selected>14px</option>
      <option value="16">16px</option>
      <option value="18">18px</option>
      <option value="20">20px</option>
    </select>
    <select id="tb-align" class="tb-select" title="Text alignment" style="width:72px">
      <option value="left" selected>Left</option>
      <option value="justify">Justify</option>
    </select>
    <select id="tb-width" class="tb-select" title="Line width (max column width)" style="width:72px">
      <option value="680px">680px</option>
      <option value="780px" selected>780px</option>
      <option value="960px">960px</option>
      <option value="1200px">1200px</option>
      <option value="100%">Full</option>
    </select>
    <div class="tb-sep"></div>
    <button class="tb-btn" data-cmd="toggleDiff" title="Toggle diff decorations (off by default)">± Diff</button>
    <div class="tb-sep"></div>
    <button class="tb-btn" data-cmd="reopen"    title="Switch to plain text view">⊞ Text</button>
  </div>
  <div id="editor"></div>
  <div id="raw-view"><textarea id="raw-text" spellcheck="false"></textarea></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

// ── BibTeX helpers ────────────────────────────────────────────────────────────

/** Extract citation keys from a BibTeX file, skipping non-entry types. */
function parseBibKeys(content: string): string[] {
  const NON_KEY_TYPES = new Set(['string', 'preamble', 'comment']);
  const keys: string[] = [];
  const re = /@(\w+)\s*\{\s*([^,\s{]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (!NON_KEY_TYPES.has(m[1].toLowerCase())) {
      keys.push(m[2]);
    }
  }
  return keys;
}

// ── Git diff helpers ──────────────────────────────────────────────────────────

function computeGitDiff(docUri: vscode.Uri): DiffData {
  const filePath = docUri.fsPath;
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  const result = spawnSync('git', ['diff', 'HEAD', '--word-diff=plain', '--', file], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return { lines: [], deletions: [], inline: [] };
  }
  return parseDiff(result.stdout);
}

function parseDiff(diff: string): DiffData {
  const lines: DiffLine[] = [];
  const deletions: DiffDeleted[] = [];
  const inline: InlineSpan[] = [];
  let currentNewLine = 0;
  let lastDeletionAfterLine = -1;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) currentNewLine = parseInt(m[1], 10) - 1;
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      // Pure addition — entire line is new
      currentNewLine++;
      const content = raw.slice(1);
      lines.push({ line: currentNewLine, type: 'added' });
      if (content.length > 0) {
        inline.push({ line: currentNewLine, from: 0, to: content.length, type: 'add' });
      }
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      // Pure deletion — line removed, show a red bar once per group
      if (lastDeletionAfterLine !== currentNewLine) {
        deletions.push({ afterLine: currentNewLine });
        lastDeletionAfterLine = currentNewLine;
      }
    } else if (
      raw.length > 0 &&
      !raw.startsWith('\\') &&
      !raw.startsWith('diff') &&
      !raw.startsWith('index') &&
      !raw.startsWith('---') &&
      !raw.startsWith('+++')
    ) {
      // Context line (space prefix) — may carry inline word-diff markers
      currentNewLine++;
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      const hasMarkers = content.includes('[-') || content.includes('{+');
      if (hasMarkers) {
        lines.push({ line: currentNewLine, type: 'modified' });
        parseWordDiffMarkers(content, currentNewLine, inline);
      }
    }
  }

  return { lines, deletions, inline };
}

/** Parse `[-deleted-]` and `{+added+}` markers from a word-diff context line.
 *  Computes character offsets in the clean new-file text (markers removed). */
function parseWordDiffMarkers(content: string, lineNum: number, inline: InlineSpan[]) {
  let col = 0; // column in the clean new-file version of this line
  let i = 0;

  while (i < content.length) {
    if (content[i] === '[' && content[i + 1] === '-') {
      const end = content.indexOf('-]', i + 2);
      if (end !== -1) {
        const deleted = content.slice(i + 2, end);
        // Insert a widget BEFORE col to show deleted text in red
        inline.push({ line: lineNum, from: col, to: col, type: 'del', text: deleted });
        i = end + 2;
        continue;
      }
    }
    if (content[i] === '{' && content[i + 1] === '+') {
      const end = content.indexOf('+}', i + 2);
      if (end !== -1) {
        const added = content.slice(i + 2, end);
        inline.push({ line: lineNum, from: col, to: col + added.length, type: 'add' });
        col += added.length;
        i = end + 2;
        continue;
      }
    }
    col++;
    i++;
  }
}
