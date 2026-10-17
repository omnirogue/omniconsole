export type LLMRole = 'system' | 'user' | 'assistant' | 'tool'

export type LLMJsonValue =
  | string
  | number
  | boolean
  | null
  | LLMJsonValue[]
  | { [key: string]: LLMJsonValue }

export type LLMContentPart = {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, LLMJsonValue> }
  functionResponse?: { name: string; response: Record<string, LLMJsonValue> }
}

export type LLMMessage = {
  role: LLMRole
  content: string
  name?: string // Required for tool responses in some APIs
  tool_calls?: LLMToolCall[]
  images?: string[] // Optional base64 images
  metadata?: {
    internal?: boolean
    reviewTaskId?: string
    [key: string]: LLMJsonValue | undefined
  }
}

export type LLMToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
  args?: Record<string, LLMJsonValue>
}

export type LLMParameterSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  properties?: Record<string, LLMParameterSchema>
  required?: string[]
  items?: LLMParameterSchema
  enum?: LLMJsonValue[]
  additionalProperties?: boolean | LLMParameterSchema
}

export type LLMFunctionDefinition = {
  name: string
  description: string
  parameters: LLMParameterSchema
}

export type LLMToolDefinition = {
  type: 'function'
  function: LLMFunctionDefinition
}

export type LLMToolGroup = {
  functionDeclarations: LLMFunctionDefinition[]
}

export type LLMConfig = {
  apiKey?: string
  baseUrl?: string
  model: string
}

export type LLMRequestDetails = {
  contents: LLMMessage[]
  systemInstruction?: string
  tools?: (LLMToolDefinition | LLMToolGroup)[]
}

export type LLMProviderResponse = {
  model?: string
  duration?: number
  count?: number
  [key: string]: LLMJsonValue | undefined
}

export type LLMTokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type LLMResponse = {
  content: string | null
  tool_calls?: LLMToolCall[]
  usage?: LLMTokenUsage
  finishReason?: string
  raw?: LLMProviderResponse // The original provider response
  request?: LLMRequestDetails
}

export type LLMProvider = {
  generateCompletion(
    messages: LLMMessage[],
    tools?: LLMToolDefinition[],
    systemInstruction?: string,
    modelName?: string
  ): Promise<LLMResponse>
}
