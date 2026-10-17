import { translate } from '@/i18n/i18n'
import type { WorkflowGuide } from './workflow-guide'

export function auditGuide(): WorkflowGuide {
  return {
    what: translate(
      'localWorkflow.guide.audit.what',
      'Reads a collection of dated records, groups recurring problems and checks the quoted evidence before comparing plans to address them.'
    ),
    useWhen: [
      translate(
        'localWorkflow.guide.audit.when1',
        'To find repeated friction across conversations'
      ),
      translate('localWorkflow.guide.audit.when2', 'To turn a collection of records into a plan')
    ],
    steps: [
      translate(
        'localWorkflow.guide.audit.step1',
        'Choose a prepared records file on this computer.'
      ),
      translate(
        'localWorkflow.guide.audit.step2',
        'AIs read different parts, compare overlapping findings and look for missed problems.'
      ),
      translate(
        'localWorkflow.guide.audit.step3',
        'Quoted passages are checked against the file. Other AIs challenge the evidence and impact.'
      ),
      translate(
        'localWorkflow.guide.audit.step4',
        'Three plans are compared, then the report is reviewed and revised when needed.'
      )
    ],
    youGet: translate(
      'localWorkflow.guide.audit.youGet',
      'A report with supported findings, unresolved questions, dropped claims and a recommended plan.'
    )
  }
}
