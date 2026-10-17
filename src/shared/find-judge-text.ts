import { githubRepoReference } from './github-repo-reference'
import { IGNORABLE } from './invisible-characters'

export type FindJudgeInput = { title: string; detail: string; url?: string; text?: string }

// Nothing here decodes: decoding is where every bypass lived. The url field is also read by the URL
// parser itself (which resolves escapes, compatibility letters and invisible characters); any text
// that holds an escape or entity counts as GitHub outright, and otherwise is folded (compatibility
// forms, invisible characters, case) and checked for GitHub at all. Deliberately broad: hiding a
// description that merely mentions GitHub costs little.
const ENCODED = /%[0-9a-f]{2}|&#|&[a-z][a-z0-9]*;/i
const SCP = /^[^@\s/]+@([^:\s/]+):/

const folded = (text: string) =>
  text.normalize('NFKC').replace(IGNORABLE, '').normalize('NFKC').toLowerCase()

// The hostnames the URL parser reads from an address, in its own form, scheme-less, or scp.
function hostnames(address: string): string[] {
  const value = address.trim()
  const scp = SCP.exec(value)
  const hosts = scp ? [scp[1]!] : []
  for (const form of [value, value.startsWith('//') ? `https:${value}` : `https://${value}`]) {
    try {
      const host = new URL(form).hostname
      if (host) {
        hosts.push(host)
      }
    } catch {
      // Not an address in this form.
    }
  }
  return hosts
}

const hostIsGitHub = (address: string) =>
  hostnames(address).some((host) => folded(host).includes('github'))

// The url field also gets the whole free-text check: a permissive parse is no proof it is one address.
const urlMentionsGitHub = (url: string) => hostIsGitHub(url) || textMentionsGitHub(url)

function textMentionsGitHub(text: string | undefined): boolean {
  if (!text) {
    return false
  }
  if (ENCODED.test(text) || folded(text).includes('github')) {
    return true
  }
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[(<[{"'`]+|[)>\]}"'`,.;!?]+$/g, ''))
    .some((word) => word.includes('.') && hostIsGitHub(word))
}

/**
 * True when the option points at GitHub at all: a leading `owner/name` title, or "github" in any
 * spelling anywhere in its title, url or detail. Its description then never reaches a judge.
 */
export function namesGitHubRepo(option: Pick<FindJudgeInput, 'title' | 'detail' | 'url'>): boolean {
  return (
    !!githubRepoReference(option.title) ||
    textMentionsGitHub(option.title) ||
    (!!option.url && urlMentionsGitHub(option.url)) ||
    textMentionsGitHub(option.detail)
  )
}

/**
 * The one judge-safe projection of an option: what JEV's screen, JEV's own final ballot, the
 * model judges, and every continuation (Improve, Combine, Look closer) are ever shown. A
 * repository's detail is free text its owner wrote and could word as instructions to the judges
 * (graph-find-facts.ts refuses the same thing for GitHub's own facts): judges get the title and
 * its link, never the owner's words, whichever field named the repository. A non-repository
 * option's own detail is the person's own words, so it is shown in full.
 */
export function findJudgeText(option: FindJudgeInput): string {
  if (option.text) {
    return option.text
  }
  const link = option.url ? ` (${option.url})` : ''
  if (namesGitHubRepo(option)) {
    return `${option.title}${link}`
  }
  return option.detail ? `${option.title}: ${option.detail}${link}` : `${option.title}${link}`
}
