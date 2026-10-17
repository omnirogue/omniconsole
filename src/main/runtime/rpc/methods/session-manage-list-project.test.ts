import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionFolderRelayRequest } from '../../../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import {
  SESSION_MANAGE_RPC,
  type SessionManageListResult
} from '../../../../shared/session-manage-types'
import type { SessionParityPopulation } from '../../../../shared/session-parity'
import type { SessionProjectReadResult } from '../../../../shared/session-project-cli'
import { emptyProjectSettings } from '../../../../shared/project-settings'
import { observeSources, sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import type { RpcContext } from '../core'

const relayed = vi.hoisted(() => ({
  options: [] as unknown[],
  rows: [] as SessionManageSidebarRow[]
}))
vi.mock('../../../session-manage/session-manage-runtime-actions', async (actual) => ({
  ...(await actual<object>()),
  readSidebarRows: async (_runtime: unknown, options: unknown) => {
    relayed.options.push(options)
    return relayed.rows
  }
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => observeSources()
}))

const { SESSION_MANAGE_METHODS } = await import('./session-manage')
const list = SESSION_MANAGE_METHODS.find((entry) => entry.name === SESSION_MANAGE_RPC.list)!

const FOLDER = '11111111-1111-4111-8111-111111111111'
const ADS = { folderId: FOLDER, name: 'Ads', path: 'OmniRogue / Ads' }

function context(project: SessionProjectReadResult['project']): RpcContext {
  const requestSessionFolders = vi.fn(async (request: SessionFolderRelayRequest) => {
    // Session parity (C5): every list also asks for the unfiltered population; none here.
    if (request.kind === 'readParityPopulation') {
      return null
    }
    expect(request).toEqual({
      kind: 'readProject',
      folder: 'Ads / Research'
    })
    return {
      folder: {
        id: 'research',
        name: 'Research',
        path: 'OmniRogue / Ads / Research'
      },
      project
    } satisfies SessionProjectReadResult
  })
  return {
    runtime: {
      requestSessionFolders,
      listBackgroundRuntimeOwnedTerminals: () => null
    } as unknown as RpcContext['runtime']
  } as RpcContext
}

beforeEach(() => {
  relayed.options = []
  relayed.rows = [
    sidebarRow({
      rowKey: 'a',
      paneKey: 'tab-1:a',
      projectThread: { status: 'working', coordinator: false }
    }),
    sidebarRow({ rowKey: 'b', paneKey: 'tab-1:b' })
  ]
})

describe('sessionManage.list --project', () => {
  it("asks the window for the enclosing project's threads and lists only those", async () => {
    const result = (await list.handler(
      list.params!.parse({ project: 'Ads / Research' }),
      context({ ...ADS, settings: emptyProjectSettings(1) })
    )) as SessionManageListResult
    expect(relayed.options).toEqual([{ projectFolderId: FOLDER }])
    expect(result.sessions.map((entry) => [entry.paneKey, entry.projectStatus])).toEqual([
      ['tab-1:a', 'working']
    ])
    expect(result.scope?.project).toEqual(ADS)
  })

  it('refuses a folder that is in no project, before reading the sidebar', async () => {
    await expect(
      list.handler(list.params!.parse({ project: 'Ads / Research' }), context(null))
    ).rejects.toThrow('“OmniRogue / Ads / Research” is not in a project.')
    expect(relayed.options).toEqual([])
  })

  it('refuses a project folder nobody set up yet', async () => {
    await expect(
      list.handler(
        list.params!.parse({ project: 'Ads / Research' }),
        context({ ...ADS, settings: null })
      )
    ).rejects.toThrow('“OmniRogue / Ads” is not a project yet.')
  })

  it('reads the sidebar as before without --project', async () => {
    const result = (await list.handler(
      list.params!.parse({}),
      context(null)
    )) as SessionManageListResult
    expect(relayed.options).toEqual([{}])
    expect(result.sessions).toHaveLength(2)
    expect(result.scope).not.toHaveProperty('project')
  })
})

describe('sessionManage.list parity population (session parity, step 8)', () => {
  const POPULATION: SessionParityPopulation = {
    rows: [
      {
        hostId: 'local',
        worktreeId: 'repo::/w',
        kind: 'terminal',
        agent: 'claude',
        archived: false,
        label: 'Session',
        bucket: 'ownerListed',
        verification: 'verified',
        identity: 'c:a1b2c3d4e5f60718293a4b5c',
        conversation: 'a1b2c3d4e5f60718293a4b5c',
        rest: 'live'
      }
    ],
    countsByHost: [
      {
        hostId: 'local',
        count: 1,
        ownerListed: 1,
        heldByOwner: 0,
        receiverOnly: 0,
        workflow: 0,
        unverified: 0,
        stale: 0,
        archived: 0
      }
    ],
    ownerLedgers: []
  }

  function windowWith(population: unknown): RpcContext {
    return {
      runtime: {
        requestSessionFolders: vi.fn(async (request: SessionFolderRelayRequest) =>
          request.kind === 'readParityPopulation' ? population : undefined
        ),
        listBackgroundRuntimeOwnedTerminals: () => null
      } as unknown as RpcContext['runtime']
    } as RpcContext
  }

  it("carries each entry's bucket and the unfiltered population, whatever the filters list", async () => {
    relayed.rows = [
      sidebarRow({
        rowKey: 'a',
        paneKey: 'tab-1:a',
        bucket: 'ownerListed',
        ownerListed: true,
        verification: 'verified',
        identity: 'c:a1b2c3d4e5f60718293a4b5c',
        conversation: 'a1b2c3d4e5f60718293a4b5c',
        rest: 'live'
      }),
      sidebarRow({
        rowKey: 'b',
        paneKey: 'tab-1:b',
        archived: true,
        bucket: 'receiverOnly',
        verification: 'unverified',
        identity: null,
        conversation: null,
        bucketReason: 'no-identity'
      })
    ]
    const result = (await list.handler(
      list.params!.parse({ parity: true }),
      windowWith(POPULATION)
    )) as SessionManageListResult
    // The archived row is filtered out of the list; the population is the window's own unfiltered
    // export (here a fixture), read only because the caller asked for it.
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      paneKey: 'tab-1:a',
      bucket: 'ownerListed',
      verification: 'verified',
      identity: 'c:a1b2c3d4e5f60718293a4b5c',
      conversation: 'a1b2c3d4e5f60718293a4b5c',
      rest: 'live'
    })
    expect(result.sessions[0]).not.toHaveProperty('ownerListed')
    expect(result.parity).toEqual(POPULATION)
  })

  it('reports no population, rather than an empty one, when the window cannot tell', async () => {
    for (const answer of [null, undefined, [], { rows: [] }]) {
      const result = (await list.handler(
        list.params!.parse({ parity: true }),
        windowWith(answer)
      )) as SessionManageListResult
      expect(result).not.toHaveProperty('parity')
    }
  })

  it('neither reads nor carries the population unless the caller asks (the CLI resolvers never do)', async () => {
    const context = windowWith(POPULATION)
    const result = (await list.handler(list.params!.parse({}), context)) as SessionManageListResult
    expect(result).not.toHaveProperty('parity')
    const asked = (
      context.runtime.requestSessionFolders as ReturnType<typeof vi.fn>
    ).mock.calls.map(([request]) => (request as SessionFolderRelayRequest).kind)
    expect(asked).not.toContain('readParityPopulation')
  })
})
