import { expect, it } from 'vitest'
import type { ArtifactSessionRecord } from '../../../shared/artifact-session'
import type { SessionLinkedDocsEntry } from '../../../shared/session-linked-docs'
import { sessionProjectLibrary } from './session-project-library'
import type { SessionProjectThread } from './session-project-threads'
import type { SessionProjectThreadOutput } from './session-project-thread-outputs'

const LEAF_A = '00000000-0000-4000-8000-00000000000a'
const LEAF_B = '00000000-0000-4000-8000-00000000000b'

function thread(tabId: string, leafId: string, label: string): SessionProjectThread {
  return {
    row: {
      session: {
        rowKey: label,
        sessionKey: null,
        worktreeId: 'wt',
        hostId: 'local',
        tabId,
        paneKey: `${tabId}:${leafId}`,
        kind: 'terminal',
        label,
        workspaceLabel: 'Ads',
        agent: 'claude',
        unavailable: false,
        folderKeyMigration: null
      },
      folderId: 'f',
      attention: null,
      state: 'done',
      waitingUntil: null
    },
    status: 'done',
    isCoordinator: false,
    agent: 'claude',
    lastActivityAt: null
  }
}

const brief = thread('tab-a', LEAF_A, 'Write the brief')
const fix = thread('tab-b', LEAF_B, 'Fix checkout')
const outputs = (t: SessionProjectThread): SessionProjectThreadOutput[] =>
  t === fix
    ? [
        {
          kind: 'review',
          label: '#12',
          url: 'https://github.com/o/r/pull/12',
          state: 'open',
          checks: 'success'
        },
        { kind: 'issue', label: 'ADS-1' }
      ]
    : []
const records: ArtifactSessionRecord[] = [
  {
    slug: 'brief-page',
    shareUrl: 'https://omnios.example/a/brief-page',
    sourceKey: 'brief.html',
    savedAt: 200,
    contentUrl: 'https://omnios.example/a/brief-page/content',
    origin: { paneKey: `tab-a:${LEAF_A}` }
  },
  {
    slug: 'elsewhere',
    shareUrl: 'https://omnios.example/a/elsewhere',
    sourceKey: 'x.html',
    savedAt: 999,
    contentUrl: 'https://omnios.example/a/elsewhere/content',
    origin: { paneKey: `tab-z:${LEAF_A}` }
  }
]
const linked: SessionLinkedDocsEntry[] = [
  {
    paneKey: `tab-b:${LEAF_B}`,
    apiOrigin: 'https://omnios.example',
    docs: [
      {
        kind: 'slite',
        id: 'plan123',
        url: 'https://team.slite.com/app/docs/plan123',
        seenAt: 300
      }
    ]
  }
]

it('lists each thread’s review, pages and docs with the thread they came from', () => {
  const items = sessionProjectLibrary([brief, fix], outputs, records, linked)
  expect(items.map((item) => [item.kind, item.label, item.thread.row.session.label])).toEqual([
    ['review', '#12', 'Fix checkout'],
    ['slite', 'plan123', 'Fix checkout'],
    ['artifact', 'brief-page', 'Write the brief']
  ])
})

it('leaves out pages other conversations published and issues, which are not outputs', () => {
  const items = sessionProjectLibrary(
    [brief],
    () => [{ kind: 'issue', label: 'ADS-1' }],
    records,
    []
  )
  expect(items.map((item) => item.label)).toEqual(['brief-page'])
})
