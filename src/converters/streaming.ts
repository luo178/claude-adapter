// Streaming converter: OpenAI SSE → Anthropic SSE
import { FastifyReply } from 'fastify';
import { Stream } from 'openai/streaming';
import { AnthropicMessageResponse, AnthropicUsage } from '../types/anthropic';
import { OpenAIStreamChunk, OpenAIStreamToolCall } from '../types/openai';
import { generateToolUseId } from './tools';
import { recordUsage } from '../utils/tokenUsage';
import { recordError } from '../utils/errorLog';
import { logger } from '../utils/logger';

// Tool ID generation for request isolation

function generateUniqueToolId(usedIds: Set<string>): string {
  let id: string;
  do {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    id = `call_${timestamp}_${random}`;
  } while (usedIds.has(id));

  usedIds.add(id);
  return id;
}

interface StreamingState {
  messageId: string;
  model: string;
  responseModel: string;
  provider: string;
  contentBlockIndex: number;
  currentToolCalls: Map<
    number,
    {
      id: string;
      name: string;
      arguments: string;
      blockIndex: number;
    }
  >;
  activeBlockIndices: Set<number>;
  closedBlockIndices: Set<number>;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  hasStarted: boolean;
  textContent: string;
  thinkingContent: string;
  thinkingSignature: string;
  isThinkingBlock: boolean;
  hasTextContentStarted: boolean;
  hasFinished: boolean;
  usedToolIds: Set<string>;
}

/**
 * Transform OpenAI streaming response to Anthropic SSE format
 */
export async function streamOpenAIToAnthropic(
  openaiStream: Stream<OpenAIStreamChunk>,
  reply: FastifyReply,
  originalModel: string,
  provider: string = ''
): Promise<void> {
  const state: StreamingState = {
    messageId: `msg_${Date.now().toString(36)}`,
    model: originalModel,
    responseModel: '',
    provider,
    contentBlockIndex: 0,
    currentToolCalls: new Map(),
    activeBlockIndices: new Set(),
    closedBlockIndices: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    hasStarted: false,
    textContent: '',
    thinkingContent: '',
    thinkingSignature: '',
    isThinkingBlock: false,
    hasTextContentStarted: false,
    hasFinished: false,
    usedToolIds: new Set<string>(),
  };

  logger.debug('Streaming conversion started', {
    model: originalModel,
    provider,
  });

  // Access the underlying Node.js response for SSE streaming
  const raw = reply.raw;

  // Set SSE headers
  raw.setHeader('Content-Type', 'text/event-stream');
  raw.setHeader('Cache-Control', 'no-cache');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Accel-Buffering', 'no');

  try {
    let chunkIndex = 0;
    for await (const chunk of openaiStream) {
      const chunkLog: any = {
        chunkIndex: chunkIndex++,
        id: chunk.id,
        model: chunk.model,
      };

      if (chunk.choices?.length) {
        chunkLog.choices = chunk.choices.map((c: any) => ({
          index: c.index,
          finish_reason: c.finish_reason,
          content: c.delta?.content || '',
          reasoning: c.delta?.reasoning?.content || '',
          toolCalls: c.delta?.tool_calls?.map((tc: any) => ({
            id: tc.id,
            type: tc.type,
            function: tc.function ? {
              name: tc.function.name,
              arguments: tc.function.arguments?.substring(0, 200),
            } : undefined,
          })),
        }));
      }

      logger.debug('=== Native OpenAI Stream Chunk ===', chunkLog);
      processChunk(chunk, state, raw);
    }

    // Send final events
    finishStream(state, raw);
  } catch (error) {
    sendErrorEvent(error as Error, state, raw);
  }
}

