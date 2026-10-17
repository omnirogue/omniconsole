/** Retry without tags only when an older Console explicitly rejects that field before writing. */
export async function postTaskWithTags(
  url: string,
  init: RequestInit,
  body: Record<string, unknown>,
  isCurrent: () => boolean
): Promise<Response> {
  const post = (payload: Record<string, unknown>) => {
    if (!isCurrent()) {
      throw new Error('The signed-in account changed. Reopen the task form.')
    }
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(payload)
    })
  }
  const response = await post(body)
  if (!body.tags || response.status !== 400) {
    return response
  }
  const refusal = await response
    .clone()
    .json()
    .catch(() => null)
  const detail = refusal?.detail ?? refusal?.error?.message
  if (typeof detail !== 'string' || !/unknown fields:\s*\[['"]tags['"]\]\.?$/i.test(detail)) {
    return response
  }
  await response.body?.cancel().catch(() => undefined)
  const { tags: _tags, ...legacy } = body
  return post(legacy)
}

export function createdCardTags(payload: unknown): string[] | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const row = payload as Record<string, unknown>
  if (Array.isArray(row.tags) && row.tags.every((tag) => typeof tag === 'string')) {
    return row.tags as string[]
  }
  for (const nested of [row.task, row.board_task, row.payload, row.result]) {
    const tags = createdCardTags(nested)
    if (tags !== null) {
      return tags
    }
  }
  return null
}
