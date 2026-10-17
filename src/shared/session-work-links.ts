import { extractSessionLinkedDocs } from './session-linked-docs'

// The three Claude artifact addresses; a chat or project link is not a document.
const CLAUDE_ARTIFACT_URL =
  /https:\/\/claude\.ai\/(artifact|code\/artifact|public\/artifacts)\/([A-Za-z0-9-]{6,64})(?![A-Za-z0-9-])/g

/**
 * Every document a reply names, for the omnios Work log: its Slite docs and omnios pages (the
 * same reading the right panel makes) and its Claude artifacts, canonical and once each.
 */
export function extractSessionWorkLinks(text: string, apiOrigin: string | null): string[] {
  const urls = extractSessionLinkedDocs(text, apiOrigin, 0).map((doc) => doc.url)
  for (const match of text.matchAll(CLAUDE_ARTIFACT_URL)) {
    urls.push(`https://claude.ai/${match[1]}/${match[2]}`)
  }
  return [...new Set(urls)]
}