function processChunk(chunk: OpenAIStreamChunk, state: StreamingState, raw: any): void {
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

  // Capture response model from chunk
  if (chunk.model && !state.responseModel) {
    state.responseModel = chunk.model;
  }

  const choice = chunk.choices[0];
  if (!choice) return;

  if (state.hasFinished) {
    logger.debug('Ignoring chunk after stream finish', {
      finish_reason: choice.finish_reason,
      model: chunk.model,
    });
    return;
  }

  // Send message_start on first chunk
  if (!state.hasStarted) {
    sendMessageStart(state, raw);
    state.hasStarted = true;
  }

  const delta = choice.delta;

  // Handle thinking/reasoning content
  if (delta.reasoning) {
    if (delta.reasoning.content && !state.isThinkingBlock) {
      sendThinkingBlockStart(state.contentBlockIndex, '', raw);
      state.isThinkingBlock = true;
    }

    if (delta.reasoning.content) {
      state.thinkingContent += delta.reasoning.content;
      sendThinkingDelta(state.contentBlockIndex, delta.reasoning.content, raw);
    }

    if (delta.reasoning.signature) {
      state.thinkingSignature = delta.reasoning.signature;
      sendThinkingSignature(state.contentBlockIndex, delta.reasoning.signature, raw);
      if (!state.closedBlockIndices.has(state.contentBlockIndex)) {
        sendContentBlockStop(state.contentBlockIndex, raw);
        state.closedBlockIndices.add(state.contentBlockIndex);
      }
      state.contentBlockIndex++;
      state.isThinkingBlock = false;
      state.thinkingContent = '';
    }
  }

  // Handle text content
  if (delta.content) {
    // Close thinking block if open before starting text
    if (state.isThinkingBlock && !state.closedBlockIndices.has(state.contentBlockIndex)) {
      sendContentBlockStop(state.contentBlockIndex, raw);
      state.closedBlockIndices.add(state.contentBlockIndex);
      state.contentBlockIndex++;
      state.isThinkingBlock = false;
      state.thinkingContent = '';
    }

    // If this is the first text content, start a text block
    if (!state.hasTextContentStarted) {
      sendContentBlockStart(state.contentBlockIndex, 'text', '', raw);
      state.hasTextContentStarted = true;
    }

    state.textContent += delta.content;
    sendTextDelta(state.contentBlockIndex, delta.content, raw);
  }

  // Handle tool calls
  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      processToolCallDelta(toolCall, state, raw);
    }
  }

  // Handle finish reason
  if (choice.finish_reason) {
    logger.debug('=== Native Finish Reason ===', {
      finish_reason: choice.finish_reason,
      hasToolCalls: state.currentToolCalls.size > 0,
    });

    // Close any open thinking block
    if (state.isThinkingBlock && !state.closedBlockIndices.has(state.contentBlockIndex)) {
      sendContentBlockStop(state.contentBlockIndex, raw);
      state.closedBlockIndices.add(state.contentBlockIndex);
      state.contentBlockIndex++;
      state.isThinkingBlock = false;
    }

    // Close any open text block
    if (state.textContent !== '' && !state.closedBlockIndices.has(state.contentBlockIndex)) {
      sendContentBlockStop(state.contentBlockIndex, raw);
      state.closedBlockIndices.add(state.contentBlockIndex);
      state.contentBlockIndex++;
      state.textContent = '';
      state.hasTextContentStarted = false;
    }

    // Close any open tool calls using stored blockIndex
    for (const [index, toolCall] of state.currentToolCalls) {
      if (!state.closedBlockIndices.has(toolCall.blockIndex)) {
        sendContentBlockStop(toolCall.blockIndex, raw);
        state.closedBlockIndices.add(toolCall.blockIndex);
      }
    }

    state.hasFinished = true;
  }
}

