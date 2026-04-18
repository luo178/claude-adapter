import { AdapterConfig, CustomHeader } from '../types/config';
import { randomUUID } from 'crypto';

const HEADER_GENERATORS: Record<string, () => string> = {
  uuid: () => randomUUID(),
  randomUUID: () => randomUUID(),
  timestamp: () => Date.now().toString(),
  unix: () => Date.now().toString(),
  isoTimestamp: () => new Date().toISOString(),
};

function resolveHeaderGenerator(generator: string): (() => string) | null {
  const normalized = generator.trim();
  if (!normalized) {
    return null;
  }

  if (normalized in HEADER_GENERATORS) {
    return HEADER_GENERATORS[normalized];
  }

  const functionCallMatch = normalized.match(/^([A-Za-z_][A-Za-z0-9_-]*)\(\)$/);
  if (functionCallMatch) {
    return HEADER_GENERATORS[functionCallMatch[1]] || null;
  }

  return null;
}

export function buildHeaders(
  headers?: CustomHeader[],
  sessionConfig?: { outputHeader?: string; sessionId?: string }
): Record<string, string> {
  const result: Record<string, string> = {};
  const outputHeader = sessionConfig?.outputHeader;

  if (headers) {
    for (const header of headers) {
      if (outputHeader && header.name === outputHeader) {
        continue;
      }
      if (header.generator) {
        const generatorFn = resolveHeaderGenerator(header.generator);
        if (!generatorFn) {
          throw new Error(
            `Unsupported header generator "${header.generator}" for header "${header.name}". ` +
              `Supported generators: ${Object.keys(HEADER_GENERATORS).join(', ')}`
          );
        }
        result[header.name] = generatorFn();
      } else if (header.value) {
        result[header.name] = header.value;
      }
    }
  }

  if (sessionConfig?.sessionId && outputHeader) {
    result[outputHeader] = sessionConfig.sessionId;
  }

  return result;
}

export function buildDefaultHeaders(config: AdapterConfig): Record<string, string> {
  return buildHeaders(config.headers);
}

export function getSessionId(
  requestHeaders: Record<string, string>,
  sessionConfig?: { inputHeader?: string }
): string {
  if (sessionConfig?.inputHeader) {
    const clientSessionId = requestHeaders[sessionConfig.inputHeader];
    if (clientSessionId && typeof clientSessionId === 'string' && clientSessionId.length > 0) {
      return clientSessionId;
    }
  }

  const possibleSessionHeaders = [
    'x-claude-code-session-id',
    'x-opencode-session',
    'x-session-id',
    'x-session',
  ];
  for (const headerName of possibleSessionHeaders) {
    const value = requestHeaders[headerName];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return randomUUID();
}
