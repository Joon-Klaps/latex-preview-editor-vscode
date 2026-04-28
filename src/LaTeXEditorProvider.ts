import * as vscode from 'vscode';

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
        vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'katex', 'dist'),
      ],
    };

    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

    // Track whether the current document change originated from the webview,
    // so we don't echo it back and cause an infinite loop.
    let suppressNextUpdate = false;

    const sendContent = () => {
      webviewPanel.webview.postMessage({
        type: 'update',
        text: document.getText(),
      });
    };

    // Messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          sendContent();
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

    webviewPanel.onDidDispose(() => changeSubscription.dispose());
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const katexCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.css')
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
  <link rel="stylesheet" href="${katexCssUri}" />
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      height: 100%; width: 100%;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
    }
    #editor {
      height: 100vh;
      font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
      font-size: var(--vscode-editor-font-size, 14px);
    }
    /* Make CodeMirror fill the container */
    .cm-editor { height: 100%; }
    .cm-scroller { overflow: auto; }
  </style>
</head>
<body>
  <div id="editor"></div>
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
