import { launchAgentInNewTab, type LaunchAgentInNewTabResult } from '@/lib/launch-agent-in-new-tab'
import { resolveSessionActorLaunch } from '@/lib/session-actor'
import { useAppStore } from '@/store'
import {
  attentionLaunchPromptDelivery,
  buildAttentionLaunchPrompt,
  type AttentionLaunchPlan
} from '../../../../shared/attention-launch-favorites'
import { createRepeatLaunchGuard } from './attention-launch-repeat-guard'

export type AttentionFavoriteLaunchResult =
  | { ok: true; tabId: string | null }
  | { ok: false; reason: 'blocked' | 'repeat' | 'launch-failed' }

const repeatGuard = createRepeatLaunchGuard()

/**
 * The one launch path for every Attention entry point, favourites and plain provider
 * buttons alike. It only resolves the saved actor and hands off to launchAgentInNewTab,
 * which owns prompt delivery, SSH/paired hosts and the new tab's view mode.
 */
export function launchAttentionFavorite(args: {
  plan: AttentionLaunchPlan
  worktreeId: string
  request: string
  /** Requested tab id; an assisted-brief Start uses it to find its session after a restart. */
  tabId?: string
}): AttentionFavoriteLaunchResult {
  const { plan, worktreeId } = args
  const { favorite } = plan
  // Why: until detection has checked the host the CLI may be absent, so a launch waits too.
  if (plan.blockers.length > 0 || plan.detectionPending) {
    return { ok: false, reason: 'blocked' }
  }
  const repeatKey = `${worktreeId} ${favorite.id}`
  if (!repeatGuard.tryAcquire(repeatKey, Date.now())) {
    return { ok: false, reason: 'repeat' }
  }
  const { launchEnv } = resolveSessionActorLaunch(useAppStore.getState().settings, favorite.agent, {
    accountChoiceId: favorite.accountChoiceId ?? null
  })
  const prompt = buildAttentionLaunchPrompt(favorite, args.request)
  let result: LaunchAgentInNewTabResult = null
  try {
    result = launchAgentInNewTab({
      agent: favorite.agent,
      worktreeId,
      ...(prompt
        ? { prompt, promptDelivery: attentionLaunchPromptDelivery(favorite.agent, prompt) }
        : {}),
      launchSource: 'attention_launcher',
      launchPreferences: plan.launchPreferences ?? null,
      launchEnv,
      viewModePreference: plan.view.mode,
      ...(args.tabId ? { tabId: args.tabId } : {})
    })
  } finally {
    // Why: only a started session may hold the key; otherwise the retry click is refused.
    if (!result) {
      repeatGuard.release(repeatKey)
    }
  }
  // Why: a readiness timeout already shows its own notice; a transport error must not go unhandled.
  void result?.promptDeliveryResult?.catch((error: unknown) =>
    console.error('Attention launch prompt delivery failed', error)
  )
  return result ? { ok: true, tabId: result.tabId } : { ok: false, reason: 'launch-failed' }
}