function processToolCallDelta(
  toolCall: OpenAIStreamToolCall,
  state: StreamingState,
  raw: any
): void {
  const index = toolCall.index;

  // Check if this is a new tool call
  if (!state.currentToolCalls.has(index)) {
    // Close any previous text block first
    if (state.textContent !== '' && !state.closedBlockIndices.has(state.contentBlockIndex)) {
      sendContentBlockStop(state.contentBlockIndex, raw);
      state.closedBlockIndices.add(state.contentBlockIndex);
      state.contentBlockIndex++;
      state.textContent = '';
      state.hasTextContentStarted = false;
    }

    // IMPORTANT: Use the original OpenAI tool ID to maintain consistency
    // This ID must match when tool results are sent back
    // If OpenAI doesn't provide an ID, generate a guaranteed unique one
    let toolId: string;
    if (toolCall.id && !state.usedToolIds.has(toolCall.id)) {
      toolId = toolCall.id;
      state.usedToolIds.add(toolId);
    } else {
      toolId = generateUniqueToolId(state.usedToolIds);
    }

    const newToolCall = {
      id: toolId,
      name: toolCall.function?.name || '',
      arguments: '',
      blockIndex: state.contentBlockIndex + index,
    };
    state.currentToolCalls.set(index, newToolCall);

    const blockIndex = newToolCall.blockIndex;
    sendContentBlockStart(blockIndex, 'tool_use', newToolCall.name, raw, newToolCall.id);
  }

  // Update tool call data
  const currentCall = state.currentToolCalls.get(index)!;

  if (toolCall.function?.name) {
    currentCall.name = toolCall.function.name;
  }

  if (toolCall.function?.arguments) {
    currentCall.arguments += toolCall.function.arguments;
    const blockIndex = currentCall.blockIndex;
    logger.debug('=== Native Tool Call Delta ===', {
      index,
      toolId: currentCall.id,
      toolName: currentCall.name,
      partialArgs: toolCall.function.arguments?.substring(0, 100),
    });
    sendInputJsonDelta(blockIndex, toolCall.function.arguments, raw);
  }
}

function sendMessageStart(state: StreamingState, raw: any): void {
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

function sendContentBlockStart(
  index: number,
  type: 'text' | 'tool_use',
  textOrName: string,
  raw: any,
  id?: string
): void {
  let contentBlock: any;

  if (type === 'text') {
    contentBlock = { type: 'text', text: '' };
  } else {
    contentBlock = {
      type: 'tool_use',
      id: id || generateToolUseId(),
      name: textOrName,
      input: {},
    };
  }

  const event = {
    type: 'content_block_start',
    index,
    content_block: contentBlock,
  };
  sendSSE(event, raw);
}

function sendTextDelta(index: number, text: string, raw: any): void {
  const event = {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'text_delta',
      text,
    },
  };
  sendSSE(event, raw);
}

function sendThinkingBlockStart(index: number, thinking: string, raw: any): void {
  const event = {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'thinking',
      thinking: thinking,
    },
  };
  sendSSE(event, raw);
}

function sendThinkingDelta(index: number, thinking: string, raw: any): void {
  const event = {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'thinking_delta',
      thinking,
    },
  };
  sendSSE(event, raw);
}

function sendThinkingSignature(index: number, signature: string, raw: any): void {
  const event = {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'signature_delta',
      signature,
    },
  };
  sendSSE(event, raw);
}

function sendInputJsonDelta(index: number, partialJson: string, raw: any): void {
  const event = {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'input_json_delta',
      partial_json: partialJson,
    },
  };
  sendSSE(event, raw);
}

function sendContentBlockStop(index: number, raw: any): void {
  const event = {
    type: 'content_block_stop',
    index,
  };
  sendSSE(event, raw);
}

