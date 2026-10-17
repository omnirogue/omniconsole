import { parsePaneKey } from '../../../../shared/stable-pane-id'

/** The first thing a person types into or picks from inside a block's detail form. */
const FIRST_FIELD_SELECTOR =
  'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, [role="combobox"]'

/** Marks the chat composer's own textarea, so the chain can hand focus back to it. */
export const CONVERSATION_INPUT_ATTRIBUTE = 'data-native-chat-composer-input'

function focus(element: HTMLElement | null | undefined): boolean {
  if (!element || (element as HTMLInputElement).disabled) {
    return false
  }
  element.focus()
  return element.ownerDocument.activeElement === element
}

/**
 * Keyboard loop, first half (brief 78 #8): + Prompt / + Agent Review / + Agent Handoff /
 * + Person open the new block,
 * and this puts the caret in its first field so the person types instead of clicking again.
 */
export function focusFirstBlockField(root: ParentNode | null, blockId: string): boolean {
  const id = blockId.replace(/["\\]/g, '\\$&')
  const block = root?.querySelector<HTMLElement>(`[data-up-next-block="${id}"]`)
  return focus(block?.querySelector<HTMLElement>(FIRST_FIELD_SELECTOR))
}

/**
 * Keyboard loop, second half: after Queue / Send now / Finish now, focus returns to the
 * conversation's one input — the chat composer when the pane shows Chat, the terminal when it
 * shows Terminal. The chain sits in one of two hosts that have such an input: the structured
 * chat root (the composer is inside it) and the PTY work rail (a sibling of the terminal
 * container, whose pane holds both the terminal and the chat shell). A popover or a card mount
 * has no input to return to, so nothing moves.
 */
export function focusConversationInput(from: Element | null): boolean {
  const chatRoot = from?.closest<HTMLElement>('[data-native-chat-root]')
  if (chatRoot) {
    return focus(chatRoot.querySelector<HTMLElement>(`[${CONVERSATION_INPUT_ATTRIBUTE}]`))
  }
  const rail = from?.closest<HTMLElement>('[data-session-work-rail]')
  const leafId = parsePaneKey(rail?.getAttribute('data-session-work-rail') ?? '')?.leafId
  const pane = leafId
    ? rail?.parentElement?.querySelector<HTMLElement>(`[data-leaf-id="${leafId}"]`)
    : null
  if (!pane) {
    return false
  }
  // Why the aria-hidden test: the chat shell stays mounted (display: none) behind Terminal.
  const composer = pane.querySelector<HTMLElement>(
    `.native-chat-pane-shell:not([aria-hidden="true"]) [${CONVERSATION_INPUT_ATTRIBUTE}]`
  )
  return focus(composer ?? pane.querySelector<HTMLElement>('.xterm-helper-textarea'))
}
