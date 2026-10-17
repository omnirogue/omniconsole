import { assertAuditSourceId, auditTimestamp, type AuditSource } from './audit-corpus'

type DigestMessage = { timestamp: string | null; text: string; role: string; index: number }

function digestRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Audit digest must be an object')
  }
  return value as Record<string, unknown>
}

function digestMessages(value: unknown, role: 'USER' | 'ASSISTANT'): DigestMessage[] {
  if (!Array.isArray(value)) {
    throw new Error(`Audit digest ${role} messages must be an array`)
  }
  return value.map((item, index) => {
    const record = digestRecord(item)
    if (typeof record.text !== 'string') {
      throw new Error('Audit digest message text must be a string')
    }
    if (role === 'USER' && record.auto !== undefined && typeof record.auto !== 'boolean') {
      throw new Error('Audit digest auto label must be boolean when supplied')
    }
    if (record.ts != null && typeof record.ts !== 'string') {
      throw new Error('Audit digest message timestamp must be a string or null')
    }
    const auto = typeof record.auto === 'boolean' ? String(record.auto) : 'unknown'
    return {
      timestamp: record.ts == null ? null : auditTimestamp(record.ts as string),
      text: record.text,
      role: role === 'USER' ? `USER auto=${auto}` : role,
      index
    }
  })
}

export function auditSourceFromDigest(value: unknown): AuditSource {
  const digest = digestRecord(value)
  if (typeof digest.id !== 'string' || typeof digest.first_ts !== 'string') {
    throw new Error('Audit digest requires string id and first_ts fields')
  }
  assertAuditSourceId(digest.id)
  const timestamp = auditTimestamp(digest.first_ts)
  const messages = [
    ...digestMessages(digest.user_msgs, 'USER'),
    ...digestMessages(digest.assistant, 'ASSISTANT')
  ].sort((left, right) => {
    const time = Date.parse(left.timestamp ?? timestamp) - Date.parse(right.timestamp ?? timestamp)
    return time || left.index - right.index
  })
  const text = [
    'DIGEST: supplied text may already be clipped and whole messages or tool outputs omitted.',
    'Existing clipping markers and extractor auto labels are preserved; no additional clipping is applied.',
    'auto=false is an extractor label, not proof of human authorship; missing timestamps are marked unknown.',
    ...messages.map(
      (message) => `[${message.role} ts=${message.timestamp ?? 'unknown'}]\n${message.text}`
    )
  ].join('\n\n')
  return { id: digest.id, timestamp, text }
}

export function parseAuditDigestJsonl(jsonl: string): AuditSource[] {
  const sources: AuditSource[] = []
  const seen = new Set<string>()
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue
    }
    let source: AuditSource
    try {
      source = auditSourceFromDigest(JSON.parse(line))
    } catch {
      throw new Error(`Invalid audit digest at JSONL line ${index + 1}`)
    }
    if (seen.has(source.id)) {
      throw new Error(`Duplicate audit source ID: ${source.id}`)
    }
    seen.add(source.id)
    sources.push(source)
  }
  return sources
}
