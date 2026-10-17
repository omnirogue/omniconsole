import { communicationLabel } from '@/components/native-chat/chat-communication-labels'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { workKindLabel } from './backoffice-work-labels'

export function workRowKindLabel(row: WorkRow): string {
  const type = row.thread?.communication_type ?? row.message?.communication_type
  return type ? communicationLabel(type) : workKindLabel(row.kind)
}
