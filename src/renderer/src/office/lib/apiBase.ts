/**
 * The office's read path, vendored.
 *
 * In the console the office was served BY the backoffice, so `apiFetch` was a
 * same-origin fetch. Here it is a page in a desktop app: the base URL and the
 * bearer live in the main process and must not reach the renderer, so the same
 * call goes over IPC instead. GET-only and exact-path allowlisted on the other
 * side — this is the office reading its telemetry, never a general client.
 *
 * The signature is kept fetch-shaped so the vendored callers are unchanged.
 */
export async function apiFetch(path: string, _init?: RequestInit): Promise<Response> {
  const result = await window.api.backoffice.feed({ path })
  if (!result.ok) {
    // The office treats a non-ok response as "feed unavailable" and renders that
    // honestly, so the failure is passed through as a status rather than thrown.
    return new Response(JSON.stringify({ error: result.message }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  }
  return new Response(JSON.stringify(result.body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
