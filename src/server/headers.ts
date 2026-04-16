import { CustomHeader } from '../types/config';

export function buildClientHeaders(headers?: CustomHeader[]): Record<string, string> {
  if (!headers) {
    return {};
  }

  const clientHeaders: Record<string, string> = {};

  for (const header of headers) {
    if (header.value) {
      clientHeaders[header.name] = header.value;
    }
  }

  return clientHeaders;
}

export function buildCustomHeaders(
  headers?: CustomHeader[],
  isStreaming?: boolean
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const customHeaders: Record<string, string> = {};

  for (const header of headers) {
    if (header.value && !header.generator) {
      continue;
    }

    if (header.generator) {
      if (isStreaming && !header.includeForStreaming) {
        continue;
      }
      if (!isStreaming && !header.includeForNonStreaming) {
        continue;
      }
      const generatorFn = new Function(`return ${header.generator}`)();
      customHeaders[header.name] = generatorFn();
    }
  }

  return customHeaders;
}
