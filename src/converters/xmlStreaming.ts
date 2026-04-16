// XML Streaming Converter: OpenAI text stream → Anthropic SSE with XML tool call detection
// Uses buffered approach: accumulates complete tool calls before emitting

import { FastifyReply } from 'fastify';
import { Stream } from 'openai/streaming';
import { OpenAIStreamChunk } from '../types/openai';
import { generateToolUseId } from './tools';
import { recordUsage } from '../utils/tokenUsage';
import { recordError } from '../utils/errorLog';
import { logger } from '../utils/logger';

interface BufferedState {
  messageId: string;
  model: string;
  responseModel: string;
  provider: string;
  contentBlockIndex: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  hasStarted: boolean;
  buffer: string; // Accumulates all text
  toolCallsEmitted: number; // Count of tool calls emitted
}

const THINK_BLOCK_PATTERN = /<think>[\s\S]*?<\/think>/g;
const TOOL_CODE_PATTERN =
  /\s*<tool_code\s+name\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)\s*>([\s\S]*?)<\/\s*tool_code\s*>/i;
const TOOL_CODE_SELF_CLOSING = /\s*<tool_code\s+name\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)\s*\/>/i;
const NESTED_TOOL_PATTERN = /<tool\s+name\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)">\s*/g;
const CLOSE_TOOL_PATTERN = /<\/tool>\s*/g;

/**
 * Transform OpenAI streaming response (with XML tool calls) to Anthropic SSE format.
 * Uses BUFFERED approach: waits for complete tool calls before emitting.
 */
export async function streamXmlOpenAIToAnthropic(
  openaiStream: Stream<OpenAIStreamChunk>,
  reply: FastifyReply,
  originalModel: string,
  provider: string = ''
): Promise<void> {
  const state: BufferedState = {
    messageId: `msg_${Date.now().toString(36)}`,
    model: originalModel,
    responseModel: '',
    provider,
    contentBlockIndex: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    hasStarted: false,
    buffer: '',
    toolCallsEmitted: 0,
  };

  const raw = reply.raw;

  // Set SSE headers
  raw.setHeader('Content-Type', 'text/event-stream');
  raw.setHeader('Cache-Control', 'no-cache');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Accel-Buffering', 'no');

  try {
    logger.debug('Starting XML stream processing');
    let chunkCount = 0;
    let lastLogTime = Date.now();
    for await (const chunk of openaiStream) {
      chunkCount++;
      const now = Date.now();
      if (now - lastLogTime > 5000) {
        logger.debug('Still receiving chunks', {
          count: chunkCount,
          sinceStart: now - lastLogTime,
        });
        lastLogTime = now;
      }

      const choice = chunk.choices[0];

      if (chunk.usage) {
        if (chunk.usage.prompt_tokens !== undefined) state.inputTokens = chunk.usage.prompt_tokens;
        if (chunk.usage.completion_tokens !== undefined)
          state.outputTokens = chunk.usage.completion_tokens;
        if (chunk.usage.prompt_tokens_details?.cached_tokens !== undefined) {
          state.cachedInputTokens = chunk.usage.prompt_tokens_details.cached_tokens;
        }
      }

      if (!choice) {
        logger.debug('No choice in chunk (stream ending)', { chunkIndex: chunkCount });
        flushRemainingContent(state, raw);
        finishStream(state, raw);
        return;
      }

      const text = choice.delta?.content || (choice.delta as any)?.text || '';

      logger.debug('=== Xml OpenAI Stream Chunk ===', {
        chunkIndex: chunkCount,
        hasContent: !!choice.delta?.content,
        content: text.substring(0, 300),
        finishReason: choice.finish_reason,
        hasToolCode: text.includes('<tool_code'),
        toolCalls: choice.delta?.tool_calls?.map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name,
          argsPreview: tc.function?.arguments?.substring(0, 100),
        })),
      });

      processChunk(chunk, state, raw);
    }
    logger.debug('Stream iteration complete', { totalChunks: chunkCount });
    // Final flush - emit any remaining text
    flushRemainingContent(state, raw);
    finishStream(state, raw);
    logger.debug('XML stream finished', {
      totalTokens: state.outputTokens,
      toolCallsEmitted: state.toolCallsEmitted,
    });
  } catch (error) {
    logger.error('XML stream error', error as Error);
    sendErrorEvent(error as Error, state, raw);
  }
}

