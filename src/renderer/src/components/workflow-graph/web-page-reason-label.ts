import { translate } from '@/i18n/i18n'
import type { WebPageReason } from '../../../../shared/web-page-reason'
import type {
  WorkflowWebPageProblem,
  WorkflowWebRefusal
} from '../../../../shared/workflow-web-pages'
import {
  WORKFLOW_WEB_MAX_STEP_URLS,
  WORKFLOW_WEB_MAX_URLS
} from '../../../../shared/workflow-graph-web'

function statusLabel(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return translate('workflowGraph.web.reason.statusRefused', 'the site refused ({{status}})', {
      status
    })
  }
  if (status === 404 || status === 410) {
    return translate(
      'workflowGraph.web.reason.statusNotFound',
      'the page was not found ({{status}})',
      {
        status
      }
    )
  }
  return status === undefined
    ? translate('workflowGraph.web.reason.statusUnknown', 'the site answered with an error')
    : translate('workflowGraph.web.reason.status', 'the site answered {{status}}', { status })
}

/** Completes "could not be read: …"; the status and media type were checked by the host. */
export function webPageReasonLabel(reason: WebPageReason | undefined): string {
  if (!reason) {
    return translate('workflowGraph.web.reason.unknown', 'the reason was not recorded')
  }
  switch (reason.code) {
    case 'scheme':
      return translate('workflowGraph.web.reason.scheme', 'it is not an http or https web address')
    case 'credentials':
      return translate(
        'workflowGraph.web.reason.credentials',
        'the address carries a user name or password'
      )
    case 'port':
      return translate('workflowGraph.web.reason.port', 'only ports 80 and 443 are read')
    case 'private-address':
      return translate(
        'workflowGraph.web.reason.private-address',
        'the address points at this computer or a private network'
      )
    case 'dns':
      return translate('workflowGraph.web.reason.dns', 'the site name could not be found')
    case 'timeout':
      return reason.limit === 'call'
        ? translate(
            'workflowGraph.web.reason.timeoutCall',
            'the 90 seconds for reading all the pages ran out first'
          )
        : translate('workflowGraph.web.reason.timeout', 'the site did not answer within 15 seconds')
    case 'too-large':
      return translate('workflowGraph.web.reason.too-large', 'the page is larger than 2 MB')
    case 'content-type':
      return reason.contentType
        ? translate(
            'workflowGraph.web.reason.content-type',
            'the page is {{type}}, which is not read as text',
            { type: reason.contentType }
          )
        : translate(
            'workflowGraph.web.reason.contentTypeUnknown',
            'the page did not say it is text'
          )
    case 'status':
      return statusLabel(reason.status)
    case 'redirects':
      return translate(
        'workflowGraph.web.reason.redirects',
        'the site redirected more than 5 times or in a loop'
      )
    case 'insecure-redirect':
      return translate(
        'workflowGraph.web.reason.insecure-redirect',
        'the site redirected from https to plain http'
      )
    case 'tls':
      return translate(
        'workflowGraph.web.reason.tls',
        "the site's secure connection could not be verified"
      )
    case 'proxy':
      return translate(
        'workflowGraph.web.reason.proxy',
        'a proxy is set up, and pages are only read directly'
      )
    case 'network':
      return translate(
        'workflowGraph.web.reason.network',
        'the connection failed or the page arrived damaged'
      )
    case 'empty':
      return translate(
        'workflowGraph.web.reason.empty',
        'no readable text could be taken from the page'
      )
  }
}

/** Why an address cannot join the list, before anything is fetched. */
export function webPageProblemLabel(problem: WorkflowWebPageProblem): string {
  switch (problem.code) {
    case 'address':
      return translate(
        'workflowGraph.web.field.cannotRead',
        'This address can’t be read: {{why}}.',
        {
          why: webPageReasonLabel(problem.reason)
        }
      )
    case 'too-long':
      return translate('workflowGraph.web.field.tooLong', 'This address is too long to read.')
    case 'listed':
      return translate('workflowGraph.web.field.listed', 'This page is already listed.')
    case 'step-limit':
      return translate(
        'workflowGraph.web.field.stepLimit',
        'A step reads at most {{count}} pages.',
        {
          count: WORKFLOW_WEB_MAX_STEP_URLS
        }
      )
    case 'run-limit':
      return translate(
        'workflowGraph.web.field.runLimit',
        'A workflow reads at most {{count}} pages.',
        { count: WORKFLOW_WEB_MAX_URLS }
      )
  }
}

/** The plain reason a step cannot read pages; it mirrors what validation would refuse. */
export function workflowWebRefusalLabel(refusal: WorkflowWebRefusal): string {
  switch (refusal.code) {
    case 'judge':
      return translate(
        'workflowGraph.web.refusal.judge',
        'Only a Do step reads pages. Reviews, rankings and syntheses see only what the readers wrote.'
      )
    case 'find':
      return translate('workflowGraph.web.refusal.find', 'Find the best can’t read pages yet.')
    case 'plateau':
      return translate(
        'workflowGraph.web.refusal.plateau',
        'This step writes the versions the judges compare, so it can’t read pages. Read them in a Do step before it.'
      )
    case 'openrouter':
      return translate(
        'workflowGraph.web.refusal.openrouter',
        'Reading pages isn’t available with OpenRouter models yet: a provider may browse on its own side.'
      )
    case 'ollama':
      return translate(
        'workflowGraph.web.refusal.ollama',
        'Reading pages isn’t available with Ollama models yet: it has not been measured with local models.'
      )
    case 'rubric':
      return translate(
        'workflowGraph.web.refusal.rubric',
        '{{step}} scores by a rubric a model writes (from {{from}}). A workflow that reads pages needs a rubric you write.',
        { step: refusal.step, from: refusal.from }
      )
    case 'skeptic':
      return translate(
        'workflowGraph.web.refusal.skeptic',
        'The final check is written by a model (from {{from}}). A workflow that reads pages can’t have that.',
        { from: refusal.from }
      )
  }
}
