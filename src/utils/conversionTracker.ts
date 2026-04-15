// Conversion tracking utility - provides structured logging for protocol transformations
import { logger } from './logger';

export interface ConversionRecord {
  requestId: string;
  direction: 'request' | 'response';
  step: 'start' | 'transform' | 'complete' | 'error';
  fromFormat: 'anthropic' | 'openai';
  toFormat: 'openai' | 'anthropic';
  details: Record<string, unknown>;
  warnings?: string[];
  error?: string;
}

/**
 * Create a conversion tracker bound to a specific request
 */
export function createConversionTracker(requestId: string) {
  const warnings: string[] = [];

  return {
    /**
     * Log request transformation start
     */
    trackRequestStart(
      model: string,
      messageCount: number,
      hasTools: boolean,
      toolFormat: string
    ): void {
      logger.debug('Protocol conversion: request start', {
        requestId,
        originalModel: model,
        messageCount,
        hasTools,
        toolFormat,
      });
    },

    /**
     * Log request transformation complete
     */
    trackRequestComplete(targetModel: string, messageCount: number, warnList?: string[]): void {
      logger.debug('Protocol conversion: request complete', {
        requestId,
        targetModel,
        messageCount,
        warnings: warnList?.length ? warnList : undefined,
      });
    },

    /**
     * Log response transformation start
     */
    trackResponseStart(originalModel: string): void {
      logger.debug('Protocol conversion: response start', {
        requestId,
        originalModel,
      });
    },

    /**
     * Log response transformation complete
     */
    trackResponseComplete(
      stopReason: string | null,
      hasToolCalls: boolean,
      warnList?: string[]
    ): void {
      logger.debug('Protocol conversion: response complete', {
        requestId,
        stopReason,
        hasToolCalls,
        warnings: warnList?.length ? warnList : undefined,
      });
    },

    /**
     * Log field mapping warning
     */
    warn(field: string, reason: string): void {
      const warning = `${field}: ${reason}`;
      warnings.push(warning);
      logger.warn(`Protocol mapping warning`, { requestId, field, reason });
    },

    /**
     * Log transformation error
     */
    error(step: string, error: Error): void {
      logger.error(`Protocol conversion error at ${step}`, error, { requestId });
    },

    /**
     * Log ID mapping for tool calls
     */
    trackIdMapping(originalId: string, mappedId: string, context: string): void {
      logger.debug('Tool ID mapped', { requestId, originalId, mappedId, context });
    },

    /**
     * Get all accumulated warnings
     */
    getWarnings(): string[] {
      return [...warnings];
    },
  };
}

/**
 * Log protocol transformation summary (typically at end of request)
 */
export function logTransformationSummary(
  requestId: string,
  metrics: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    messageCount: number;
    toolCallCount: number;
  }
): void {
  logger.info('Protocol transformation summary', {
    requestId,
    ...metrics,
  });
}
