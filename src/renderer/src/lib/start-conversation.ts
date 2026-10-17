import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveDefaultAgentForNewTab } from './agent-tab-shortcuts'

/**
 * Starting a conversation with one click, from the place the person is already in.
 *
 * Why this exists: every other way into a session made someone choose something
 * first — the tab bar's "+" opens a menu of agents, and the sidebar's "+" opens the
 * workspace composer, which will not proceed without a repo or a folder. Neither
 * reads as "start a chat", and the composer one is not even visible unless the
 * Developer Workspaces surface is showing. So the answer to "where do I begin" was
 * a menu, a form, or nothing at all.
 */
export type ConversationStartTarget =
  | { ok: true; agent: TuiAgent; worktreeId: string; groupId: string | undefined }
  | { ok: false; reason: 'no-workspace' | 'no-agent' }

/**
 * Where a new conversation would start, or why it cannot. Pure so the refusals are
 * testable: the button explains itself instead of being mysteriously inert.
 */
export function resolveConversationStart(input: {
  activeWorktreeId: string | null | undefined
  activeGroupIdByWorktree: Record<string, string | undefined> | null | undefined
  groupsByWorktree: Record<string, readonly { id: string }[] | undefined> | null | undefined
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
  detectedAgentIds: readonly TuiAgent[] | null | undefined
  disabledTuiAgents: readonly TuiAgent[] | null | undefined
}): ConversationStartTarget {
  const worktreeId = input.activeWorktreeId
  if (!worktreeId) {
    return { ok: false, reason: 'no-workspace' }
  }
  const agent = resolveDefaultAgentForNewTab({
    defaultTuiAgent: input.defaultTuiAgent,
    detectedAgentIds: input.detectedAgentIds,
    disabledTuiAgents: input.disabledTuiAgents
  })
  if (!agent) {
    return { ok: false, reason: 'no-agent' }
  }
  return {
    ok: true,
    agent,
    worktreeId,
    // Why: land in the group the person is looking at; the first group is the fallback
    // for a workspace opened but never focused.
    groupId:
      input.activeGroupIdByWorktree?.[worktreeId] ?? input.groupsByWorktree?.[worktreeId]?.[0]?.id
  }
}
