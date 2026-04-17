import { CustomHeader } from '../types/config';

export function buildStaticHeaders(headers?: CustomHeader[]): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const header of headers) {
    if (header.value) {
      result[header.name] = header.value;
    }
  }

  return result;
}

export function buildSessionHeaders(
  headers?: CustomHeader[],
  isStreaming?: boolean
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};

  for (const header of headers) {
    if (header.value) {
      result[header.name] = header.value;
    }

    if (header.generator) {
      if (isStreaming !== undefined) {
        if (isStreaming && !header.includeForStreaming) {
          continue;
        }
        if (!isStreaming && !header.includeForNonStreaming) {
          continue;
        }
      }

      const generatorFn = new Function(`return ${header.generator}`)();
      result[header.name] = generatorFn();
    }
  }

  return result;
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
    if (!header.generator) {
      continue;
    }

    if (isStreaming && !header.includeForStreaming) {
      continue;
    }
    if (!isStreaming && !header.includeForNonStreaming) {
      continue;
    }

    const generatorFn = new Function(`return ${header.generator}`)();
    customHeaders[header.name] = generatorFn();
  }

  return customHeaders;
}
