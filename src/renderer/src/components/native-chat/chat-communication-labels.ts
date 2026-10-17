import { translate } from '@/i18n/i18n'
import type { CommunicationType } from '../../../../shared/communication-type'

export function waitingForAgentLabel(person: string): string {
  return translate('chatDelivery.waitingForAgent', 'Waiting for {{person}}’s agent', { person })
}

export function communicationLabel(type: CommunicationType): string {
  switch (type) {
    case 'decision':
      return translate('chatDelivery.decision', 'Decision')
    case 'request':
      return translate('chatDelivery.request', 'Request')
    case 'question':
      return translate('chatDelivery.question', 'Question')
    case 'plan':
      return translate('chatDelivery.plan', 'Plan')
    case 'information':
      return translate('chatDelivery.information', 'Information')
  }
}

export function communicationExpectationLabel(type: CommunicationType): string {
  switch (type) {
    case 'decision':
      return translate('chatDelivery.expectDecision', 'Choose an option')
    case 'request':
      return translate('chatDelivery.expectRequest', 'Take action')
    case 'question':
      return translate('chatDelivery.expectQuestion', 'Reply')
    case 'plan':
      return translate('chatDelivery.expectPlan', 'Review the plan')
    case 'information':
      return translate('chatDelivery.expectInformation', 'No response needed')
  }
}
