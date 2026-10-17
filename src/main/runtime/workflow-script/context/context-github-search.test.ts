import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listWorkflowContextBranches,
  parseWorkflowRepoList,
  parseWorkflowRepoSearch,
  resetWorkflowContextRepoCache,
  searchWorkflowContextRepos,
  workflowRepoDescription
} from './context-github-search'
import { workflowGitHubErrorText } from './context-github-errors'

vi.mock('../../../github/gh-utils', () => ({
  acquire: async () => {},
  release: () => {},
  ghExecFileAsync: vi.fn()
}))

afterEach(() => resetWorkflowContextRepoCache())

const own = JSON.stringify([
  { nameWithOwner: 'sal/notes', description: 'mine', defaultBranchRef: { name: 'main' } }
])
const org = JSON.stringify([
  {
    nameWithOwner: 'omnirogue/omni-ide',
    description: null,
    defaultBranchRef: { name: 'main-next' }
  }
])

/** A fake `gh` that answers by the command it is given. */
function gh(answers: Record<string, string | Error>) {
  return vi.fn(async (args: string[]) => {
    const key = args.slice(0, 3).join(' ')
    const answer = Object.entries(answers).find(([prefix]) => key.startsWith(prefix))?.[1]
    if (answer instanceof Error || answer === undefined) {
      throw answer ?? new Error(`unexpected gh ${args.join(' ')}`)
    }
    return { stdout: answer, stderr: '' }
  })
}

describe('GitHub repositories for the picker', () => {
  it('reads repo lists and search results, dropping names that are not owner/name', () => {
    expect(parseWorkflowRepoList(own)).toEqual([
      { repo: 'sal/notes', description: 'mine', defaultBranch: 'main' }
    ])
    expect(
      parseWorkflowRepoSearch(
        JSON.stringify([
          { fullName: 'acme/api', description: 'API', defaultBranch: 'dev' },
          { fullName: '../evil', description: '', defaultBranch: '' }
        ])
      )
    ).toEqual([{ repo: 'acme/api', description: 'API', defaultBranch: 'dev' }])
  })

  it('lists the person’s own and their organizations’ repos when nothing is typed', async () => {
    const exec = gh({
      'api user/orgs': 'ApexLabs\n',
      'repo list --limit': own,
      'repo list ApexLabs': org
    })
    expect(await searchWorkflowContextRepos('', { exec, now: 1 })).toEqual({
      repos: [
        { repo: 'sal/notes', description: 'mine', defaultBranch: 'main' },
        { repo: 'omnirogue/omni-ide', description: '', defaultBranch: 'main-next' }
      ]
    })
  })

  it('puts an exact owner/name and the person’s own matches before GitHub’s search', async () => {
    const exec = gh({
      'api user/orgs': '',
      'repo list --limit': own,
      'repo view sal/notes': JSON.stringify(JSON.parse(own)[0]),
      'search repos --limit': JSON.stringify([
        { fullName: 'sal/notes', description: 'mine', defaultBranch: 'main' },
        { fullName: 'other/notes', description: '', defaultBranch: 'main' }
      ])
    })
    const result = await searchWorkflowContextRepos('sal/notes', { exec, now: 1 })
    expect('repos' in result && result.repos.map((hit) => hit.repo)).toEqual([
      'sal/notes',
      'other/notes'
    ])
  })

  it('says plainly when gh is missing or signed out', async () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    expect(
      await searchWorkflowContextRepos('', {
        exec: gh({ 'api user/orgs': '', 'repo list --limit': missing }),
        now: 1
      })
    ).toEqual({
      error: expect.stringContaining('The GitHub CLI (gh) is not installed')
    })
    expect(
      workflowGitHubErrorText(
        Object.assign(new Error('failed'), {
          stderr: 'To get started with GitHub CLI, please run:  gh auth login'
        })
      )
    ).toContain('not signed in')
  })

  it('lists branches, and refuses a name that is not owner/name', async () => {
    const exec = gh({ 'api repos/acme/api/branches?per_page=100': 'main\ndev\n' })
    expect(await listWorkflowContextBranches('acme/api', { exec })).toEqual({
      branches: ['main', 'dev']
    })
    expect(exec.mock.calls[0][0]).toContain('--paginate')
    expect(await listWorkflowContextBranches('acme', { exec })).toEqual({
      error: 'Not a GitHub owner/name.'
    })
  })
})

describe('repository descriptions in results', () => {
  it('keeps a short description as one line', () => {
    expect(workflowRepoDescription('  A tidy\n  API  ')).toBe('A tidy API')
    expect(workflowRepoDescription(null)).toBe('')
  })

  it('cuts a long description on a word boundary with an ellipsis', () => {
    const readme = `# Title\n\n${'lorem ipsum dolor '.repeat(40)}`
    const short = workflowRepoDescription(readme)
    expect(short.length).toBeLessThanOrEqual(140)
    expect(short).not.toMatch(/\n/)
    expect(short.endsWith('…')).toBe(true)
    expect(short.startsWith('# Title lorem ipsum')).toBe(true)
    expect(short.slice(0, -1)).toMatch(/(lorem|ipsum|dolor)$/)
  })

  it('hard-cuts a single word with no boundary', () => {
    expect(workflowRepoDescription('x'.repeat(300))).toBe(`${'x'.repeat(139)}…`)
  })

  it('applies to list and search rows', () => {
    const long = 'word '.repeat(100)
    const [listed] = parseWorkflowRepoList(
      JSON.stringify([{ nameWithOwner: 'a/b', description: long, defaultBranchRef: null }])
    )
    const [found] = parseWorkflowRepoSearch(
      JSON.stringify([{ fullName: 'a/b', description: long, defaultBranch: 'main' }])
    )
    expect(listed.description.length).toBeLessThanOrEqual(140)
    expect(found.description).toBe(listed.description)
  })
})
