import type { Page } from '@stablyai/playwright-test'

export const LABELS = ['Plan the release', 'Review the audit', 'Draft the changelog'] as const

// Why: three passive conversations (Codex, Claude, Codex) seeded as resume
// checkpoints — no agent or workflow launches during this rendered check.
export async function seedConversations(
  page: Page,
  folderPath: string,
  labels: readonly string[] = LABELS
) {
  await page.evaluate(
    ({ folderPath, labels }) => {
      const store = window.__store!
      const now = Date.now()
      const worktreeId = 'folder:bulk-selection-fixture'
      const agents = ['codex', 'claude'] as const
      const leafId = (index: number) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      const tabs = labels.map((label, index) => ({
        id: `bulk-tab-${index}`,
        worktreeId,
        ptyId: null,
        title: label,
        launchAgent: agents[index % agents.length],
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: now - index
      }))
      const layouts = Object.fromEntries(
        labels.map((_label, index) => [
          `bulk-tab-${index}`,
          {
            root: { type: 'leaf', leafId: leafId(index) },
            activeLeafId: leafId(index),
            expandedLeafId: null
          }
        ])
      )
      const records = Object.fromEntries(
        labels.map((label, index) => {
          const paneKey = `bulk-tab-${index}:${leafId(index)}`
          return [
            paneKey,
            {
              paneKey,
              tabId: `bulk-tab-${index}`,
              worktreeId,
              agent: agents[index % agents.length],
              providerSession: { key: 'session_id', id: `bulk-session-${index}` },
              prompt: label,
              state: 'done',
              capturedAt: now - index,
              updatedAt: now - index,
              origin: 'worktree-sleep',
              restoreOnTabOpenOnly: true
            }
          ]
        })
      )
      // Why the casts: the seed is built with map(), which widens the literal
      // discriminants the store types require ('leaf', 'session_id', 'done').
      store.setState({
        folderWorkspaces: [
          {
            id: 'bulk-selection-fixture',
            projectGroupId: 'bulk-selection-project',
            name: 'Bulk notes',
            folderPath,
            executionHostId: 'local',
            linkedTask: null,
            comment: '',
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: now,
            createdAt: now,
            updatedAt: now
          }
        ],
        tabsByWorktree: { [worktreeId]: tabs } as never,
        terminalLayoutsByTabId: layouts as never,
        sleepingAgentSessionsByPaneKey: records as never
      })
    },
    { folderPath, labels: [...labels] }
  )
}
