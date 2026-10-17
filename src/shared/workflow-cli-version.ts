import type { LocalWorkflowRoute } from './local-workflow-seats'

/**
 * Oldest CLI release whose workflow behaviour was measured (2026-09-21 probes). Newer releases are
 * accepted: exact pins made Council and Discover unstartable after every routine CLI update.
 */
export const WORKFLOW_CLI_MINIMUM_VERSIONS: Record<
  Exclude<LocalWorkflowRoute, 'openrouter' | 'ollama'>,
  string
> = {
  claude: '2.1.278',
  codex: '0.155.1',
  grok: '1.0.34',
  gemini: '0.59.0'
}

/** First `major.minor.patch` in a `--version` line, e.g. "grok 1.0.34 (3736acbc8658) [stable]". */
export function parseWorkflowCliVersion(output: string): string | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return match ? match.slice(1, 4).map(Number).join('.') : undefined
}

/** Numeric comparison; anything that is not a version is never new enough. */
export function workflowCliVersionAtLeast(version: string, minimum: string): boolean {
  const actual = parseWorkflowCliVersion(version)?.split('.').map(Number)
  const floor = parseWorkflowCliVersion(minimum)?.split('.').map(Number)
  if (!actual || !floor) {
    return false
  }
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== floor[index]) {
      return actual[index] > floor[index]
    }
  }
  return true
}
