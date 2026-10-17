/** Private journal state; never included in the rendered session snapshot. */
export type JournalTaskPublication = {
  sourceEventId: string
  taskId: string
  principal: string
  profileKey?: string
  baseUrl: string
  request: string
  noteId: string | null
}

export function isJournalTaskPublication(value: unknown): value is JournalTaskPublication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const row = value as Record<string, unknown>
  if (
    typeof row.sourceEventId !== 'string' ||
    !/^ide-observation-v1:[a-f0-9]{64}$/.test(row.sourceEventId) ||
    typeof row.taskId !== 'string' ||
    !/^btk_[A-Za-z0-9]{4,64}$/.test(row.taskId) ||
    typeof row.principal !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.principal) ||
    (row.profileKey !== undefined &&
      (typeof row.profileKey !== 'string' || !/^[a-f0-9]{64}$/.test(row.profileKey))) ||
    typeof row.baseUrl !== 'string' ||
    row.baseUrl.length > 2048 ||
    typeof row.request !== 'string' ||
    Buffer.byteLength(row.request, 'utf8') > 32_768 ||
    !(
      row.noteId === null ||
      (typeof row.noteId === 'string' && /^tve_[A-Za-z0-9_-]{1,200}$/.test(row.noteId))
    )
  ) {
    return false
  }
  try {
    const url = new URL(row.baseUrl)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    ) {
      return false
    }
    const body = JSON.parse(row.request)
    return (
      body?.source_event_id === row.sourceEventId &&
      body.note_kind === 'progress' &&
      typeof body.note === 'string' &&
      body.note.length > 0 &&
      body.payload &&
      typeof body.payload === 'object' &&
      !Array.isArray(body.payload) &&
      Object.keys(body).every((key) =>
        ['source_event_id', 'note_kind', 'note', 'payload'].includes(key)
      )
    )
  } catch {
    return false
  }
}
