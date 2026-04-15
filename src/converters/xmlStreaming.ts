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
      if (choice?.delta) {
        const deltaAny = choice.delta as any;
        const text = choice.delta?.content || deltaAny?.text || '';
        if (text) {
          logger.debug('=== OpenAI Stream Chunk ===', {
            chunkIndex: chunkCount,
            textPreview: text.substring(0, 200),
            hasToolCode: text.includes('<tool_code'),
          });
        }
      }

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

  logger.debug('=== Xml OpenAI Stream Chunk ===', {
    hasContent: !!choice.delta?.content,
    content: choice.delta?.content?.substring(0, 300),
    finishReason: choice.finish_reason,
    toolCalls: choice.delta?.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name,
      argsPreview: tc.function?.arguments?.substring(0, 100),
    })),
  });
  // Send message_start on first chunk
  if (!state.hasStarted) {
    logger.debug('Sending message_start');
    sendMessageStart(state, raw);
    state.hasStarted = true;
  }
  const deltaAny = choice.delta as any;
  const textDelta = choice.delta?.content || deltaAny?.text || '';

  if (!textDelta) {
    return;
  }

  state.buffer += textDelta;
  // Process buffer for complete tool calls
  processBuffer(state, raw);
}

function processBuffer(state: BufferedState, raw: any): void {
  const cleanBuffer = state.buffer.replace(THINK_BLOCK_PATTERN, '');

  const hasToolCode = cleanBuffer.includes('<tool_code');
  const toolMatch = cleanBuffer.match(TOOL_CODE_PATTERN);

  if (hasToolCode && !toolMatch) {
    logger.debug('Buffer has tool_code but no match', {
      bufferLength: cleanBuffer.length,
      preview: cleanBuffer.substring(0, 500),
    });
  }

  // Keep processing until no more complete tool calls are found
  let iteration = 0;
  while (true) {
    iteration++;
    // Safety limit to prevent infinite loops
    if (iteration > 100) {
      logger.warn('XML parsing iteration limit reached', {
        bufferLength: state.buffer.length,
        toolCallsEmitted: state.toolCallsEmitted,
      });
      break;
    }

    // Remove <think> blocks from consideration
    const cleanBuffer = state.buffer.replace(THINK_BLOCK_PATTERN, '');

    // Check for complete tool call
    const toolMatch = cleanBuffer.match(TOOL_CODE_PATTERN);

    if (!toolMatch) {
      // No complete tool call found, exit loop
      break;
    }

    // toolName may include quotes from the regex group, strip them
    let toolName = toolMatch[1];
    if (toolName.startsWith('"') && toolName.endsWith('"')) {
      toolName = toolName.slice(1, -1);
    } else if (toolName.startsWith("'") && toolName.endsWith("'")) {
      toolName = toolName.slice(1, -1);
    }

    const rawArgs = toolMatch[2];
    const fullMatch = toolMatch[0];
    const matchStart = cleanBuffer.indexOf(fullMatch);

    // Get text BEFORE the tool call
    const textBeforeTool = cleanBuffer.substring(0, matchStart);
    const cleanText = textBeforeTool.trim();

    // Emit text block if there's content
    if (cleanText.length > 0) {
      emitTextBlock(cleanText, state, raw);
    }

    // Clean and emit tool use block
    const cleanArgs = cleanToolArgs(rawArgs);
    emitToolUseBlock(toolName, cleanArgs, state, raw);

    // Update buffer: remove everything up to and including the tool call
    // Handle variations in closing tags (with or without leading whitespace)
    const endTagMatch = state.buffer.match(/\s*<\/tool_code\s*>/i);
    if (endTagMatch) {
      const originalMatchEnd = state.buffer.indexOf(endTagMatch[0]) + endTagMatch[0].length;
      state.buffer = state.buffer.substring(originalMatchEnd);
    }
  }
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
