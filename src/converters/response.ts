// Response converter: OpenAI → Anthropic format
import {
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicUsage,
  AnthropicThinkingBlock,
} from '../types/anthropic';
import { OpenAIChatResponse, OpenAIToolCall, OpenAIResponsesResponse } from '../types/openai';
import { logger } from '../utils/logger';

/**
 * Validate OpenAI response before conversion
 */
function validateOpenAIResponse(response: OpenAIChatResponse): string[] {
  const warnings: string[] = [];

  if (!response.usage) {
    warnings.push('Missing usage data in response');
  }

  if (!response.choices || response.choices.length === 0) {
    warnings.push('No choices in response');
  }

  if (response.choices[0] && !response.choices[0].message) {
    warnings.push('Missing message in choice');
  }

  return warnings;
}

/**
 * Convert OpenAI Chat Completion response to Anthropic Messages format
 */
export function convertResponseToAnthropic(
  openaiResponse: OpenAIChatResponse,
  originalModelRequested: string
): AnthropicMessageResponse {
  const warnings = validateOpenAIResponse(openaiResponse);
  if (warnings.length > 0) {
    logger.warn('Response validation warnings', { warnings });
  }

  const choice = openaiResponse.choices[0];
  const message = choice.message;

  // Build content blocks
  const content: AnthropicContentBlock[] = [];

  // Add text content if present
  if (message.content) {
    content.push({
      type: 'text',
      text: message.content,
    });
  }

  // Add tool use blocks if present
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      content.push(convertToolCallToToolUse(toolCall));
    }
    logger.debug('Response converted with tool calls', {
      toolCallCount: message.tool_calls.length,
    });
  }

  let thinkingResult: AnthropicThinkingBlock | undefined;
  if ((message as any).thinking) {
    const thinkingData = (message as any).thinking;
    thinkingResult = {
      type: 'thinking',
      thinking: thinkingData.content || '',
      signature: thinkingData.signature,
    };
    content.push(thinkingResult);
    logger.debug('Response converted with thinking', {
      signature: thinkingData.signature,
    });
  }

  // Map finish reason
  const stopReason = mapFinishReason(choice.finish_reason);
  logger.debug('=== OpenAIChatResponse ===', {
    model: openaiResponse.model,
    finish_reason: choice.finish_reason,
    stop_reason: stopReason,
    usage: openaiResponse.usage,
    content_blocks: content.length,
    has_tool_calls: !!message.tool_calls?.length,
  });

  // Build usage - include all cache-related tokens
  const usage: AnthropicUsage = {
    input_tokens: openaiResponse.usage?.prompt_tokens ?? 0,
    output_tokens: openaiResponse.usage?.completion_tokens ?? 0,
  };

  // Map cache read tokens (from prompt caching)
  if (openaiResponse.usage?.prompt_tokens_details?.cached_tokens) {
    usage.cache_read_input_tokens = openaiResponse.usage.prompt_tokens_details.cached_tokens;
  }

  logger.debug('Response transformation complete', {
    model: originalModelRequested,
    stopReason,
    hasToolCalls: !!message.tool_calls?.length,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  });

  return {
    id: `msg_${openaiResponse.id}`,
    type: 'message',
    role: 'assistant',
    content,
    model: originalModelRequested,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
    thinking: thinkingResult,
  };
}

/**
 * Convert OpenAI tool call to Anthropic tool_use block
 */
function convertToolCallToToolUse(toolCall: OpenAIToolCall): AnthropicContentBlock {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(toolCall.function.arguments);
  } catch {
    input = { raw: toolCall.function.arguments };
  }

  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.function.name,
    input,
  };
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 */
function mapFinishReason(
  finishReason: string | null
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null {
  if (!finishReason) return null;

  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'end_turn'; // Map to end_turn as closest equivalent
    default:
      return 'end_turn';
  }
}

/**
 * Create an error response in Anthropic format
 */
export function createErrorResponse(
  error: Error,
  statusCode: number = 500
): { error: { type: string; message: string }; status: number } {
  return {
    error: {
      type: mapErrorType(statusCode),
      message: error.message,
    },
    status: statusCode,
  };
}

function mapErrorType(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 429:
      return 'rate_limit_error';
    case 500:
    default:
      return 'api_error';
  }
}

/**
 * Convert OpenAI Responses API response to Anthropic Messages format
 */
export function convertResponseFromResponses(
  openaiResponse: OpenAIResponsesResponse,
  originalModelRequested: string
): AnthropicMessageResponse {
  const content: AnthropicContentBlock[] = [];
  let thinkingResult: AnthropicThinkingBlock | undefined;
  let stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null = null;

  for (const output of openaiResponse.output) {
    if (output.type === 'message' || output.type === 'web_search_call') {
      if (output.type === 'web_search_call') {
        continue;
      }
      for (const contentBlock of output.content) {
        if (contentBlock.type === 'output_text') {
          const textContent: AnthropicContentBlock = { type: 'text', text: contentBlock.text };
          content.push(textContent);

          if (contentBlock.annotations && contentBlock.annotations.length > 0) {
            for (const annotation of contentBlock.annotations) {
              if (annotation.type === 'url_citation') {
                const urlAnnotation: AnthropicContentBlock = {
                  type: 'text',
                  text: `\n[Source: ${annotation.url}${annotation.title ? ` - ${annotation.title}` : ''}]\n`,
                };
                content.push(urlAnnotation);
              }
            }
          }
        }
      }
    } else if (output.type === 'reasoning') {
      const summaryTexts = output.summary.map((s) => s.text).join('\n');
      if (summaryTexts) {
        thinkingResult = {
          type: 'thinking',
          thinking: summaryTexts,
        };
        content.push(thinkingResult);
      }
    } else if (output.type === 'function_call') {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(output.arguments);
      } catch {
        input = { raw: output.arguments };
      }
      content.push({
        type: 'tool_use',
        id: output.id,
        name: output.name,
        input,
      });
      stopReason = 'tool_use';
    }
  }

  if (content.length === 0) {
    stopReason = 'end_turn';
  } else if (!stopReason) {
    stopReason = 'end_turn';
  }

  const usage: AnthropicUsage = {
    input_tokens: openaiResponse.usage?.prompt_tokens ?? 0,
    output_tokens: openaiResponse.usage?.completion_tokens ?? 0,
  };

  if (openaiResponse.usage?.prompt_tokens_details?.cached_tokens) {
    usage.cache_read_input_tokens = openaiResponse.usage.prompt_tokens_details.cached_tokens;
  }

  return {
    id: `msg_${openaiResponse.id}`,
    type: 'message',
    role: 'assistant',
    content,
    model: originalModelRequested,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
    thinking: thinkingResult,
  };
}
