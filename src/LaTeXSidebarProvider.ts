import * as vscode from 'vscode';
import { getSettings } from './settings';

export class LaTeXSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'latex-preview.settings';

  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    const checkOllama = async () => {
      if (!this._view) { return; }
      const { ollamaUrl } = getSettings();
      try {
        const res = await fetch(`${ollamaUrl}/api/tags`, {
          signal: AbortSignal.timeout(4000),
        });
        const data = await res.json() as { models?: { name: string }[] };
        const models = (data.models ?? []).map(m => m.name);
        this._view.webview.postMessage({ type: 'ollamaStatus', connected: true, models });
      } catch {
        this._view.webview.postMessage({ type: 'ollamaStatus', connected: false, models: [] });
      }
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          webviewView.webview.postMessage({ type: 'init', settings: getSettings() });
          checkOllama();
          break;
        }
        case 'checkOllama': {
          checkOllama();
          break;
        }
        case 'updateSetting': {
          const cfg = vscode.workspace.getConfiguration('latex-preview-editor');
          await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
          if (msg.key === 'ollamaUrl') { checkOllama(); }
          break;
        }
      }
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('latex-preview-editor') && this._view) {
        this._view.webview.postMessage({ type: 'settingsChanged', settings: getSettings() });
      }
    });

    webviewView.onDidDispose(() => { configSub.dispose(); });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      padding: 0; margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: transparent;
    }
    .section {
      padding: 4px 0 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
    }
    .section:last-child { border-bottom: none; }
    .section-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 12px 4px;
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      user-select: none;
    }
    .field {
      display: flex; align-items: center; justify-content: space-between;
      padding: 3px 12px; min-height: 26px; gap: 8px;
    }
    .field-label {
      flex: 1; font-size: 12px;
      color: var(--vscode-foreground); white-space: nowrap;
    }
    .field-control { flex-shrink: 0; }
    select, input[type="text"], input[type="number"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      font-family: inherit; font-size: 12px;
      padding: 2px 6px; outline: none; max-width: 150px;
    }
    select { cursor: pointer; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
    select:focus, input[type="text"]:focus, input[type="number"]:focus { border-color: var(--vscode-focusBorder); }
    .hint {
      padding: 0 12px 4px; font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .icon-btn {
      background: none; border: none;
      color: var(--vscode-foreground);
      cursor: pointer; padding: 2px 4px;
      opacity: 0.7; font-size: 13px; line-height: 1;
    }
    .icon-btn:hover { opacity: 1; }
    .status-row {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 12px; font-size: 12px;
    }
    .status-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--vscode-descriptionForeground, #888);
    }
    .status-dot.connected { background: var(--vscode-testing-iconPassed, #73c991); }
    .status-dot.checking { background: var(--vscode-editorWarning-foreground, #cca700); }
  </style>
</head>
<body>

  <!-- ── Editor ──────────────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-header">Editor</div>
    <div class="field">
      <span class="field-label">Default content width</span>
      <select id="content-width" class="field-control">
        <option value="680px">680px</option>
        <option value="780px">780px</option>
        <option value="960px">960px</option>
        <option value="1200px">1200px</option>
        <option value="100%">Full</option>
      </select>
    </div>
    <div class="hint">Applies on next editor open; toolbar overrides per session</div>
  </div>

  <!-- ── Ollama ──────────────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-header">
      Ollama
      <button class="icon-btn" id="ollama-refresh" title="Refresh connection">↻</button>
    </div>

    <div class="status-row">
      <span class="status-dot checking" id="ollama-dot"></span>
      <span id="ollama-status-text">Checking...</span>
    </div>

    <div class="field">
      <span class="field-label">URL</span>
      <input type="text" id="ollama-url" class="field-control" placeholder="http://localhost:11434" />
    </div>

    <div class="field">
      <span class="field-label">Model</span>
      <select id="ollama-model" class="field-control">
        <option value="">-- none --</option>
      </select>
    </div>

    <div class="field">
      <span class="field-label">FIM format</span>
      <select id="ollama-fim" class="field-control">
        <option value="auto">Auto</option>
        <option value="granite">Granite</option>
        <option value="qwen">Qwen</option>
        <option value="deepseek">DeepSeek</option>
        <option value="codellama">CodeLlama</option>
        <option value="starcoder">StarCoder</option>
        <option value="chat">Chat (fallback)</option>
      </select>
    </div>

    <div class="field">
      <span class="field-label">Max tokens</span>
      <input type="number" id="ollama-max-tokens" class="field-control" min="25" max="512" step="25" value="150" style="width:64px" />
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let currentSettings = null;

  function applySettings(s) {
    currentSettings = s;
    const cw = document.getElementById('content-width');
    if (cw) cw.value = s.contentWidth;
    const urlEl = document.getElementById('ollama-url');
    if (urlEl && urlEl !== document.activeElement) urlEl.value = s.ollamaUrl || 'http://localhost:11434';
    const fimEl = document.getElementById('ollama-fim');
    if (fimEl) fimEl.value = s.ollamaFimFormat || 'auto';
    const maxEl = document.getElementById('ollama-max-tokens');
    if (maxEl && maxEl !== document.activeElement) maxEl.value = String(s.ollamaMaxTokens ?? 150);
    const modelEl = document.getElementById('ollama-model');
    if (modelEl && s.ollamaModel) { modelEl.dataset.pending = s.ollamaModel; }
  }

  function applyOllamaStatus(connected, models) {
    const dot = document.getElementById('ollama-dot');
    const text = document.getElementById('ollama-status-text');
    dot.className = 'status-dot' + (connected ? ' connected' : '');
    text.textContent = connected
      ? (models.length ? 'Connected' : 'Connected — no models installed')
      : 'Not running';

    const sel = document.getElementById('ollama-model');
    const pending = sel.dataset.pending || currentSettings?.ollamaModel || '';
    sel.innerHTML = '';
    if (models.length === 0) {
      sel.innerHTML = '<option value="">-- none --</option>';
      return;
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if (m === pending) opt.selected = true;
      sel.appendChild(opt);
    }
    // If saved model not in list, default to first and persist
    if (!sel.value) {
      sel.selectedIndex = 0;
      vscode.postMessage({ type: 'updateSetting', key: 'ollamaModel', value: sel.value });
    }
    delete sel.dataset.pending;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init' || msg.type === 'settingsChanged') { applySettings(msg.settings); }
    if (msg.type === 'ollamaStatus') { applyOllamaStatus(msg.connected, msg.models || []); }
  });

  document.getElementById('content-width').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'updateSetting', key: 'contentWidth', value: e.target.value });
  });

  document.getElementById('ollama-url').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'updateSetting', key: 'ollamaUrl', value: e.target.value.trim() });
  });

  document.getElementById('ollama-model').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'updateSetting', key: 'ollamaModel', value: e.target.value });
  });

  document.getElementById('ollama-fim').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'updateSetting', key: 'ollamaFimFormat', value: e.target.value });
  });

  document.getElementById('ollama-max-tokens').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) { vscode.postMessage({ type: 'updateSetting', key: 'ollamaMaxTokens', value: v }); }
  });

  document.getElementById('ollama-refresh').addEventListener('click', () => {
    const dot = document.getElementById('ollama-dot');
    const text = document.getElementById('ollama-status-text');
    dot.className = 'status-dot checking';
    text.textContent = 'Checking...';
    vscode.postMessage({ type: 'checkOllama' });
  });

  vscode.postMessage({ type: 'ready' });
</script>
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
