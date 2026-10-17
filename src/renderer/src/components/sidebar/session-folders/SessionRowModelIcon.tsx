import { useAppStore } from '@/store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  PROVIDER_ICON_LABELS,
  ProviderIcon,
  providerIconIdForModel
} from '@/lib/provider-icon-catalog'

/**
 * A small, muted provider mark after the row's name: Claude, OpenAI/Codex, Meta/Muse, Gemini,
 * OpenRouter, xAI.
 * The live model wins over the agent, so an OMP pane routed through `openrouter/…` shows OpenRouter.
 * Unrecognised agents show nothing rather than a guess.
 */
export function SessionRowModelIcon({
  session
}: {
  session: Pick<SidebarSession, 'agent' | 'paneKey'>
}): React.JSX.Element | null {
  // Why: a primitive selector, so only a change to this pane's model re-renders the row.
  const model = useAppStore((state) =>
    session.paneKey ? state.agentStatusByPaneKey?.[session.paneKey]?.model : undefined
  )
  const id = providerIconIdForModel(model) ?? providerIconIdForModel(session.agent)
  if (!id) {
    return null
  }
  const label = PROVIDER_ICON_LABELS[id]
  return (
    // Why hidden on hover: the ✎ shows then, and the name keeps the width both would take.
    <span
      className="ml-1 inline-flex shrink-0 items-center opacity-60 grayscale-[35%] can-hover:group-hover:hidden"
      data-session-row-model={id}
      title={model ? `${label} · ${model}` : label}
      aria-label={label}
      role="img"
    >
      <ProviderIcon id={id} size={11} />
    </span>
  )
}
