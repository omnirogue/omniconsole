/**
 * Claude Code's `ultracode`: not a level of the effort ladder but xhigh effort plus
 * dynamic workflows. The CLI never lists it — `list_models` advertises
 * low…max only — yet accepts it everywhere an effort goes: `--effort ultracode` at
 * launch, `/effort ultracode` mid-session, and `{ ultracode: true }` over the flag
 * settings bridge. Measured on Claude Code 2.1.236: a `--effort ultracode` launch
 * reports `applied: { effort: "xhigh", ultracode: true }` from `get_settings`.
 *
 * Every Claude effort list in the app derives from the CLI's own levels, so the
 * one rule for offering ultracode lives here: a model that takes xhigh takes it.
 * Pure: shared by main, renderer and mobile.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode'

/** The ladder level ultracode runs at; what the CLI reports as the effort under it. */
export const CLAUDE_ULTRACODE_BASE_EFFORT = 'xhigh'

/** The CLI's advertised levels plus ultracode wherever xhigh is among them. */
export function withClaudeUltracode(levels: readonly string[]): string[] {
  if (!levels.includes(CLAUDE_ULTRACODE_BASE_EFFORT) || levels.includes(CLAUDE_ULTRACODE_EFFORT)) {
    return [...levels]
  }
  return [...levels, CLAUDE_ULTRACODE_EFFORT]
}
