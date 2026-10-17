import {
  indexAcpConfigOptions,
  type AcpConfigIndex,
  type AcpConfigOption
} from './acp-session-config'

export type AcpSessionConfiguration = {
  configOptions?: AcpConfigOption[]
  models?: {
    currentModelId: string
    availableModels: { modelId: string; name: string; description?: string }[]
  }
}

export function indexAcpSessionConfiguration(session: AcpSessionConfiguration): AcpConfigIndex {
  if (
    session.configOptions?.some((option) => option.category === 'model' || option.id === 'model') ||
    !session.models
  ) {
    return indexAcpConfigOptions(session.configOptions ?? [])
  }
  const config = indexAcpConfigOptions([
    ...(session.configOptions ?? []),
    {
      id: 'model',
      category: 'model',
      currentValue: session.models.currentModelId,
      options: session.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description
      }))
    }
  ])
  config.legacyModels = true
  return config
}