function processChunk(chunk: OpenAIStreamChunk, state: BufferedState, raw: any): void {
  // Update usage if present
  if (chunk.usage) {
    if (chunk.usage.prompt_tokens !== undefined) {
      state.inputTokens = chunk.usage.prompt_tokens;
    }
    if (chunk.usage.completion_tokens !== undefined) {
      state.outputTokens = chunk.usage.completion_tokens;
    }
    if (chunk.usage.prompt_tokens_details?.cached_tokens !== undefined) {
      state.cachedInputTokens = chunk.usage.prompt_tokens_details.cached_tokens;
    }
  }

  // Capture response model
  if (chunk.model && !state.responseModel) {
    state.responseModel = chunk.model;
  }

  const choice = chunk.choices[0];
  if (!choice) {
    logger.debug('No choice in chunk', { chunk: JSON.stringify(chunk).substring(0, 200) });
    return;
  }

  // Send message_start on first chunk
  if (!state.hasStarted) {
    logger.debug('Sending message_start');
    sendMessageStart(state, raw);
    state.hasStarted = true;
  }

  const textDelta = choice.delta?.content || (choice.delta as any)?.text || '';
  if (!textDelta) {
    return;
  }

  state.buffer += textDelta;
  // Process buffer for complete tool calls
  processBuffer(state, raw);
}

function processBuffer(state: BufferedState, raw: any): void {
  let iteration = 0;
  while (true) {
    iteration++;
    if (iteration > 100) {
      logger.warn('XML parsing iteration limit reached', {
        bufferLength: state.buffer.length,
        toolCallsEmitted: state.toolCallsEmitted,
      });
      break;
    }

    const cleanBuffer = state.buffer.replace(THINK_BLOCK_PATTERN, '');

    if (handleConsecutiveToolCodeTags(cleanBuffer, state, raw)) {
      continue;
    }

    const selfClosingMatch = cleanBuffer.match(TOOL_CODE_SELF_CLOSING);
    const normalMatch = cleanBuffer.match(TOOL_CODE_PATTERN);

    let toolMatch: RegExpMatchArray | null = null;
    let isSelfClosing = false;

    if (selfClosingMatch && normalMatch) {
      if (cleanBuffer.indexOf(selfClosingMatch[0]) < cleanBuffer.indexOf(normalMatch[0])) {
        toolMatch = selfClosingMatch;
        isSelfClosing = true;
      } else {
        toolMatch = normalMatch;
      }
    } else if (selfClosingMatch) {
      toolMatch = selfClosingMatch;
      isSelfClosing = true;
    } else if (normalMatch) {
      toolMatch = normalMatch;
    }

    if (!toolMatch) break;

    let toolName = toolMatch[1];
    if (toolName.startsWith('"') && toolName.endsWith('"')) {
      toolName = toolName.slice(1, -1);
    } else if (toolName.startsWith("'") && toolName.endsWith("'")) {
      toolName = toolName.slice(1, -1);
    }

    let rawArgs = '';
    let fullMatch = '';

    if (isSelfClosing) {
      rawArgs = extractAttributes(toolMatch[0], toolName);
      fullMatch = toolMatch[0];
    } else {
      rawArgs = toolMatch[2];
      fullMatch = toolMatch[0];
    }

    const matchStart = cleanBuffer.indexOf(fullMatch);
    const textBeforeTool = cleanBuffer.substring(0, matchStart);
    const cleanText = textBeforeTool.trim();

    if (cleanText.length > 0) {
      emitTextBlock(cleanText, state, raw);
    }

    const cleanArgs = cleanToolArgs(rawArgs);
    emitToolUseBlock(toolName, cleanArgs, state, raw);

    const endTagMatch = isSelfClosing ? null : state.buffer.match(/\s*<\/tool_code\s*>/i);
    if (endTagMatch) {
      const originalMatchEnd = state.buffer.indexOf(endTagMatch[0]) + endTagMatch[0].length;
      state.buffer = state.buffer.substring(originalMatchEnd);
    } else if (isSelfClosing) {
      const matchEnd = state.buffer.indexOf(fullMatch) + fullMatch.length;
      state.buffer = state.buffer.substring(matchEnd);
    }
  }
}

function extractAttributes(tagString: string, toolName: string): string {
  const attrs: Record<string, string> = {};
  const attrRegex = /(\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s/>]+)/g;
  let match;
  while ((match = attrRegex.exec(tagString)) !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== 'name') {
      let cleanValue = value;
      if (cleanValue.startsWith('"') && cleanValue.endsWith('"')) {
        cleanValue = cleanValue.slice(1, -1);
      } else if (cleanValue.startsWith("'") && cleanValue.endsWith("'")) {
        cleanValue = cleanValue.slice(1, -1);
      }
      attrs[key] = cleanValue;
    }
  }
  return JSON.stringify(attrs);
}

function handleConsecutiveToolCodeTags(
  cleanBuffer: string,
  state: BufferedState,
  raw: any
): boolean {
  const toolCodeRegex = /<\s*tool_code/gi;
  const matches = cleanBuffer.match(toolCodeRegex);

  if (!matches || matches.length < 2) return false;

  const firstIdx = cleanBuffer.search(toolCodeRegex);
  const secondIdx = cleanBuffer.substring(firstIdx + matches[0].length).search(toolCodeRegex);

  if (secondIdx === -1) return false;

  const beforeFirst = cleanBuffer.substring(0, firstIdx);
  if (beforeFirst.trim().length > 0) {
    emitTextBlock(beforeFirst.trim(), state, raw);
  }

  const totalSkip = firstIdx + matches[0].length + secondIdx;
  state.buffer = state.buffer.substring(totalSkip);

  logger.debug('Handled consecutive tool_code with flexible spaces', {
    firstTag: matches[0],
    secondTag: matches[1],
  });
  return true;
}

