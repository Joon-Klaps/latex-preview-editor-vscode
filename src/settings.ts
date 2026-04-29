import * as vscode from 'vscode';

export interface LatexEditorSettings {
  splitViewEnabled: boolean;
  contentWidth: string;      // CSS value: '780px' etc.
}

export function getSettings(): LatexEditorSettings {
  const cfg = vscode.workspace.getConfiguration('latex-preview-editor');
  return {
    splitViewEnabled: cfg.get<boolean>('splitViewEnabled', false),
    contentWidth:     cfg.get<string>('contentWidth', '780px'),
  };
}
