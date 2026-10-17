const ID = /^[A-Za-z0-9_-]{1,128}$/

/** Exact member-scoped reads used by Work messages and discussion history. */
export function isInboxFeedPath(path: string): boolean {
  if (path.length > 1024 || path.includes('#')) {
    return false
  }
  if (path === '/api/peer/people') {
    return true
  }
  if (!path.startsWith('/api/estate/peers/')) {
    return false
  }
  const url = new URL(path, 'https://inbox.invalid')
  if (url.origin !== 'https://inbox.invalid') {
    return false
  }
  const route = url.pathname.slice('/api/estate/peers/'.length)
  const keys = [...url.searchParams.keys()]
  if (new Set(keys).size !== keys.length) {
    return false
  }
  const valid = (name: string) => ID.test(url.searchParams.get(name) ?? '')
  if (route === 'projects') {
    return keys.length === 0
  }
  if (route === 'threads' || route === 'rooms') {
    return (
      valid('project_id') &&
      keys.every(
        (key) =>
          key === 'project_id' ||
          (route === 'threads' && key === 'view' && url.searchParams.get(key) === 'archived') ||
          (key === 'cursor' && valid(key)) ||
          (key === 'limit' && url.searchParams.get(key) === '20')
      )
    )
  }
  if (/^rooms\/[A-Za-z0-9_-]{1,128}$/.test(route)) {
    return keys.length === 0
  }
  if (/^rooms\/[A-Za-z0-9_-]{1,128}\/messages$/.test(route)) {
    return keys.every(
      (key) =>
        (key === 'cursor' && valid(key)) || (key === 'limit' && url.searchParams.get(key) === '20')
    )
  }
  return false
}
