import { launchAgentInWebHostTab } from './launch-agent-web-host-tab'
import type { LaunchAgentInNewTabResult } from './launch-agent-in-new-tab-types'

/** Keeps delivery and creation verdicts separate for background grid submissions. */
export function launchWebHostAgentTab(
  args: Parameters<typeof launchAgentInWebHostTab>[0],
  reservedConversationTabId?: string
): LaunchAgentInNewTabResult {
  const delivery = launchAgentInWebHostTab(args)
  return {
    tabId: null,
    startupPlan: args.startupPlan,
    ...(args.submissionId
      ? {
          launchOutcome: delivery.then((result) =>
            result.launched
              ? ('started' as const)
              : result.creationUnverifiable
                ? ('uncertain' as const)
                : ('failed' as const)
          )
        }
      : {}),
    ...(reservedConversationTabId
      ? { launchCompletion: delivery.then((result) => result.launched === true) }
      : {}),
    pasteDraftAfterLaunch: args.pastePromptAfterReady !== null,
    ...(args.pastePromptAfterReady !== null && args.promptDelivery === 'submit-after-ready'
      ? {
          promptDeliveryResult: delivery.then(({ delivered, failureNotified }) => ({
            delivered,
            failureNotified
          }))
        }
      : {})
  }
}
