import { sameOllamaTag, type OllamaInstalledModel } from '../../../shared/local-ollama-launch'
import { modelLineage } from '../../../shared/model-lineage'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import { listOllamaModels, resolveOllamaBaseUrl } from '../../local-ollama/ollama-inventory'
import { nativeContext, readOllamaMetadata } from '../../local-ollama/ollama-model-context'

export const OLLAMA_NOT_RUNNING =
  'Ollama is not running on this computer. Start Ollama, then reopen the workflow.'
export const OLLAMA_NO_MODELS =
  'No Ollama model is installed on this computer. Pull one, for example: ollama pull qwen3:8b'

/** What `/api/show` says a model can do; read once per tag and kept briefly. */
export type WorkflowOllamaProfile = {
  /** Answers chat requests at all: embedding-only models do not. */
  completion: boolean
  tools: boolean
  /** The most tokens the model can read; absent when the server does not say. */
  contextTokens?: number
}

const PROFILE_TTL_MS = 60_000
const profiles = new Map<string, { expires: number; profile: WorkflowOllamaProfile }>()

export async function workflowOllamaProfile(
  model: string,
  base = resolveOllamaBaseUrl()
): Promise<WorkflowOllamaProfile | undefined> {
  const key = `${base}\n${model}`
  const kept = profiles.get(key)
  if (kept && kept.expires > Date.now()) {
    return kept.profile
  }
  const details = await readOllamaMetadata(`${base}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model })
  })
  if (!details) {
    return undefined
  }
  // Servers older than the capabilities field answer chat for every model they list.
  const capabilities = Array.isArray(details.capabilities) ? details.capabilities : undefined
  const info =
    details.model_info && typeof details.model_info === 'object'
      ? (details.model_info as Record<string, unknown>)
      : undefined
  const contextTokens = nativeContext(info)
  const profile: WorkflowOllamaProfile = {
    completion: !capabilities || capabilities.includes('completion'),
    tools: !!capabilities?.includes('tools'),
    ...(contextTokens ? { contextTokens } : {})
  }
  profiles.set(key, { expires: Date.now() + PROFILE_TTL_MS, profile })
  return profile
}

/** Where the model runs: only a local server running a local tag is this computer at no cost. */
function describe(model: OllamaInstalledModel, baseUrl: string): string {
  const size = model.sizeBytes ? `${(model.sizeBytes / 1e9).toFixed(1)} GB` : ''
  const host = new URL(baseUrl).hostname
  const where = /(^|[-:])cloud$/.test(model.name)
    ? 'Ollama cloud model'
    : ['localhost', '127.0.0.1', '[::1]'].includes(host)
      ? 'runs on this computer, no cost'
      : `runs on ${host}`
  return [model.parameterSize, size, where].filter(Boolean).join(' · ')
}

/**
 * The installed Ollama models a workflow may seat. A model whose family this build cannot place
 * stays listed with lineage `unknown`, so setup can say why it is not offered.
 */
export async function workflowOllamaCatalog(): Promise<{
  models: LocalWorkflowSeatCatalog['models']
  unavailableReason?: string
}> {
  const inventory = await listOllamaModels()
  if (inventory.status !== 'connected') {
    return { models: [], unavailableReason: OLLAMA_NOT_RUNNING }
  }
  const listed = await Promise.all(
    inventory.models.map(async (model) => ({
      model,
      profile: await workflowOllamaProfile(model.name, inventory.baseUrl)
    }))
  )
  const models = listed
    .filter(({ profile }) => profile?.completion !== false)
    .map(({ model, profile }) => ({
      catalog: {
        id: model.name,
        label: model.name,
        description: describe(model, inventory.baseUrl),
        isDefault: false,
        options: []
      },
      resolvedModelId: model.name,
      lineage: modelLineage('ollama', model.name),
      supportsTools: profile?.tools === true
    }))
  return { models, ...(models.length ? {} : { unavailableReason: OLLAMA_NO_MODELS }) }
}

/** Whether the tag is installed right now; a seat frozen earlier may name one since removed. */
export async function workflowOllamaInstalled(model: string): Promise<boolean> {
  const inventory = await listOllamaModels()
  return (
    inventory.status === 'connected' &&
    inventory.models.some((entry) => sameOllamaTag(entry.name, model))
  )
}

const CONTEXT_STEPS = [8_192, 16_384, 32_768, 65_536, 131_072, 262_144]
/**
 * Room for a reasoning model's thinking and its answer (thinking counts against it too). Not
 * more: a small local model sometimes thinks until this runs out, and the call is lost for as
 * long as that takes (measured: a 4B Qwen spent 16,384 tokens and 196 s thinking, twice).
 */
const ANSWER_TOKENS = 8_192
const MIN_ANSWER_TOKENS = 1_024
/** File content a workspace read may bring into the conversation on top of the prompt. */
const WORKSPACE_READ_TOKENS = 24_000
const MIN_WORKSPACE_READ_TOKENS = 4_000
const OVERHEAD_TOKENS = 1_024

export type WorkflowOllamaCallContext = {
  /** `num_ctx`: what the model is loaded with for this call. */
  contextTokens: number
  /** `num_predict`: the most the answer (and any thinking) may take. */
  maxTokens: number
  /** What the workspace tools may add; the worker cuts their results to it. */
  toolTokens: number
}

/**
 * The context for one call: the smallest step that holds the prompt, the answer and what a
 * workspace read may bring in (about three characters a token, on the safe side). A model with
 * a smaller limit keeps what fits: a shorter answer and less to read. A prompt the model cannot
 * read whole is refused here, because Ollama would drop part of it without saying so.
 */
export function workflowOllamaCallContext(input: {
  model: string
  promptChars: number
  workspaceRead: boolean
  /** The model's own limit, when the server reports one. */
  limit?: number
}): WorkflowOllamaCallContext {
  const prompt = Math.ceil(input.promptChars / 3) + OVERHEAD_TOKENS
  const reading = input.workspaceRead ? WORKSPACE_READ_TOKENS : 0
  const wanted = prompt + ANSWER_TOKENS + reading
  if (!input.limit || wanted <= input.limit) {
    const step = CONTEXT_STEPS.find((size) => size >= wanted) ?? wanted
    return {
      contextTokens: input.limit ? Math.min(step, input.limit) : step,
      maxTokens: ANSWER_TOKENS,
      toolTokens: reading
    }
  }
  const room = input.limit - prompt
  const least = MIN_ANSWER_TOKENS + (input.workspaceRead ? MIN_WORKSPACE_READ_TOKENS : 0)
  if (room < least) {
    throw new Error(
      `Ollama: this call needs about ${(prompt + least).toLocaleString('en-US')} tokens of context and ${input.model} reads ${input.limit.toLocaleString('en-US')}. Choose a model with a larger context for this step.`
    )
  }
  const maxTokens = input.workspaceRead
    ? Math.max(MIN_ANSWER_TOKENS, Math.min(ANSWER_TOKENS, Math.floor(room / 3)))
    : Math.min(ANSWER_TOKENS, room)
  return {
    contextTokens: input.limit,
    maxTokens,
    toolTokens: input.workspaceRead ? room - maxTokens : 0
  }
}
