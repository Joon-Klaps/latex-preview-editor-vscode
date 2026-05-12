import * as vscode from 'vscode';

export type FimFormat = 'auto' | 'granite' | 'qwen' | 'deepseek' | 'codellama' | 'starcoder' | 'chat';
export type CompletionBackend = 'claude' | 'ollama';

export interface LatexEditorSettings {
  contentWidth: string;
  completionBackend: CompletionBackend;
  claudeApiKey: string;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaMaxTokens: number;
  ollamaFimFormat: FimFormat;
}

export function getSettings(): LatexEditorSettings {
  const cfg = vscode.workspace.getConfiguration('latex-preview-editor');
  return {
    contentWidth: cfg.get<string>('contentWidth', '780px'),
    completionBackend: cfg.get<CompletionBackend>('completionBackend', 'ollama'),
    claudeApiKey: cfg.get<string>('claudeApiKey', ''),
    ollamaUrl: cfg.get<string>('ollamaUrl', 'http://localhost:11434'),
    ollamaModel: cfg.get<string>('ollamaModel', ''),
    ollamaMaxTokens: cfg.get<number>('ollamaMaxTokens', 150),
    ollamaFimFormat: cfg.get<FimFormat>('ollamaFimFormat', 'auto'),
  };
}
