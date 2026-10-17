import type { CommitMessageModel } from './commit-message-agent-spec'

export const OMP_MODEL_LIST_ARGS = ['models', 'ls', '--json']

/** OMP 18.2 publishes auth-configured models, not a tool-capability attestation. */
export function parseOmpModelList(stdout: string): CommitMessageModel[] {
  let payload: unknown
  try {
    payload = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!payload || typeof payload !== 'object' || !('models' in payload)) {
    return []
  }
  if (!Array.isArray(payload.models)) {
    return []
  }
  const models = new Map<string, CommitMessageModel>()
  for (const row of payload.models) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const { provider, id, selector, name } = row
    if (
      typeof provider !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(provider) ||
      typeof id !== 'string' ||
      !id ||
      /\s/.test(id) ||
      [...id].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      row.supportsTools === false
    ) {
      continue
    }
    const fullId = `${provider}/${id}`
    if (selector !== undefined && selector !== fullId) {
      continue
    }
    models.set(fullId, {
      id: fullId,
      label: typeof name === 'string' && name.trim() ? `${name} (${provider})` : fullId,
      ...(typeof row.reasoning === 'boolean' ? { reasoning: row.reasoning } : {}),
      ...(row.thinking === null
        ? { thinking: null }
        : Array.isArray(row.thinking) &&
            row.thinking.every((value: unknown) => typeof value === 'string')
          ? { thinking: [...row.thinking] }
          : {})
    })
  }
  return [...models.values()]
}
