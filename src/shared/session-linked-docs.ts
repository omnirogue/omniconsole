import { ARTIFACT_SLUG_PATTERN } from './artifact-review'

/**
 * A document a conversation pointed at in one of its replies: a Slite doc (plans, reports) or an
 * omnios page (`/a/{slug}`), whichever model or tool made it. The right panel shows the newest.
 */
export type SessionLinkedDoc =
  | { kind: 'slite'; id: string; url: string; seenAt: number }
  | { kind: 'omnios'; slug: string; url: string; seenAt: number }

/** One conversation's linked documents, as the renderer reads them (newest first). */
export type SessionLinkedDocsEntry = {
  paneKey: string
  docs: SessionLinkedDoc[]
  /** The omnios origin the `omnios` docs' preview documents are served from. */
  apiOrigin: string
}

export const SLITE_DOC_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/

// Why the host is part of the match: only a workspace's own Slite doc links, never lookalikes.
const SLITE_DOC_URL = /https:\/\/([a-z0-9-]{1,63})\.slite\.com\/app\/docs\/([A-Za-z0-9_-]{6,64})/g

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One key per document, whatever reply linked it. */
export function sessionLinkedDocKey(doc: SessionLinkedDoc): string {
  return doc.kind === 'slite' ? `slite:${doc.id}` : `omnios:${doc.slug}`
}

/**
 * The Slite docs and omnios pages a reply links to, in the order they first appear. `seenAt`
 * rises through the reply so its last link reads as the newest.
 */
export function extractSessionLinkedDocs(
  text: string,
  apiOrigin: string | null,
  seenAt: number
): SessionLinkedDoc[] {
  const found: { index: number; doc: SessionLinkedDoc }[] = []
  for (const match of text.matchAll(SLITE_DOC_URL)) {
    const [, workspace, id] = match
    found.push({
      index: match.index ?? 0,
      doc: { kind: 'slite', id, url: `https://${workspace}.slite.com/app/docs/${id}`, seenAt }
    })
  }
  if (apiOrigin) {
    const omnios = new RegExp(
      `${escapeRegExp(apiOrigin)}/a/([A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_/-])`,
      'g'
    )
    for (const match of text.matchAll(omnios)) {
      const slug = match[1]
      if (ARTIFACT_SLUG_PATTERN.test(slug)) {
        found.push({
          index: match.index ?? 0,
          doc: { kind: 'omnios', slug, url: `${apiOrigin}/a/${slug}`, seenAt }
        })
      }
    }
  }
  found.sort((left, right) => left.index - right.index)
  const seen = new Set<string>()
  const docs: SessionLinkedDoc[] = []
  for (const { doc } of found) {
    const key = sessionLinkedDocKey(doc)
    if (!seen.has(key)) {
      seen.add(key)
      docs.push(doc)
    }
  }
  return docs.map((doc, position) => ({ ...doc, seenAt: seenAt + position }))
}

/** Adds a reply's links to a conversation's list: newest first, one entry per document, capped. */
export function mergeSessionLinkedDocs(
  existing: readonly SessionLinkedDoc[],
  added: readonly SessionLinkedDoc[],
  limit: number
): SessionLinkedDoc[] {
  const byKey = new Map<string, SessionLinkedDoc>()
  for (const doc of [...existing, ...added]) {
    const key = sessionLinkedDocKey(doc)
    const previous = byKey.get(key)
    if (!previous || previous.seenAt <= doc.seenAt) {
      byKey.set(key, doc)
    }
  }
  return [...byKey.values()].sort((left, right) => right.seenAt - left.seenAt).slice(0, limit)
}

/** Tolerates a file written by any version: a malformed entry is dropped, never an error. */
export function sanitizeSessionLinkedDoc(value: unknown): SessionLinkedDoc | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const doc = value as Record<string, unknown>
  if (
    typeof doc.seenAt !== 'number' ||
    !Number.isFinite(doc.seenAt) ||
    typeof doc.url !== 'string'
  ) {
    return null
  }
  if (doc.kind === 'slite' && typeof doc.id === 'string' && SLITE_DOC_ID_PATTERN.test(doc.id)) {
    return /^https:\/\/[a-z0-9-]{1,63}\.slite\.com\/app\/docs\//.test(doc.url)
      ? { kind: 'slite', id: doc.id, url: doc.url, seenAt: doc.seenAt }
      : null
  }
  if (
    doc.kind === 'omnios' &&
    typeof doc.slug === 'string' &&
    ARTIFACT_SLUG_PATTERN.test(doc.slug)
  ) {
    return doc.url.startsWith('https://')
      ? { kind: 'omnios', slug: doc.slug, url: doc.url, seenAt: doc.seenAt }
      : null
  }
  return null
}
