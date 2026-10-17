import { renameTabByPerson } from '@/lib/session-title-change'
import { useShallow } from 'zustand/react/shallow'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import type { TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import { useTabGroupItemProjections } from './useTabGroupItemProjections'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'
import { useTabGroupActivationCommands } from './useTabGroupActivationCommands'
import { useTabGroupCreationCommands } from './useTabGroupCreationCommands'

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: NonNullable<
  ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
> = {}

export function useTabGroupWorkspaceModel({
  groupId,
  worktreeId
}: {
  groupId: string
  worktreeId: string
}) {
  const unifiedTabs = useAppStore(
    useShallow((state) =>
      (state.unifiedTabsByWorktree[worktreeId] ?? []).filter((tab) => tab.groupId === groupId)
    )
  )
  const worktreeState = useAppStore(
    useShallow((state) => ({
      // Why: reuse stable EMPTY_* fallbacks; fresh `?? []` arrays break Zustand v5 snapshot identity and cause an infinite render loop.
      // Rule: `useShallow` compares one level deep, so anything nested in the returned object must be a stable
      // reference — a module-level `EMPTY_*` constant, never `?? []`, `?? {}`, `.map(...)`, `Object.values(...)` or a
      // literal. A fresh TOP-level array of stable members is fine (shallow compares iterables element-wise).
      // Enforced by `pnpm run check:reliability-gates` (config/scripts/check-use-shallow-fresh-references.mjs) and at
      // test time by config/scripts/vitest-fail-on-react-getsnapshot-loop.ts; opt a justified line out with
      // `// useShallow-fresh-ref-ok: <reason>`. Selectors passed by name (`useShallow(selectX)`) are not scanned, so
      // keep their fallbacks on EMPTY_* constants too (see attention-current-surface.ts, React #185 in 1.9.3).
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      unifiedTabs,
      terminalTabs: state.tabsByWorktree[worktreeId] ?? EMPTY_TERMINAL_TABS,
      openFiles: state.openFiles,
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      expandedPaneByTabId: state.expandedPaneByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID,
      generatedTabTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
      mobileEmulatorEnabled: state.settings?.mobileEmulatorEnabled !== false
    }))
  )

  const focusGroup = useAppStore((state) => state.focusGroup)
  const makePreviewFilePermanent = useAppStore((state) => state.makePreviewFilePermanent)
  const pinFile = useAppStore((state) => state.pinFile)
  const setTabColor = useAppStore((state) => state.setTabColor)

  const {
    group,
    groupTabs,
    activeTab,
    terminalTabs,
    editorItems,
    browserItems,
    agentSessionItems,
    tabBarOrder
  } = useTabGroupItemProjections({ groupId, worktreeId, worktreeState })

  const { closeItem, closeMany, leaveWorktreeIfEmpty } = useTabGroupTabCloseCommands({
    worktreeId,
    groupTabs
  })

  const {
    closeGroup,
    closeAllEditorTabsInGroup,
    closeAllBrowserTabsInGroup,
    closeOthers,
    closeToRight,
    closeToLeft
  } = useTabGroupCloseScopeCommands({
    groupId,
    worktreeId,
    group,
    groupTabs,
    closeItem,
    closeMany,
    leaveWorktreeIfEmpty
  })

  const {
    activateTerminal,
    toggleTerminalPaneExpand,
    activateEditor,
    activateBrowser,
    activateAgentSession
  } = useTabGroupActivationCommands({ groupId, worktreeId, groupTabs, worktreeState })

  const creationCommands = useTabGroupCreationCommands({ groupId, worktreeId, worktreeState })

  return {
    group,
    activeTab,
    browserItems,
    editorItems,
    agentSessionItems,
    terminalTabs,
    tabBarOrder,
    groupTabs,
    expandedPaneByTabId: worktreeState.expandedPaneByTabId,
    commands: {
      focusGroup: () => {
        focusGroup(worktreeId, groupId)
      },
      activateAgentSession,
      activateBrowser,
      activateEditor,
      activateTerminal,
      closeAllEditorTabsInGroup,
      closeAllBrowserTabsInGroup,
      closeGroup,
      closeItem,
      closeOthers,
      closeToRight,
      closeToLeft,
      ...creationCommands,
      makePreviewFilePermanent,
      pinFile,
      setTabColor,
      setTabCustomTitle: renameTabByPerson,
      toggleTerminalPaneExpand
    }
  }
}
