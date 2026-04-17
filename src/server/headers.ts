import { AdapterConfig, CustomHeader } from '../types/config';

export function buildHeaders(
  headers?: CustomHeader[],
  sessionConfig?: { outputHeader?: string; sessionId?: string }
): Record<string, string> {
  const result: Record<string, string> = {};

  if (headers) {
    for (const header of headers) {
      if (header.generator) {
        const generatorFn = new Function(`return ${header.generator}`)();
        result[header.name] = generatorFn();
      } else if (header.value) {
        result[header.name] = header.value;
      }
    }
  }

  if (sessionConfig?.sessionId && sessionConfig?.outputHeader) {
    result[sessionConfig.outputHeader] = sessionConfig.sessionId;
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
  const inputHeader = sessionConfig?.inputHeader;
  if (inputHeader) {
    const clientSessionId = requestHeaders[inputHeader];
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

  return '';
}
