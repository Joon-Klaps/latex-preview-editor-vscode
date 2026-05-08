import * as vscode from 'vscode';

export type FimFormat = 'auto' | 'granite' | 'qwen' | 'deepseek' | 'codellama' | 'starcoder' | 'chat';

export interface LatexEditorSettings {
  contentWidth: string;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaMaxTokens: number;
  ollamaFimFormat: FimFormat;
}

export function getSettings(): LatexEditorSettings {
  const cfg = vscode.workspace.getConfiguration('latex-preview-editor');
  return {
    contentWidth: cfg.get<string>('contentWidth', '780px'),
    ollamaUrl: cfg.get<string>('ollamaUrl', 'http://localhost:11434'),
    ollamaModel: cfg.get<string>('ollamaModel', 'granit4;1:3b'),
    ollamaMaxTokens: cfg.get<number>('ollamaMaxTokens', 150),
    ollamaFimFormat: cfg.get<FimFormat>('ollamaFimFormat', 'auto'),
  };
}
