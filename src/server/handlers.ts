// Proxy server request handlers
import { FastifyRequest, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { AnthropicMessageRequest } from '../types/anthropic';
import { AdapterConfig } from '../types/config';
import { convertRequestToOpenAI } from '../converters/request';
import { convertResponseToAnthropic, createErrorResponse } from '../converters/response';
import { streamOpenAIToAnthropic } from '../converters/streaming';
import { streamXmlOpenAIToAnthropic } from '../converters/xmlStreaming';
import { validateAnthropicRequest, formatValidationErrors } from '../utils/validation';
import { logger, RequestLogger } from '../utils/logger';
import { recordUsage } from '../utils/tokenUsage';
import { recordError } from '../utils/errorLog';

// Request ID counter for unique identification
let requestIdCounter = 0;

function generateRequestId(): string {
  requestIdCounter++;
  const timestamp = Date.now().toString(36);
  const counter = requestIdCounter.toString(36).padStart(4, '0');
  return `req_${timestamp}_${counter} `;
}

/**
 * Handle POST /v1/messages requests
 */
export function createMessagesHandler(config: AdapterConfig) {
  const openai = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const requestId = generateRequestId();
    const log = logger.withRequestId(requestId);
    const startTime = Date.now();

    // Add request ID to response headers for client tracing
    reply.header('X-Request-Id', requestId);

    log.debug('=== Request Info ===', {
      requestId,
      method: request.method,
      url: request.url,
      headers: {
        content_type: request.headers['content-type'],
        authorization: request.headers['authorization'] ? '[set]' : '[none]',
      },
      remote: request.headers['x-forwarded-for'] || request.headers['remote-address'] || 'unknown',
    });

    try {
      // Validate request before processing
      const validation = validateAnthropicRequest(request.body);
      if (!validation.valid) {
        const errorMessage = formatValidationErrors(validation.errors);
        log.warn('Invalid request', { errors: validation.errors });
        const errorResponse = createErrorResponse(new Error(errorMessage), 400);
        reply.code(400).send({ error: errorResponse.error });
        return;
      }

      const anthropicRequest = request.body as AnthropicMessageRequest;
      const targetModel = anthropicRequest.model;
      const isStreaming = anthropicRequest.stream ?? false;

      log.info(`→ ${targetModel} [sent]`);

      log.debug('=== AnthropicMessageRequest ===', {
        model: anthropicRequest.model,
        stream: anthropicRequest.stream,
        max_tokens: anthropicRequest.max_tokens,
        system:
          typeof anthropicRequest.system === 'string'
            ? anthropicRequest.system?.substring(0, 100)
            : '[array]',
        messages: anthropicRequest.messages?.map((m: any) => ({
          role: m.role,
          content:
            typeof m.content === 'string'
              ? m.content?.substring(0, 150)
              : Array.isArray(m.content)
                ? `[${m.content.length} content blocks]`
                : '[complex]',
        })),
        tools: anthropicRequest.tools?.map((t: any) => t.name),
      });

      log.debug('Request body', {
        full: JSON.stringify(anthropicRequest).substring(0, 800),
      });

      // Determine tool calling style from config
      const toolStyle = config.toolFormat || 'native';

      // Convert request to OpenAI format
      const openaiRequest = convertRequestToOpenAI(anthropicRequest, targetModel, toolStyle);

      log.debug('OpenAI request', {
        model: openaiRequest.model,
        max_tokens: openaiRequest.max_tokens,
        temperature: openaiRequest.temperature,
        messages: openaiRequest.messages?.map((m: any) => ({
          role: m.role,
          content:
            typeof m.content === 'string' ? m.content.substring(0, 200) : '[complex content]',
        })),
        tools: openaiRequest.tools?.map((t: any) => t.function?.name),
      });

      // Log tool calling mode when tools are present
      if (toolStyle === 'xml' && anthropicRequest.tools?.length) {
        log.info(`Using XML tool calling mode (${anthropicRequest.tools.length} tools)`);
      }

      if (isStreaming) {
        log.debug('=== OpenAI API Call ===', {
          url: `${config.baseUrl}/chat/completions`,
          model: openaiRequest.model,
          stream: true,
          toolFormat: toolStyle,
        });

        if (toolStyle === 'xml') {
          await handleXmlStreamingRequest(
            openai,
            openaiRequest,
            reply,
            anthropicRequest.model,
            config.baseUrl,
            log
          );
        } else {
          await handleStreamingRequest(
            openai,
            openaiRequest,
            reply,
            anthropicRequest.model,
            config.baseUrl,
            log
          );
        }
      } else {
        await handleNonStreamingRequest(
          openai,
          openaiRequest,
          reply,
          anthropicRequest.model,
          config.baseUrl,
          log
        );
      }

      log.info(`← ${targetModel} [received]`);

      const duration = Date.now() - startTime;
      log.debug('=== Response Summary ===', {
        requestId,
        duration_ms: duration,
        model: anthropicRequest.model,
        stream: isStreaming,
        stop_reason: (anthropicRequest as any)._stopReason,
      });
    } catch (error) {
      const body = request.body as any;
      const duration = Date.now() - startTime;
      log.error('=== Request Failed ===', error as Error, {
        requestId,
        duration_ms: duration,
        model: body?.model ?? 'unknown',
        provider: config.baseUrl,
        streaming: body?.stream ?? false,
        error_type: (error as Error).name,
        error_message: (error as Error).message?.substring(0, 200),
      });
      handleError(error as Error, reply, log, {
        requestId,
        provider: config.baseUrl,
        modelName: body?.model ?? 'unknown',
        streaming: body?.stream ?? false,
      });
    }
  };
}

