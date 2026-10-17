import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowPlacement } from '../../../shared/local-workflow-placement'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { readyWorkflowFleetDispatch, WORKFLOW_FLEET_RUNS_FOLDER } from './workflow-fleet-dispatch'
import { parseWorkflowFleetProbe, workflowFleetRouteProblem } from './workflow-fleet-host-probe'
import { workflowFleetShellQuote } from './workflow-fleet-remote-shell'
import { createFakeFleet, type FakeFleet } from './workflow-fleet.test-fixtures'
import { runProcess } from '../../../shared/child-process/run-process'

const NOW = 1_800_000_000_000
const PLACEMENT: WorkflowPlacement = {
  runsOn: 'fleet',
  mode: 'dispatched-seats',
  choice: 'named',
  host: {
    name: 'mw0004',
    machine: 'mw0004',
    cores: 10,
    loadPerCore: 0.1,
    readAt: NOW,
    ssh: 'mw0004'
  }
}

function seat(id: string, agent: 'claude' | 'codex' | 'grok') {
  return {
    id,
    agent,
    accountId: `${agent}-account`,
    model:
      agent === 'claude' ? 'claude-opus-5' : agent === 'codex' ? 'gpt-5.6-sol' : 'grok-4.6-build',
    effort: 'low',
    lineage: agent === 'claude' ? 'anthropic' : agent === 'codex' ? 'openai' : 'xai',
    policyRevision: 'fixture-v1'
  }
}

function snapshot(change: Partial<LocalWorkflowHostSnapshot> = {}): LocalWorkflowHostSnapshot {
  return {
    version: 1,
    task: { prompt: 'Question', evidence: '' },
    synthesizerId: 'a',
    seats: [seat('a', 'claude'), seat('b', 'codex')],
    ...change,
    host: {
      workspaceId: 'w',
      conversationId: 'c',
      requestDigest: 'd',
      startedAt: NOW,
      concurrency: 2,
      sources: [],
      coverage: [],
      ...change.host
    }
  } as LocalWorkflowHostSnapshot
}

const CODEX_ONLY = { seats: [seat('b', 'codex')] } as Partial<LocalWorkflowHostSnapshot>

