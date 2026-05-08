import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getSettings, type FimFormat } from './settings';

const fimLog = vscode.window.createOutputChannel('LaTeX Preview – FIM');

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
    let suppressUpdateCount = 0;

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

    const sendContent = () => {
      webviewPanel.webview.postMessage({
        type: 'update',
        text: document.getText(),
        original: getGitHead(document.uri),
      });
    };

    // Messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          sendContent();
          sendCitations();
          webviewPanel.webview.postMessage({ type: 'settingsUpdate', settings: getSettings() });
          break;

        case 'edit': {
          suppressUpdateCount++;
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
          suppressUpdateCount--;
          break;
        }

        case 'reopen':
          // Handled entirely in the webview (raw-mode toggle) — no-op here.
          break;

        case 'complete': {
          const { id, prefix, suffix } = msg as { type: string; id: string; prefix: string; suffix: string };
          fimLog.show(true);
          fimLog.appendLine(`[FIM] complete message received id=${id.slice(0, 6)}`);
          let prediction = '';
          try {
            const { ollamaUrl, ollamaModel, ollamaMaxTokens, ollamaFimFormat } = getSettings();
            fimLog.appendLine(`ollamaUrl=${ollamaUrl}, ollamaModel=${ollamaModel}, ollamaMaxTokens=${ollamaMaxTokens}, ollamaFimFormat=${ollamaFimFormat}`);
            prediction = await fetchOllamaCompletion(prefix, suffix, ollamaUrl, ollamaModel, ollamaMaxTokens, ollamaFimFormat);
          } catch (e) {
            fimLog.appendLine(`[FIM] outer catch: ${e}`);
          }
          fimLog.appendLine(`[FIM] sending prediction=${JSON.stringify(prediction)}`);
          webviewPanel.webview.postMessage({ type: 'completion', id, prediction });
          break;
        }
      }
    });

    // External document changes (git checkout, other editors, VSCode undo)
    const changeSubscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        e.document.uri.toString() === document.uri.toString() &&
        suppressUpdateCount === 0
      ) {
        sendContent();
      }
    });

    // Recompute HEAD on save so the diff baseline stays current after each commit
    const saveSubscription = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved.uri.toString() === document.uri.toString()) {
        webviewPanel.webview.postMessage({
          type: 'diff',
          original: getGitHead(document.uri),
        });
      }
    });

    // Propagate settings changes (from sidebar or settings.json) to this panel
    const configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('latex-preview-editor')) {
        webviewPanel.webview.postMessage({ type: 'settingsUpdate', settings: getSettings() });
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSubscription.dispose();
      saveSubscription.dispose();
      configSubscription.dispose();
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
    #fim-status {
      margin-left: auto;
      font-size: 14px;
      line-height: 1;
      display: none;
      animation: fim-spin 1s linear infinite;
    }
    @keyframes fim-spin { to { transform: rotate(360deg); } }
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
    <button class="tb-btn tb-btn-active" data-cmd="toggleDiff" title="Toggle diff decorations (on by default)">± Diff</button>
    <div class="tb-sep"></div>
    <button class="tb-btn" data-cmd="reopen"    title="Switch to plain text view">⊞ Text</button>
    <span id="fim-status" title="Ollama generating…">⚙</span>
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

// ── Ollama FIM helpers ────────────────────────────────────────────────────────

const MULTILINE_ENVS = new Set([
  'align', 'align*', 'aligned', 'gather', 'gather*', 'multline', 'multline*',
  'tabular', 'array', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix',
  'itemize', 'enumerate', 'description',
]);

function resolveFimFormat(model: string, override: FimFormat): Exclude<FimFormat, 'auto'> {
  if (override !== 'auto') { return override; }
  const m = model.toLowerCase();
  if (m.includes('granite')) { return 'granite'; }
  if (m.includes('qwen'))    { return 'qwen'; }
  if (m.includes('deepseek')) { return 'deepseek'; }
  if (m.includes('codellama') || m.includes('code-llama')) { return 'codellama'; }
  if (m.includes('starcoder')) { return 'starcoder'; }
  return 'chat';
}

interface FimPrompt { prompt: string; stop: string[]; }

