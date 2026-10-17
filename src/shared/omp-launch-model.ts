export const DEFAULT_OMP_OPENROUTER_MODEL = 'moonshotai/kimi-k3'

const FAMILY_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'GPT / OpenAI',
  google: 'Gemini / Gemma',
  moonshotai: 'Kimi',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  'meta-llama': 'Llama',
  mistralai: 'Mistral',
  'x-ai': 'Grok',
  'z-ai': 'GLM',
  minimax: 'MiniMax'
}

export function openRouterModelFamily(id: string): string {
  const author = id.split('/')[0].replace(/^~/, '')
  return FAMILY_NAMES[author] ?? author
}