let fleet: FakeFleet
const folders: string[] = []
beforeEach(async () => {
  fleet = await createFakeFleet(['mw0004'])
})
afterEach(async () => {
  await fleet.close()
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('the host probe', () => {
  it('reads the home, the CLIs and which kind of login each has', () => {
    const facts = parseWorkflowFleetProbe(
      [
        'home=/Users/cloud',
        'os=Darwin',
        'exists=/Users',
        'exists=/private/tmp',
        'claude.version=2.1.285 (Claude Code)',
        'claude.auth.begin',
        '{"loggedIn": true, "authMethod": "claude.ai", "email": "x@y"}',
        'claude.auth.end',
        'codex.version=codex-cli 0.159.2',
        'codex.login=chatgpt'
      ].join('\n')
    )
    expect(facts).toEqual({
      home: '/Users/cloud',
      os: 'Darwin',
      existing: ['/Users', '/private/tmp'],
      versions: { claude: '2.1.285', codex: '0.159.2' },
      claudeAuth: { loggedIn: true, authMethod: 'claude.ai' },
      codexLogin: 'chatgpt'
    })
    expect(parseWorkflowFleetProbe('banner\nno home here')).toBeUndefined()
  })

  it('names what keeps a CLI from running a seat, and never accepts an API key', () => {
    const facts = parseWorkflowFleetProbe('home=/h\nos=Linux\n')!
    expect(workflowFleetRouteProblem('mw0004', 'claude', facts)).toBe(
      'Claude CLI is not installed on mw0004.'
    )
    expect(
      workflowFleetRouteProblem('mw0004', 'claude', {
        ...facts,
        versions: { claude: '2.1.200' }
      })
    ).toBe('Claude CLI on mw0004 is 2.1.200; workflows need 2.1.278 or newer.')
    const claude = { ...facts, versions: { claude: '2.1.285', codex: '0.159.2' } }
    expect(
      workflowFleetRouteProblem('mw0004', 'claude', {
        ...claude,
        claudeAuth: { loggedIn: false, authMethod: 'none' }
      })
    ).toBe('Claude is not signed in on mw0004 (claude auth status reports no login over SSH).')
    expect(
      workflowFleetRouteProblem('mw0004', 'claude', {
        ...claude,
        claudeAuth: { loggedIn: true, authMethod: 'api_key' }
      })
    ).toBe(
      'Claude on mw0004 signs in with api_key, not a subscription; workflow seats never use API keys.'
    )
    expect(workflowFleetRouteProblem('mw0004', 'codex', { ...claude, codexLogin: 'api-key' })).toBe(
      'Codex on mw0004 is signed in with an API key; workflow seats run only on a ChatGPT subscription login.'
    )
    expect(workflowFleetRouteProblem('mw0004', 'codex', { ...claude, codexLogin: 'chatgpt' })).toBe(
      undefined
    )
  })

  it('names a seat model that needs a newer CLI than the host has', () => {
    const facts = {
      ...parseWorkflowFleetProbe('home=/h\nos=Linux\n')!,
      versions: { claude: '2.1.292' },
      claudeAuth: { loggedIn: true, authMethod: 'claude.ai' }
    }
    expect(workflowFleetRouteProblem('mw0001', 'claude', facts, ['claude-haiku-5-5'])).toBe(
      'Claude CLI on mw0001 is 2.1.292; claude-haiku-5-5 needs 2.1.293 or newer.'
    )
    expect(
      workflowFleetRouteProblem('mw0001', 'claude', facts, ['claude-haiku-4-5-20251001'])
    ).toBe(undefined)
    expect(
      workflowFleetRouteProblem('mw0001', 'claude', { ...facts, versions: { claude: '2.1.293' } }, [
        'claude-haiku-5-5'
      ])
    ).toBe(undefined)
  })

  it('quotes any text for the host shell', () => {
    expect(workflowFleetShellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`)
  })
})

describe('readying a host for dispatched seats', () => {
  it('refuses seats other than Claude and Codex by name before reaching the host', async () => {
    await expect(
      readyWorkflowFleetDispatch(
        PLACEMENT,
        snapshot({
          seats: [seat('a', 'claude'), seat('g', 'grok')]
        } as Partial<LocalWorkflowHostSnapshot>)
      )
    ).rejects.toThrow(
      "Seats on mw0004 run Claude and Codex on its own subscription logins; Grok cannot run there. Choose Claude and Codex seats, or 'this computer'."
    )
  })

  it('refuses a run whose command check would run in this workspace', async () => {
    const withCheck = snapshot({
      graph: { spec: { repeat: { check: { command: 'npm test' } } }, agentSeats: {} }
    } as unknown as Partial<LocalWorkflowHostSnapshot>)
    await expect(readyWorkflowFleetDispatch(PLACEMENT, withCheck)).rejects.toThrow(
      "This run checks each version with a command in this computer's workspace, which cannot run on mw0004 in this build. Choose 'this computer' to run here."
    )
  })

  it('refuses a host whose Claude is not signed in, naming the host and the login', async () => {
    await writeFile(join(fleet.host('mw0004').state, 'claude-signed-out'), '')
    await expect(readyWorkflowFleetDispatch(PLACEMENT, snapshot())).rejects.toThrow(
      "Claude is not signed in on mw0004 (claude auth status reports no login over SSH). Choose another host, or 'this computer'."
    )
  })

  it('refuses a seat model the host CLI is too old for, before anything runs there', async () => {
    const haiku55 = { ...seat('a', 'claude'), model: 'claude-haiku-5-5' }
    await expect(
      readyWorkflowFleetDispatch(
        PLACEMENT,
        snapshot({ seats: [haiku55, seat('b', 'codex')] } as Partial<LocalWorkflowHostSnapshot>)
      )
    ).rejects.toThrow(
      "Claude CLI on mw0004 is 2.1.285; claude-haiku-5-5 needs 2.1.293 or newer. Choose another host, or 'this computer'."
    )
    expect(await readdir(fleet.host('mw0004').home)).not.toContain('.omni-fleet')
  })

  it('refuses an API-key Codex login without repeating any of the key', async () => {
    await writeFile(join(fleet.host('mw0004').state, 'codex-api-key'), '')
    const refusal = await readyWorkflowFleetDispatch(PLACEMENT, snapshot(CODEX_ONLY)).catch(
      (error: Error) => error.message
    )
    expect(refusal).toContain('Codex on mw0004 is signed in with an API key')
    expect(refusal).not.toContain('sk-')
  })

  it('refuses an unreachable host by name', async () => {
    await writeFile(join(fleet.host('mw0004').state, 'lost'), '')
    await expect(readyWorkflowFleetDispatch(PLACEMENT, snapshot())).rejects.toThrow(
      'mw0004 could not report its CLIs and logins (ssh: connect to host mw0004 port 22: Operation timed out).'
    )
  })

  it('creates the run folder under the host home and freezes what seats are denied', async () => {
    const placed = await readyWorkflowFleetDispatch(PLACEMENT, snapshot({ access: undefined }), {
      id: () => 'run-1'
    })
    const home = await realpath(fleet.host('mw0004').home)
    expect(placed).toEqual({
      ...PLACEMENT,
      dispatch: {
        root: `${home}/${WORKFLOW_FLEET_RUNS_FOLDER}/run-1`,
        home,
        hidden: expect.arrayContaining([home])
      }
    })
    expect(await readdir(join(home, WORKFLOW_FLEET_RUNS_FOLDER, 'run-1'))).toEqual(['attempts'])
  })

  it('copies what agents read to the host, leaving credentials, packages and .git here', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'omni-fleet-workspace-')))
    folders.push(workspace)
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'queue.ts'), 'export const queue = 1\n')
    await writeFile(join(workspace, 'README.md'), '# Throwaway\n')
    const document = 'Repeated source documentation\n'.repeat(10_000)
    await writeFile(join(workspace, 'guide.md'), document)
    await writeFile(join(workspace, '.env'), 'TOKEN=secret\n')
    await mkdir(join(workspace, 'node_modules', 'left'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'left', 'index.js'), '')
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, '.git', 'config'), '[remote]\n')
    const placed = await readyWorkflowFleetDispatch(
      PLACEMENT,
      snapshot({
        access: 'workspace-read',
        host: { workspaceRoot: { path: workspace, device: '1', inode: '1' } }
      } as Partial<LocalWorkflowHostSnapshot>),
      {
        id: () => 'run-2',
        run: async (spec) => {
          if (spec.program === 'scp') {
            const archive = await readFile(spec.args![spec.args!.length - 2]!)
            expect([...archive.subarray(0, 2)]).toEqual([0x1f, 0x8b])
            expect(archive.length).toBeLessThan(Buffer.byteLength(document) / 10)
          }
          return runProcess(spec)
        }
      }
    )
    const copy = placed.dispatch!.workspace!
    expect(copy).toMatchObject({
      files: 3,
      bytes: 35 + Buffer.byteLength(document),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(copy.path).toBe(`${placed.dispatch!.root}/workspace`)
    expect((await readdir(copy.path)).sort()).toEqual(['README.md', 'guide.md', 'src'])
    expect(await readFile(join(copy.path, 'guide.md'), 'utf8')).toBe(document)
    expect(await readFile(join(copy.path, 'src', 'queue.ts'), 'utf8')).toBe(
      'export const queue = 1\n'
    )
  })
})

describe('refused admission cleanup', () => {
  it('removes the run root when workspace preparation fails after mkdir', async () => {
    const base = snapshot({ access: 'workspace-read' })
    await expect(
      readyWorkflowFleetDispatch(PLACEMENT, base, { id: () => 'copy-failed' })
    ).rejects.toThrow('no frozen folder')
    const roots = await readdir(join(fleet.host('mw0004').home, WORKFLOW_FLEET_RUNS_FOLDER))
    expect(roots).not.toContain('copy-failed')
  })
})
