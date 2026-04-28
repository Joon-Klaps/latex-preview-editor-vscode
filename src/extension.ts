import * as vscode from 'vscode';
import { LaTeXEditorProvider } from './LaTeXEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      LaTeXEditorProvider.viewType,
      new LaTeXEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function deactivate() {}