function buildFimPrompt(format: Exclude<FimFormat, 'auto'>, prefix: string, suffix: string): FimPrompt {
  switch (format) {
    case 'granite':
      return {
        prompt: `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
        stop: ['<fim_pad>', '<|endoftext|>'],
      };
    case 'qwen':
      return {
        prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`,
        stop: ['<|fim_pad|>', '<|endoftext|>'],
      };
    case 'deepseek':
      // Uses Unicode fullwidth chars: ｜ = U+FF5C, ▁ = U+2581
      return {
        prompt: `<\uFF5Cfim\u2581begin\uFF5C>${prefix}<\uFF5Cfim\u2581hole\uFF5C>${suffix}<\uFF5Cfim\u2581end\uFF5C>`,
        stop: ['<\uFF5Ccompletion\uFF5C>'],
      };
    case 'codellama':
      return {
        prompt: `<PRE> ${prefix}<SUF>${suffix}<MID>`,
        stop: ['<EOT>'],
      };
    case 'starcoder':
      return {
        prompt: `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`,
        stop: ['<fim_pad>', '<|endoftext|>'],
      };
    default:
      return { prompt: '', stop: [] };
  }
}

async function fetchOllamaCompletion(
  prefix: string,
  suffix: string,
  ollamaUrl: string,
  ollamaModel: string,
  maxTokens: number,
  fimFormatOverride: FimFormat,
): Promise<string> {
  if (!ollamaModel) {
    fimLog.appendLine('[FIM] no model configured — select one in the LaTeX Preview sidebar');
    return '';
  }

  // Strip complete verbatim blocks before env analysis so their
  // contents don't poison the stack. Unclosed verbatim (cursor inside)
  // won't match and will correctly stay on the stack.
  const VERBATIM_ENVS = 'verbatim|Verbatim|lstlisting|minted|filecontents';
  const strippedPrefix = prefix.replace(
    new RegExp(`\\\\begin\\{(${VERBATIM_ENVS})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, 'g'),
    ''
  );

  // Build env stack for LaTeX context
  const envStack: string[] = [];
  for (const m of strippedPrefix.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (m[1] === 'begin') { envStack.push(m[2]); }
    else if (envStack.at(-1) === m[2]) { envStack.pop(); }
  }
  const currentEnv = envStack.at(-1) ?? null;

  // Keep only local context — the preamble and distant sections poison both FIM and chat models.
  const trimmedPrefix = strippedPrefix.slice(-400);
  // Trim suffix at the first paragraph boundary so structural LaTeX (\label, \section, math
  // environments) that follows the cursor doesn't leak in and confuse the model.
  const trimmedSuffix = suffix.split('\n\n')[0].slice(0, 200);

  const format = resolveFimFormat(ollamaModel, fimFormatOverride);

  fimLog.appendLine(`[FIM] model=${ollamaModel} format=${format} env=${currentEnv ?? 'none'}`);
  fimLog.appendLine(`[FIM] prefix[-60]=${JSON.stringify(trimmedPrefix.slice(-60))}`);
  fimLog.appendLine(`[FIM] suffix[+60]=${JSON.stringify(trimmedSuffix.slice(0, 60))}`);

  let res: Response;
  try {
    if (format === 'chat') {
      const MATH_ENVS = new Set(['equation', 'align', 'align*', 'math', 'gather', 'gather*', 'multline', 'multline*', 'displaymath']);
      const inMathBlockEnv = MATH_ENVS.has(currentEnv ?? '');
      const hasUnclosedBracketMath = /\\[\[(](?![^]*\\[\])])[^]*$/.test(prefix);
      const currentParagraph = prefix.split('\n\n').pop() ?? '';
      const unescapedDollars = (currentParagraph.replace(/\\\$/g, '').match(/\$/g) || []).length;
      const inMathMode = inMathBlockEnv || hasUnclosedBracketMath || (unescapedDollars % 2 === 1);

      // Use <CURSOR> marker — far clearer than PREFIX/SUFFIX/Completion framing for chat models.
      // Small models trained for chat ignore the suffix constraint when shown that format;
      // placing the marker inline forces them to generate exactly what belongs at that point.
      const systemLines = [
        'You are a LaTeX autocomplete engine.',
        'The text below contains the marker <CURSOR>. Output ONLY the LaTeX text to insert at <CURSOR>.',
        'Rules: one phrase, sentence, or command; no prose explanation; no markdown fences; never close an environment you did not open.',
      ];
      if (inMathMode) { systemLines.push('You are inside math mode.'); }
      if (currentEnv) { systemLines.push(`Innermost open environment: \\begin{${currentEnv}} — do NOT emit \\end{${currentEnv}}.`); }

      res = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages: [
            { role: 'system', content: systemLines.join('\n') },
            { role: 'user', content: `${trimmedPrefix}<CURSOR>${trimmedSuffix}` },
          ],
          stream: false,
          options: { temperature: 0.05, num_predict: maxTokens },
        }),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      const fim = buildFimPrompt(format, trimmedPrefix, trimmedSuffix);
      fimLog.appendLine(`[FIM] raw prompt=${JSON.stringify(fim.prompt.slice(0, 120))}…`);
      fimLog.appendLine(`[FIM] stop tokens=${JSON.stringify(fim.stop)}`);

      res = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: fim.prompt,
          raw: true,
          stream: false,
          options: { temperature: 0.05, num_predict: maxTokens, stop: fim.stop },
        }),
        signal: AbortSignal.timeout(15000),
      });
    }
  } catch (e) {
    fimLog.appendLine(`[FIM] fetch threw: ${e}`);
    return '';
  }

  fimLog.appendLine(`[FIM] HTTP ${res.status}`);
  if (!res.ok) {
    const body = await res.text();
    fimLog.appendLine(`[FIM] error body: ${body}`);
    return '';
  }

  const data = await res.json() as { response?: string; message?: { content?: string } };
  fimLog.appendLine(`[FIM] raw response keys: ${Object.keys(data).join(', ')}`);

  const rawPrediction = format === 'chat'
    ? (data.message?.content ?? '')
    : (data.response ?? '');

  fimLog.appendLine(`[FIM] rawPrediction=${JSON.stringify(rawPrediction)}`);

  let prediction = rawPrediction.trimEnd();

  // Strip markdown code fences that chat models sometimes emit.
  prediction = prediction.replace(/```[\w]*\n?/g, '').trimEnd();

  // Truncate at the first FIM special token the model may echo back.
  // Everything from the first <fim_*>, <|fim_*|>, <PRE>/<MID>/<EOT>, or deepseek
  // unicode variants onwards is garbage — the useful completion is before it.
  const FIM_TOKEN_RE = /<(?:\/?fim_\w+|PRE|SUF|MID|EOT)>|<[|｜](?:fim_\w+|endoftext)[|｜]>/;
  const specialIdx = prediction.search(FIM_TOKEN_RE);
  if (specialIdx === 0) {
    fimLog.appendLine('[FIM] → empty: prediction starts with FIM token');
    return '';
  }
  if (specialIdx > 0) {
    fimLog.appendLine(`[FIM] truncated at FIM token, was=${JSON.stringify(prediction)}`);
    prediction = prediction.slice(0, specialIdx).trimEnd();
  }

  if (!MULTILINE_ENVS.has(currentEnv ?? '')) {
    const before = prediction;
    // If the cursor is mid-line (prefix doesn't end with a newline), only a single-line
    // completion makes sense. Trim at the first \n to discard code/prose that spills over.
    const cursorMidLine = !trimmedPrefix.endsWith('\n') && trimmedPrefix !== '';
    prediction = cursorMidLine ? prediction.split('\n')[0] : prediction.split('\n\n')[0];
    if (prediction !== before) {
      fimLog.appendLine(`[FIM] trimmed at ${cursorMidLine ? '\\n' : '\\n\\n'}, was=${JSON.stringify(before)}`);
    }
  }

  // Reject block-level LaTeX commands when the cursor is mid-line — they are never valid there.
  const cursorMidLine = !trimmedPrefix.endsWith('\n') && trimmedPrefix !== '';
  if (cursorMidLine && /^\s*\\(?:section|chapter|subsection|subsubsection|paragraph|begin|end|label|vspace|hspace|newpage|clearpage|par)\b/.test(prediction)) {
    fimLog.appendLine('[FIM] → rejected: block command inserted mid-line');
    return '';
  }

  const trimmed = prediction.trim();
  if (!trimmed) {
    fimLog.appendLine('[FIM] → empty after trimming');
    return '';
  }

  fimLog.appendLine(`[FIM] → final prediction=${JSON.stringify(prediction)}`);
  return prediction;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function getGitHead(docUri: vscode.Uri): string | null {
  const filePath = docUri.fsPath;
  const dir = path.dirname(filePath);
  const file = path.basename(filePath);
  const result = spawnSync('git', ['show', `HEAD:./${file}`], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}
