import { artifactContentUrl } from '../../../../../shared/artifact-session'
import { ARTIFACT_SLUG_PATTERN } from '../../../../../shared/artifact-review'
import { SLITE_DOC_ID_PATTERN } from '../../../../../shared/session-linked-docs'
import type { SessionPanelItem } from './session-panel-items'

/** Exact document routes only: never preview a lookalike host or a different operation. */
export function sessionDocumentLink(raw: string, apiOrigin: string): SessionPanelItem | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) {
    return null
  }
  const slite = /^\/app\/docs\/([^/]+)\/?$/.exec(url.pathname)
  if (
    url.protocol === 'https:' &&
    url.port === '' &&
    /^[a-z0-9-]{1,63}\.slite\.com$/.test(url.hostname) &&
    slite &&
    SLITE_DOC_ID_PATTERN.test(slite[1])
  ) {
    return { kind: 'slite', key: `slite:${slite[1]}`, id: slite[1], url: url.href, at: Date.now() }
  }
  const artifact = /^\/a\/([^/]+)\/?$/.exec(url.pathname)
  if (url.origin === apiOrigin && artifact && ARTIFACT_SLUG_PATTERN.test(artifact[1])) {
    return {
      kind: 'artifact',
      key: `artifact:${artifact[1]}`,
      at: Date.now(),
      record: {
        slug: artifact[1],
        sourceKey: '',
        shareUrl: url.href,
        savedAt: Date.now(),
        origin: null,
        contentUrl: artifactContentUrl(apiOrigin, artifact[1])
      }
    }
  }
  return null
}
