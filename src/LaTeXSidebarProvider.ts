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

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          webviewView.webview.postMessage({ type: 'init', settings: getSettings() });
          break;
        }
        case 'updateSetting': {
          const cfg = vscode.workspace.getConfiguration('latex-preview-editor');
          // Use Global so settings persist across workspaces
          await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
          break;
        }
      }
    });

    // Mirror external config changes (e.g. settings.json edits) back to the sidebar
    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('latex-preview-editor') && this._view) {
        this._view.webview.postMessage({ type: 'settingsChanged', settings: getSettings() });
      }
    });

    webviewView.onDidDispose(() => configSub.dispose());
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
      padding: 0;
      margin: 0;
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
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px 4px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      user-select: none;
    }
    .field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 12px;
      min-height: 26px;
      gap: 8px;
    }
    .field-label {
      flex: 1;
      font-size: 12px;
      color: var(--vscode-foreground);
      white-space: nowrap;
    }
    .field-control { flex-shrink: 0; }
    select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      font-family: inherit;
      font-size: 12px;
      padding: 2px 4px;
      outline: none;
      cursor: pointer;
      max-width: 130px;
    }
    select:focus { border-color: var(--vscode-focusBorder); }
    input[type="number"] {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      font-family: inherit;
      font-size: 12px;
      padding: 2px 6px;
      width: 70px;
      outline: none;
    }
    input[type="number"]:focus { border-color: var(--vscode-focusBorder); }
    .toggle {
      position: relative;
      display: inline-block;
      width: 32px;
      height: 18px;
      flex-shrink: 0;
    }
    .toggle input { display: none; }
    .toggle-slider {
      position: absolute;
      inset: 0;
      background: var(--vscode-button-secondaryBackground, #3c3c3c);
      border-radius: 9px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .toggle-slider::before {
      content: '';
      position: absolute;
      width: 12px;
      height: 12px;
      left: 3px;
      top: 3px;
      background: var(--vscode-button-secondaryForeground, #ccc);
      border-radius: 50%;
      transition: transform 0.15s;
    }
    .toggle input:checked + .toggle-slider {
      background: var(--vscode-button-background, #0078d4);
    }
    .toggle input:checked + .toggle-slider::before {
      transform: translateX(14px);
      background: var(--vscode-button-foreground, #fff);
    }
    .hint {
      padding: 0 12px 4px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .hint a {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: none;
    }
    .hint a:hover { text-decoration: underline; }
    .icon-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 4px;
      opacity: 0.7;
      font-size: 13px;
      line-height: 1;
    }
    .icon-btn:hover { opacity: 1; }
  </style>
</head>
<body>

  <!-- ── Split View ────────────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-header">Split View</div>

    <div class="field">
      <span class="field-label">Enable</span>
      <label class="toggle field-control">
        <input type="checkbox" id="split-view-enabled">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="hint">Opens a native VS Code editor alongside the WYSIWYG view. To disable: turn off the toggle, then close the native editor tab manually.</div>
  </div>

  <!-- ── Editor ────────────────────────────────────────────────────── -->
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

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let currentSettings = null;

  function applySettings(s) {
    currentSettings = s;
    document.getElementById('split-view-enabled').checked = s.splitViewEnabled;
    const ws = document.getElementById('content-width');
    if (ws) ws.value = s.contentWidth;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init' || msg.type === 'settingsChanged') {
      applySettings(msg.settings);
    }
  });

  function post(key, value) {
    vscode.postMessage({ type: 'updateSetting', key, value });
  }

  document.getElementById('split-view-enabled').addEventListener('change', (e) => {
    post('splitViewEnabled', e.target.checked);
  });
  document.getElementById('content-width').addEventListener('change', (e) => {
    post('contentWidth', e.target.value);
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
