// Configuration types for claude-adapter

export interface CustomHeader {
  name: string;
  value?: string;
  generator?: string;
  includeForNonStreaming?: boolean;
  includeForStreaming?: boolean;
}

export interface AdapterConfig {
  baseUrl: string;
  apiKey: string;
  models: ModelConfig;
  toolFormat?: 'native' | 'xml';
  port?: number;
  logLevel?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  headers?: CustomHeader[];
}

export interface ModelConfig {
  opus: string;
  sonnet: string;
  haiku: string;
  default?: string;
}

export interface ClaudeSettings {
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface ClaudeJson {
  hasCompletedOnboarding?: boolean;
  [key: string]: unknown;
}
