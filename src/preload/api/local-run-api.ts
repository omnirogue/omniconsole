import type { LocalRunChangedPayload } from '../../shared/local-run-types'

export type LocalRunApi = {
  onChanged: (callback: (payload: LocalRunChangedPayload) => void) => () => void
}
