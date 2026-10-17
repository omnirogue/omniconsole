import { PromptEngineerButton } from './PromptEngineerButton'
import { PromptEngineerStatus } from './PromptEngineerStatus'
import type { usePromptEngineer } from './use-prompt-engineer'

export function nativeChatPromptEngineerFields(
  engineer: ReturnType<typeof usePromptEngineer>,
  disabled: boolean,
  focus: () => void,
  onGo: () => void
) {
  return {
    promptEngineer: (
      <PromptEngineerButton
        active={engineer.active}
        disabled={disabled || engineer.pending}
        onToggle={() => {
          engineer.toggle()
          focus()
        }}
      />
    ),
    promptEngineerStatus: engineer.active ? (
      <PromptEngineerStatus
        disabled={disabled || engineer.pending || !engineer.canGo}
        onGo={onGo}
      />
    ) : null
  }
}
