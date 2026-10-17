import { resolveNativeChatOwnerLeafId } from './native-chat-leaf-routing'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { useNativeChatLeafState } from './native-chat-leaf-state'
import { switchNativeChatView } from './switch-native-chat-view'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import React from 'react'
import { MessageSquare, SquareTerminal } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { nativeChatEnabledByPreference } from '../../../../shared/native-chat-preference'
import {
  findUnifiedTabIdForTerminalTab,
  resolveNativeChatTabToggle
} from './native-chat-tab-toggle'

/**
 * Chat / Terminal for one agent tab, visible wherever that session is shown. Only the
 * tab's view changes: the same PTY, agent process, draft and history stay in place.
 * When chat cannot render the session, Chat stays visible but disabled with the reason.
 */
export function NativeChatViewSwitch({
  worktreeId,
  unifiedTabId,
  terminalTabId,
  paneKey
}: {
  worktreeId: string | null
  unifiedTabId?: string | null
  /** For surfaces that only know the backing terminal tab (Attention panes). */
  paneKey?: string
  terminalTabId?: string | null
}): React.JSX.Element | null {
  const pane = paneKey ? parsePaneKey(paneKey) : null
  const chatLeafId = useNativeChatLeafState((state) =>
    pane ? state.nativeChatLeafByTabId[pane.tabId] : null
  )
  const toggle = useAppStore(
    useShallow((state) => {
      if (!worktreeId) {
        return null
      }
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === unifiedTabId)
      if (tab?.contentType === 'agent-session') {
        return { id: tab.id, isChat: true, eligible: true, terminalDisabled: true }
      }
      const mappedTabId = terminalTabId
        ? findUnifiedTabIdForTerminalTab(state, worktreeId, terminalTabId)
        : null
      const resolved =
        (unifiedTabId
          ? resolveNativeChatTabToggle(state, worktreeId, unifiedTabId, pane?.leafId)
          : null) ??
        (mappedTabId
          ? resolveNativeChatTabToggle(state, worktreeId, mappedTabId, pane?.leafId)
          : null)
      // Why: a plain shell has no conversation to render; the switch would only be noise there.
      return resolved && (resolved.hasAgent || resolved.isChat)
        ? {
            id: resolved.unifiedTabId,
            isChat:
              resolved.isChat &&
              (!pane ||
                pane.leafId ===
                  resolveNativeChatOwnerLeafId(
                    chatLeafId,
                    state.terminalLayoutsByTabId[pane.tabId]
                  )),
            eligible: resolved.eligible,
            terminalDisabled: false
          }
        : null
    })
  )
  const chatUiOn = useAppStore((state) => nativeChatEnabledByPreference(state.settings))
  if (!toggle) {
    return null
  }
  const chatDisabledReason = chatUiOn
    ? translate(
        'nativeChatSwitch.unsupported',
        'This session has no chat view here, so it stays in Terminal.'
      )
    : translate('nativeChatSwitch.chatUiOff', 'Turn on Chat UI in Settings › Experimental.')
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={toggle.isChat ? 'chat' : 'terminal'}
      data-native-chat-switch={toggle.isChat ? 'chat' : 'terminal'}
      aria-label={translate('nativeChatSwitch.label', 'Session view')}
      onValueChange={(value) => {
        if (worktreeId && (value === 'chat' || value === 'terminal')) {
          switchNativeChatView(worktreeId, toggle.id, value, {
            paneKey: pane ? paneKey : undefined
          })
        }
      }}
    >
      <ToggleGroupItem
        value="chat"
        className="h-6 gap-1 px-2 text-[11px]"
        disabled={!toggle.eligible && !toggle.isChat}
        title={toggle.eligible || toggle.isChat ? undefined : chatDisabledReason}
      >
        <MessageSquare className="size-3" />
        {translate('nativeChatSwitch.chat', 'Chat')}
      </ToggleGroupItem>
      {toggle.terminalDisabled ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value="terminal"
              aria-disabled="true"
              onClick={(event) => {
                event.preventDefault()
              }}
              className="h-6 gap-1 px-2 text-[11px] aria-disabled:opacity-50"
            >
              <SquareTerminal className="size-3" />
              {translate('nativeChatSwitch.terminal', 'Terminal')}
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>
            {translate('nativeChatSwitch.noTerminal', 'This conversation runs without a terminal.')}
          </TooltipContent>
        </Tooltip>
      ) : (
        <ToggleGroupItem value="terminal" className="h-6 gap-1 px-2 text-[11px]">
          <SquareTerminal className="size-3" />
          {translate('nativeChatSwitch.terminal', 'Terminal')}
        </ToggleGroupItem>
      )}
    </ToggleGroup>
  )
}
