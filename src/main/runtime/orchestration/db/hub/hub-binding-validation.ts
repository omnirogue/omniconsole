export function validateHubBinding(binding: {
  hubTaskId?: string
  hubStateRevision?: number
}): void {
  if (binding.hubTaskId !== undefined && !HUB_TASK_ID_PATTERN.test(binding.hubTaskId)) {
    throw new Error('A hub binding requires a valid omnios card id.')
  }
  if (
    binding.hubStateRevision !== undefined &&
    (!binding.hubTaskId ||
      !Number.isSafeInteger(binding.hubStateRevision) ||
      binding.hubStateRevision < 0)
  ) {
    throw new Error('A hub revision requires a card id and a nonnegative safe integer.')
  }
}
import { HUB_TASK_ID_PATTERN } from '../../../../../shared/omnios-task-binding'
