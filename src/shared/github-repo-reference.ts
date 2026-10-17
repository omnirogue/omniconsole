/** A GitHub repository an option names: `owner/name` at its start, or a github.com link in it. */
export type GitHubRepoReference = { owner: string; repo: string }

// GitHub's own limits: owners are 1–39 letters, digits and single hyphens; names 1–100 of
// letters, digits, dots, hyphens and underscores. Anything else is not a repository name.
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}'
const NAME = '[A-Za-z0-9._-]{1,100}'
const LINK = new RegExp(`github\\.com/(${OWNER})/(${NAME})`, 'i')
const LEADING = new RegExp(`^(${OWNER})/(${NAME})(?=$|[\\s:,;)\\]—–-])`)

function reference(owner: string, name: string): GitHubRepoReference | undefined {
  const repo = name.replace(/\.git$/i, '')
  return repo && repo !== '.' && repo !== '..' ? { owner, repo } : undefined
}

/**
 * The repository an option names, if it names one: a github.com link anywhere in it, or
 * `owner/name` as its first word. Two words with a slash elsewhere ("and/or") are not one.
 */
export function githubRepoReference(text: string): GitHubRepoReference | undefined {
  const link = LINK.exec(text)
  if (link) {
    return reference(link[1]!, link[2]!)
  }
  const leading = LEADING.exec(text.trim())
  return leading ? reference(leading[1]!, leading[2]!) : undefined
}
