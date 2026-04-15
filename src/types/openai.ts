// OpenAI Chat Completions API Types

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stream_options?: {
    include_usage: boolean;
  };
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  reasoning?: OpenAIReasoning;
}

export interface OpenAIReasoning {
  effort: 'low' | 'medium' | 'high';
  summary?: 'auto' | 'detailed';
}

export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

export interface OpenAISystemMessage {
  role: 'system';
  content: string;
}

export interface OpenAIUserMessage {
  role: 'user';
  content: string | OpenAIUserContentPart[];
}

export interface OpenAIAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  thinking?: {
    content: string;
    signature?: string;
  };
}

export interface OpenAIToolMessage {
  role: 'tool';
  content: string;
  tool_call_id: string;
}

export type OpenAIUserContentPart = OpenAITextContentPart | OpenAIImageContentPart;

export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

// Tool definitions
export interface OpenAITool {
  type: 'function';
  function: OpenAIFunction;
}

export interface OpenAIFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

// Tool calls in response
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// Chat completion response
export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
  system_fingerprint?: string;
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIAssistantMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

// Streaming types
export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: OpenAIUsage;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIStreamDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: OpenAIStreamToolCall[];
  reasoning?: {
    content?: string;
    signature?: string;
  };
}

export interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

// ============================================
// OpenAI Responses API Types
// ============================================

// Responses API Request
export interface OpenAIResponsesRequest {
  model: string;
  input: OpenAIResponseInputItem[];
  instructions?: string;
  tools?: OpenAIResponseTool[];
  store?: boolean;
  reasoning?: OpenAIReasoning;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export type OpenAIResponseInputItem = OpenAIResponseMessage | OpenAIResponseInputImage;

export interface OpenAIResponseMessage {
  type: 'message';
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIResponseInputContent[];
  tool_calls?: OpenAIResponseToolCall[];
  tool_call_id?: string;
}

export type OpenAIResponseInputContent = OpenAIResponseText | OpenAIResponseInputImage;

export interface OpenAIResponseInputImage {
  type: 'input_image';
  image_url: string;
}

export type OpenAIResponseContentPart = OpenAIResponseText | OpenAIResponseImage;

export interface OpenAIResponseText {
  type: 'output_text';
  text: string;
}

export interface OpenAIResponseImage {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

// Responses API Tools (different from Chat Completions)
export type OpenAIResponseTool =
  | OpenAIResponseFunction
  | { type: 'code_interpreter' }
  | { type: 'file_search' };

export interface OpenAIResponseFunction {
  type: 'function';
  name: string;
  description?: string;
  parameters?: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    strict?: boolean;
  };
}

export interface OpenAIResponseToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// Responses API Response
export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created: number;
  model: string;
  output: OpenAIResponseOutputItem[];
  usage: OpenAIUsage;
  store?: boolean;
}

export type OpenAIResponseOutputItem =
  | OpenAIResponseMessageOutput
  | OpenAIResponseFunctionCall
  | OpenAIResponseReasoning
  | OpenAIWebSearchCall;

export interface OpenAIWebSearchCall {
  type: 'web_search_call';
  id: string;
  status: 'in_progress' | 'completed';
}

export interface OpenAIResponseMessageOutput {
  type: 'message';
  role: 'assistant';
  content: OpenAIResponseTextContent[];
}

export interface OpenAIResponseTextContent {
  type: 'output_text';
  text: string;
  annotations?: OpenAIResponseAnnotation[];
}

export type OpenAIResponseAnnotation = OpenAIURLCitation | OpenAIFileCitation;

export interface OpenAIURLCitation {
  type: 'url_citation';
  start_index: number;
  end_index: number;
  url: string;
  title?: string;
}

export interface OpenAIFileCitation {
  type: 'file_citation';
  file_id: string;
  filename?: string;
  index: number;
}

export interface OpenAIResponseFunctionCall {
  type: 'function_call';
  id: string;
  name: string;
  arguments: string;
}

export interface OpenAIResponseReasoning {
  type: 'reasoning';
  id?: string;
  summary: OpenAIResponseReasoningSummary[];
}

export interface OpenAIResponseReasoningSummary {
  type: 'summary_text';
  text: string;
  speaker?: string;
}

// Responses API Streaming
export interface OpenAIResponsesStreamChunk {
  type: string;
  // Event types: response.created, response.output_item.added, response.content_block.delta,
  // response.content_block.stop, response.completed, response.incomplete
  [key: string]: unknown;
}
