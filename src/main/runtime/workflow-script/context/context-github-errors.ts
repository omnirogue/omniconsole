import { extractExecError } from '../../../git/exec-error'

/** Why a `gh` call failed, in words a person can act on. */
export function workflowGitHubErrorText(error: unknown, subject = 'GitHub'): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') {
    return 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run "gh auth login".'
  }
  const { stderr } = extractExecError(error)
  const text = `${stderr}\n${error instanceof Error ? error.message : String(error)}`
  if (/gh auth login|not logged|authentication|HTTP 401/i.test(text)) {
    return 'The GitHub CLI is not signed in. Run "gh auth login" in a terminal, then try again.'
  }
  if (/HTTP 404|Could not resolve to a Repository|not found/i.test(text)) {
    return `${subject} was not found, or your GitHub login can't see it.`
  }
  if (/Remote branch .* not found|couldn't find remote ref|did not match any/i.test(text)) {
    return `${subject}: that branch, tag or commit does not exist.`
  }
  if (/rate limit|HTTP 403|HTTP 429/i.test(text)) {
    return 'GitHub is limiting requests right now. Wait a minute and try again.'
  }
  const line = (stderr.trim().split('\n')[0] ?? '').trim()
  return `${subject}: ${(line || (error instanceof Error ? error.message : String(error))).slice(0, 200)}`
}
