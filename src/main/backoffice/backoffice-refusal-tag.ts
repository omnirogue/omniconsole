/** The console's refusal tag when the body carries one; the body is consumed either way. */
export async function refusalTag(response: Response): Promise<string | null> {
  if (response.status === 410) {
    // Why: 410 is the stale-page answer by status alone; its body is not worth parsing.
    await response.body?.cancel().catch(() => undefined)
    return 'todo-page-stale'
  }
  try {
    const body = (await response.json()) as { tag?: unknown } | null
    return typeof body?.tag === 'string' ? body.tag : null
  } catch {
    return null
  }
}