/**
 * Handle non-streaming API request
 */
async function handleNonStreamingRequest(
  openai: OpenAI,
  openaiRequest: any,
  reply: FastifyReply,
  originalModel: string,
  provider: string,
  log: RequestLogger
): Promise<void> {
  log.debug('Making non-streaming request');

  const response = await openai.chat.completions.create({
    ...openaiRequest,
    stream: false,
  });

  log.debug('Response received', {
    finishReason: response.choices[0]?.finish_reason,
    usage: response.usage,
  });

  // Record token usage
  if (response.usage) {
    recordUsage({
      provider,
      modelName: originalModel,
      model: response.model,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens,
      streaming: false,
    });
  }

  const anthropicResponse = convertResponseToAnthropic(response as any, originalModel);
  log.debug('Response body', {
    id: anthropicResponse.id,
    content: anthropicResponse.content?.map((c: any) =>
      c.type === 'text' ? c.text?.substring(0, 300) : `[${c.type}]`
    ),
  });
  reply.send(anthropicResponse);
}

/**
 * Handle streaming API request
 */
async function handleStreamingRequest(
  openai: OpenAI,
  openaiRequest: any,
  reply: FastifyReply,
  originalModel: string,
  provider: string,
  log: RequestLogger
): Promise<void> {
  log.debug('Making streaming request');

  log.debug('=== OpenAI Stream Response Start ===', { model: originalModel, provider });

  const stream = await openai.chat.completions.create({
    ...openaiRequest,
    stream: true,
  } as OpenAI.ChatCompletionCreateParamsStreaming);

  await streamOpenAIToAnthropic(stream as any, reply, originalModel, provider);
  log.debug('Streaming completed');
}

/**
 * Handle XML streaming API request (for models without native tool calling)
 */
async function handleXmlStreamingRequest(
  openai: OpenAI,
  openaiRequest: any,
  reply: FastifyReply,
  originalModel: string,
  provider: string,
  log: RequestLogger
): Promise<void> {
  log.debug('Making XML streaming request (experimental)');

  const stream = await openai.chat.completions.create({
    ...openaiRequest,
    stream: true,
  } as OpenAI.ChatCompletionCreateParamsStreaming);

  await streamXmlOpenAIToAnthropic(stream as any, reply, originalModel, provider);
  log.debug('XML streaming completed');
  log.debug('Streaming summary', {
    provider,
    model: originalModel,
  });
}

/**
 * Handle errors and send appropriate response
 */
function handleError(
  error: Error,
  reply: FastifyReply,
  log: RequestLogger,
  context?: { requestId: string; provider: string; modelName: string; streaming: boolean }
): void {
  let statusCode = 500;

  // Try to extract status code from OpenAI error
  if ('status' in error) {
    statusCode = (error as any).status;
  }

  log.error('Request failed', error, { statusCode });

  // Record error to file if context is available
  if (context) {
    recordError(error, context);
  }

  const errorResponse = createErrorResponse(error, statusCode);
  reply.code(errorResponse.status).send({ error: errorResponse.error });
}