function flushRemainingContent(state: BufferedState, raw: any): void {
  // Clean remaining buffer
  const cleanBuffer = state.buffer.replace(THINK_BLOCK_PATTERN, '').trim();

  // Get any remaining text
  const remainingText = cleanBuffer.trim();

  if (remainingText.length > 0) {
    emitTextBlock(remainingText, state, raw);
  }
}

function cleanToolArgs(args: string): string {
  let cleaned = args;

  // Remove nested <tool name="..."> tags
  cleaned = cleaned.replace(NESTED_TOOL_PATTERN, '');

  // Remove </tool> closing tags
  cleaned = cleaned.replace(CLOSE_TOOL_PATTERN, '');

  // Remove any leading ToolName\n pattern
  cleaned = cleaned.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*\n/, '');

  return cleaned.trim();
}

function emitTextBlock(text: string, state: BufferedState, raw: any): void {
  logger.debug('Emitting text block', {
    textPreview: text.substring(0, 100),
    blockIndex: state.contentBlockIndex,
  });

  // Start text block
  const startEvent = {
    type: 'content_block_start',
    index: state.contentBlockIndex,
    content_block: { type: 'text', text: '' },
  };
  sendSSE(startEvent, raw);

  // Send text delta
  const deltaEvent = {
    type: 'content_block_delta',
    index: state.contentBlockIndex,
    delta: { type: 'text_delta', text },
  };
  sendSSE(deltaEvent, raw);

  // Stop text block
  const stopEvent = {
    type: 'content_block_stop',
    index: state.contentBlockIndex,
  };
  sendSSE(stopEvent, raw);

  state.contentBlockIndex++;
}

function emitToolUseBlock(toolName: string, args: string, state: BufferedState, raw: any): void {
  const toolId = generateToolUseId();
  logger.debug('Emitting tool use block', {
    toolName,
    argsPreview: args.substring(0, 100),
    toolId,
    blockIndex: state.contentBlockIndex,
  });

  // Start tool_use block
  const startEvent = {
    type: 'content_block_start',
    index: state.contentBlockIndex,
    content_block: {
      type: 'tool_use',
      id: toolId,
      name: toolName,
      input: {},
    },
  };
  sendSSE(startEvent, raw);

  // Send complete input as single delta
  const deltaEvent = {
    type: 'content_block_delta',
    index: state.contentBlockIndex,
    delta: {
      type: 'input_json_delta',
      partial_json: args,
    },
  };
  sendSSE(deltaEvent, raw);

  // Stop tool_use block
  const stopEvent = {
    type: 'content_block_stop',
    index: state.contentBlockIndex,
  };
  sendSSE(stopEvent, raw);

  state.contentBlockIndex++;
  state.toolCallsEmitted++;
}

function sendMessageStart(state: BufferedState, raw: any): void {
  const event = {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: state.outputTokens,
        cache_read_input_tokens: state.cachedInputTokens,
      },
    },
  };
  sendSSE(event, raw);
}

function finishStream(state: BufferedState, raw: any): void {
  logger.debug('Finishing stream', {
    stopReason: state.toolCallsEmitted > 0 ? 'tool_use' : 'end_turn',
    outputTokens: state.outputTokens,
    toolCallsEmitted: state.toolCallsEmitted,
  });

  // Determine stop reason
  const stopReason = state.toolCallsEmitted > 0 ? 'tool_use' : 'end_turn';

  // Record token usage
  recordUsage({
    provider: state.provider,
    modelName: state.model,
    model: state.responseModel || undefined,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cachedInputTokens: state.cachedInputTokens || undefined,
    streaming: true,
  });

  // Send message_delta
  const deltaEvent = {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: state.outputTokens,
      cache_read_input_tokens: state.cachedInputTokens,
    },
  };
  sendSSE(deltaEvent, raw);

  // Send message_stop
  sendSSE({ type: 'message_stop' }, raw);

  raw.end();
}

function sendErrorEvent(error: Error, state: BufferedState, raw: any): void {
  // Record error to file
  recordError(error, {
    requestId: state.messageId,
    provider: state.provider,
    modelName: state.model,
    streaming: true,
  });

  const event = {
    type: 'error',
    error: {
      type: 'api_error',
      message: error.message,
    },
  };
  sendSSE(event, raw);
  raw.end();
}

function sendSSE(data: any, raw: any): void {
  logger.debug('=== AnthropicStreamEvent ===', {
    type: data.type,
    data: JSON.stringify(data).substring(0, 200),
  });
  raw.write(`event: ${data.type}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
