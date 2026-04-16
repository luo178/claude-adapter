import { AdapterConfig, ModelConfig } from '../types/config';

interface ResolvedModelResult {
  targetModel: string;
  resolvedFrom: 'default' | 'models';
  originalModel: string;
}

export function resolveTargetModel(
  config: AdapterConfig,
  requestModel: string
): ResolvedModelResult {
  const { models } = config;

  if (models.default) {
    const hasAnthropicModel = process.env.ANTHROPIC_MODEL;
    if (hasAnthropicModel) {
      return {
        targetModel: models.default,
        resolvedFrom: 'default',
        originalModel: requestModel,
      };
    }
  }

  const tierModel = resolveTierModel(models, requestModel);
  return {
    targetModel: tierModel,
    resolvedFrom: 'models',
    originalModel: requestModel,
  };
}

function resolveTierModel(models: ModelConfig, requestModel: string): string {
  const normalized = requestModel.toLowerCase();

  if (normalized.includes('opus')) {
    return models.opus;
  }
  if (normalized.includes('sonnet')) {
    return models.sonnet;
  }
  if (normalized.includes('haiku')) {
    return models.haiku;
  }

  if (
    normalized === models.opus.toLowerCase() ||
    normalized === models.sonnet.toLowerCase() ||
    normalized === models.haiku.toLowerCase()
  ) {
    return requestModel;
  }

  return models.sonnet;
}
