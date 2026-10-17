/**
 * The shape one allowlist row takes, and the helper that builds it — split out of
 * `console-workflow-routes.ts` so a satellite allowlist file (one is at its own
 * `max-lines` budget) can build the same `AllowedRoute` shape without a circular
 * import back to the main file.
 */
export type AllowedRoute = {
  /**
   * Every concrete path template this entry permits, `{param}` for each variable
   * segment. One pattern often covers several paths (an alternation over sibling
   * actions), and each of those is its own catalog row.
   */
  templates: readonly string[]
  /** What the transport actually matches. */
  test: RegExp
}

export const route = (templates: string | readonly string[], test: RegExp): AllowedRoute => ({
  templates: typeof templates === 'string' ? [templates] : templates,
  test
})
