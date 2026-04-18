import OpenAI from 'openai';
import { logger } from '../utils/logger.js';

export type ToolFormat = 'auto' | 'native' | 'xml';

export interface ProviderCapability {
  baseUrl: string;
  model: string;
  toolFormat: ToolFormat;
  testedAt: number;
}

const capabilityCache = new Map<string, ProviderCapability>();

const TOOL_CALL_ERROR_CODES = [
  'invalid_tool_call',
  'tool_call_error',
  'invalid_parameter',
  'invalid_json',
];

const TOOL_CALL_ERROR_MESSAGES = [
  'tool',
  'function',
  'call',
  'invalid',
  'parameter',
];

function isToolCallError(error: any): boolean {
  if (!error) return false;
  
  const message = error.message?.toLowerCase() || '';
  const type = error.type?.toLowerCase() || '';
  const code = error.code?.toLowerCase() || '';
  
  if (TOOL_CALL_ERROR_CODES.some(c => code.includes(c))) return true;
  if (TOOL_CALL_ERROR_MESSAGES.some(m => message.includes(m))) return true;
  
  return false;
}

function getCacheKey(baseUrl: string, model: string): string {
  return `${baseUrl}:${model}`;
}

export class ToolFormatDetector {
  private baseUrl: string;
  private openai: OpenAI;
  
  constructor(baseUrl: string, openai: OpenAI) {
    this.baseUrl = baseUrl;
    this.openai = openai;
  }
  
  getToolFormat(model: string, configuredFormat?: ToolFormat): 'native' | 'xml' {
    if (configuredFormat === 'native' || configuredFormat === 'xml') {
      return configuredFormat;
    }
    
    const cached = capabilityCache.get(getCacheKey(this.baseUrl, model));
    if (cached) {
      logger.debug('Using cached tool format', { 
        baseUrl: this.baseUrl, 
        model, 
        format: cached.toolFormat 
      });
      return cached.toolFormat === 'auto' ? 'native' : cached.toolFormat;
    }
    
    return 'native';
  }
  
  async detectToolFormat(
    model: string,
    request: any,
    configuredFormat?: ToolFormat
  ): Promise<ToolFormat> {
    if (configuredFormat) {
      logger.debug('Using configured tool format', { format: configuredFormat });
      return configuredFormat;
    }
    
    const cacheKey = getCacheKey(this.baseUrl, model);
    const cached = capabilityCache.get(cacheKey);
    if (cached) {
      return cached.toolFormat;
    }
    
    logger.debug('Detecting tool format for provider', { baseUrl: this.baseUrl, model });
    
    try {
      const testRequest: any = {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      };
      
      if (request?.tools?.length) {
        testRequest.tools = request.tools;
      }
      
      await this.openai.chat.completions.create(testRequest as any);
      
      const capability: ProviderCapability = {
        baseUrl: this.baseUrl,
        model,
        toolFormat: 'native',
        testedAt: Date.now(),
      };
      
      capabilityCache.set(cacheKey, capability);
      logger.info('Provider supports native tool format', { baseUrl: this.baseUrl, model });
      return 'native';
    } catch (error: any) {
      if (isToolCallError(error)) {
        const capability: ProviderCapability = {
          baseUrl: this.baseUrl,
          model,
          toolFormat: 'xml',
          testedAt: Date.now(),
        };
        
        capabilityCache.set(cacheKey, capability);
        logger.info('Provider requires XML tool format', { 
          baseUrl: this.baseUrl, 
          model,
          error: error.message 
        });
        return 'xml';
      }
      
      logger.warn('Tool format detection failed, using native', { error: error.message });
      return 'native';
    }
  }
  
  async createWithFallback(
    params: any,
    toolFormat: ToolFormat,
    isStreaming: boolean
  ): Promise<any> {
    try {
      const requestParams = {
        ...params,
        ...(isStreaming ? { stream: true, stream_options: { include_usage: true } } : {}),
      };
      
      const cacheKey = getCacheKey(this.baseUrl, params.model);
      const cached = capabilityCache.get(cacheKey);
      
      if (!cached) {
        const detected = await this.detectToolFormat(params.model, { tools: params.tools });
        if (detected !== toolFormat) {
          logger.info('Auto-detected different tool format, retrying', { 
            expected: toolFormat, 
            actual: detected 
          });
          return this.createWithFallback(params, detected, isStreaming);
        }
      }
      
      return await this.openai.chat.completions.create(requestParams as any);
    } catch (error: any) {
      if (isToolCallError(error) && toolFormat === 'native') {
        logger.warn('Native tool call failed, retrying with XML format', { 
          error: error.message 
        });
        
        const capability: ProviderCapability = {
          baseUrl: this.baseUrl,
          model: params.model,
          toolFormat: 'xml',
          testedAt: Date.now(),
        };
        capabilityCache.set(getCacheKey(this.baseUrl, params.model), capability);
        
        const newParams = {
          ...params,
          tools: this.convertToolsToXml(params.tools),
          ...(isStreaming ? { stream: true, stream_options: { include_usage: true } } : {}),
        };
        
        return await this.openai.chat.completions.create(newParams as any);
      }
      
      throw error;
    }
  }
  
  private convertToolsToXml(tools: any[]): any[] {
    if (!tools?.length) return tools;
    
    return tools.map((tool: any) => {
      if (tool.type !== 'function') return tool;
      
      return {
        type: 'function',
        function: {
          name: tool.function?.name,
          description: tool.function?.description,
          parameters: JSON.stringify(tool.function?.parameters || {}),
        },
      };
    });
  }
  
  clearCache(): void {
    capabilityCache.clear();
    logger.debug('Tool format capability cache cleared');
  }
}

export function createToolFormatDetector(
  baseUrl: string, 
  apiKey: string
): ToolFormatDetector {
  const openai = new OpenAI({
    baseURL: baseUrl,
    apiKey,
  });
  return new ToolFormatDetector(baseUrl, openai);
}