function finishStream(state: StreamingState, raw: any): void {
  // Determine stop reason
  const hasToolCalls = state.currentToolCalls.size > 0;
  const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';

  logger.debug('Streaming conversion complete', {
    messageId: state.messageId,
    stopReason,
    toolCallCount: state.currentToolCalls.size,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
  });

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

function sendErrorEvent(error: Error, state: StreamingState, raw: any): void {
  logger.error('Streaming conversion error', error, {
    messageId: state.messageId,
    provider: state.provider,
    model: state.model,
  });

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

// ============================================
// Responses API Streaming Handler
// ============================================

interface ResponsesStreamingState {
  messageId: string;
  model: string;
  responseModel: string;
  provider: string;
  nextContentBlockIndex: number;
  activeBlock: {
    index: number;
    type: 'text' | 'thinking' | 'tool_use';
    toolCallId?: string;
    toolCallName?: string;
  } | null;
  currentToolCallArgs: string;
  hasMessageDelta: boolean;
}

export async function streamResponsesToAnthropic(
  responseStream: any,
  reply: FastifyReply,
  originalModel: string,
  provider: string = ''
): Promise<void> {
  const state: ResponsesStreamingState = {
    messageId: `msg_${Date.now().toString(36)}`,
    model: originalModel,
    responseModel: '',
    provider,
    nextContentBlockIndex: 0,
    activeBlock: null,
    currentToolCallArgs: '',
    hasMessageDelta: false,
  };

  logger.debug('Responses streaming started', { model: originalModel, provider });

  const raw = reply.raw;
  raw.setHeader('Content-Type', 'text/event-stream');
  raw.setHeader('Cache-Control', 'no-cache');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Accel-Buffering', 'no');

  responsesSendMessageStart(state, raw);

  try {
    for await (const event of responseStream) {
      responsesProcessEvent(event, state, raw);
    }
    responsesFinishStream(state, raw);
  } catch (error) {
    responsesSendError(error as Error, state, raw);
  }
}

function responsesSendMessageStart(state: ResponsesStreamingState, raw: any): void {
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
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
  sendSSE(event, raw);
}

function responsesSendContentBlockStart(
  state: ResponsesStreamingState,
  blockType: 'text' | 'thinking' | 'tool_use',
  raw: any
): void {
  const contentBlock: any =
    blockType === 'thinking'
      ? { type: 'thinking', thinking: '' }
      : blockType === 'tool_use'
        ? {
            type: 'tool_use',
            id: state.activeBlock?.toolCallId || generateToolUseId(),
            name: state.activeBlock?.toolCallName || '',
            input: {},
          }
        : { type: 'text', text: '' };

  const event = {
    type: 'content_block_start',
    index: state.activeBlock?.index ?? state.nextContentBlockIndex,
    content_block: contentBlock,
  };
  sendSSE(event, raw);
}

function responsesSendContentBlockDelta(index: number, text: string, raw: any): void {
  const event = {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'text_delta',
      text,
    },
  };
  sendSSE(event, raw);
}

function responsesProcessEvent(event: any, state: ResponsesStreamingState, raw: any): void {
  const eventType = event.type;

  switch (eventType) {
    case 'response.created':
      state.responseModel = event.response?.model || '';
      break;

    case 'response.output_item.added':
      responsesHandleOutputItemAdded(event, state, raw);
      break;

    case 'response.content_block.delta':
      responsesHandleContentBlockDelta(event, state, raw);
      break;

    case 'response.content_block.stop':
      responsesHandleContentBlockStop(event, state, raw);
      break;

    case 'response.completed': {
      responsesCloseActiveBlock(state, raw);
      if (state.hasMessageDelta) break;

      const usage = event.response?.usage || {};
      const messageEvent = {
        type: 'message_delta',
        delta: {
          stop_reason: event.stop_reason || 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: usage.output_tokens || usage.completion_tokens || 0,
        },
      };
      sendSSE(messageEvent, raw);
      state.hasMessageDelta = true;
      break;
    }

    case 'response.incomplete': {
      responsesCloseActiveBlock(state, raw);
      if (state.hasMessageDelta) break;

      const usage = event.response?.usage || {};
      const incompleteEvent = {
        type: 'message_delta',
        delta: {
          stop_reason: 'max_tokens',
          stop_sequence: null,
        },
        usage: {
          output_tokens: usage.output_tokens || usage.completion_tokens || 0,
        },
      };
      sendSSE(incompleteEvent, raw);
      state.hasMessageDelta = true;
      break;
    }
  }
}

function responsesHandleOutputItemAdded(
  event: any,
  state: ResponsesStreamingState,
  raw: any
): void {
  const item = event.item;
  if (!item) return;

  if (item.type === 'message') {
    responsesCloseActiveBlock(state, raw);
    state.nextContentBlockIndex = 0;
    state.activeBlock = null;
    state.currentToolCallArgs = '';
  } else if (item.type === 'reasoning') {
    responsesStartBlock(state, 'thinking', raw);
  } else if (item.type === 'function_call') {
    responsesStartBlock(state, 'tool_use', raw, {
      toolCallId: item.id || generateToolUseId(),
      toolCallName: item.name || '',
    });
    state.currentToolCallArgs = '';
  }
}

function responsesHandleContentBlockDelta(
  event: any,
  state: ResponsesStreamingState,
  raw: any
): void {
  const delta = event.delta;
  if (!delta) return;

  if (delta.type === 'output_text') {
    const text = delta.text || '';
    if (state.activeBlock?.type === 'thinking') {
      responsesSendThinkingDelta(state.activeBlock.index, text, raw);
    } else {
      const blockIndex = responsesEnsureTextBlock(state, raw);
      responsesSendContentBlockDelta(blockIndex, text, raw);
    }
  } else if (delta.type === 'reasoning_summary') {
    const summary = delta.summary || '';
    if (state.activeBlock?.type !== 'thinking') {
      responsesStartBlock(state, 'thinking', raw);
    }
    responsesSendThinkingDelta(state.activeBlock!.index, summary, raw);
  } else if (delta.type === 'function_call_arguments') {
    const args = delta.arguments || '';
    if (state.activeBlock?.type !== 'tool_use') {
      responsesStartBlock(state, 'tool_use', raw);
    }
    state.currentToolCallArgs += args;
    sendToolCallDelta(state.activeBlock!.index, state.currentToolCallArgs, raw);
  }
}

function responsesHandleContentBlockStop(
  event: any,
  state: ResponsesStreamingState,
  raw: any
): void {
  const index = event.index ?? state.activeBlock?.index;

  if (index === undefined) {
    logger.debug('Ignoring responses content_block.stop without active block');
    return;
  }

  responsesCloseActiveBlock(state, raw, index);
}

function responsesFinishStream(state: ResponsesStreamingState, raw: any): void {
  responsesCloseActiveBlock(state, raw);
  const event = {
    type: 'message_stop',
  };
  sendSSE(event, raw);
  raw.end();
}

function responsesSendError(error: Error, state: ResponsesStreamingState, raw: any): void {
  logger.error('Responses streaming error', error);
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

function responsesStartBlock(
  state: ResponsesStreamingState,
  blockType: 'text' | 'thinking' | 'tool_use',
  raw: any,
  options?: { toolCallId?: string; toolCallName?: string }
): number {
  responsesCloseActiveBlock(state, raw);

  state.activeBlock = {
    index: state.nextContentBlockIndex,
    type: blockType,
    toolCallId: options?.toolCallId,
    toolCallName: options?.toolCallName,
  };
  responsesSendContentBlockStart(state, blockType, raw);
  return state.activeBlock.index;
}

function responsesEnsureTextBlock(state: ResponsesStreamingState, raw: any): number {
  if (state.activeBlock?.type === 'text') {
    return state.activeBlock.index;
  }

  return responsesStartBlock(state, 'text', raw);
}

function responsesCloseActiveBlock(
  state: ResponsesStreamingState,
  raw: any,
  expectedIndex?: number
): void {
  if (!state.activeBlock) {
    return;
  }

  if (expectedIndex !== undefined && state.activeBlock.index !== expectedIndex) {
    logger.debug('Ignoring responses block stop for non-active index', {
      expectedIndex,
      activeIndex: state.activeBlock.index,
      activeType: state.activeBlock.type,
    });
    return;
  }

  sendResponsesContentBlockStop(state.activeBlock.index, raw);
  state.activeBlock = null;
  state.currentToolCallArgs = '';
  state.nextContentBlockIndex++;
}

function responsesSendThinkingDelta(index: number, text: string, raw: any): void {
  const event = {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'thinking_delta',
      thinking: text,
    },
  };
  sendSSE(event, raw);
}

function sendResponsesContentBlockStop(index: number, raw: any): void {
  const event = {
    type: 'content_block_stop',
    index,
  };
  sendSSE(event, raw);
}

function sendToolCallDelta(index: number, partialArgs: string, raw: any): void {
  const event = {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'input_json_delta',
      partial_json: partialArgs,
    },
  };
  sendSSE(event, raw);
}
