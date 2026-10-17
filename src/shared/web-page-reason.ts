export const WEB_PAGE_REASON_CODES = [
  'scheme',
  'credentials',
  'port',
  'private-address',
  'dns',
  'timeout',
  'too-large',
  'content-type',
  'status',
  'redirects',
  'insecure-redirect',
  'tls',
  'proxy',
  'network',
  'empty'
] as const

export type WebPageReasonCode = (typeof WEB_PAGE_REASON_CODES)[number]

/** Why a page could not be read. Never a success: every reader of a reason treats the page as absent. */
export type WebPageReason = {
  code: WebPageReasonCode
  /** The HTTP status, for `status`. */
  status?: number
  /** The media type the site declared, for `content-type`. */
  contentType?: string
  /** For `timeout`: the web call's own 90 seconds ran out, not the page's 15. */
  limit?: 'call'
}

// The site writes both of these, so only a plain status or media type is ever repeated back.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/

const statusText = (status: number | undefined) =>
  status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? `the site answered ${status}`
    : 'the site answered with an error'

/** A declared media type only when it is plain `type/subtype`: anything else the site wrote is dropped. */
export const webPageMediaType = (contentType: unknown): string | undefined =>
  typeof contentType === 'string' && MEDIA_TYPE.test(contentType) ? contentType : undefined

const contentTypeText = (contentType: string | undefined) =>
  webPageMediaType(contentType)
    ? `the page is ${contentType}, which is not read as text`
    : 'the page did not say it is text'

/** Frozen English wording; it completes "W4 https://... could not be read: ...". */
export function webPageReasonText(reason: WebPageReason): string {
  switch (reason.code) {
    case 'scheme':
      return 'it is not an http or https web address'
    case 'credentials':
      return 'the address carries a user name or password'
    case 'port':
      return 'only ports 80 and 443 are read'
    case 'private-address':
      return 'the address points at this computer or a private network'
    case 'dns':
      return 'the site name could not be found'
    case 'timeout':
      return reason.limit === 'call'
        ? 'the 90 seconds allowed for reading all the pages ran out first'
        : 'the site did not finish answering within 15 seconds'
    case 'too-large':
      return 'the page is larger than 2 MB'
    case 'content-type':
      return contentTypeText(reason.contentType)
    case 'status':
      return statusText(reason.status)
    case 'redirects':
      return 'the site redirected more than 5 times or in a loop'
    case 'insecure-redirect':
      return 'the site redirected from https to plain http'
    case 'tls':
      return "the site's secure connection could not be verified"
    case 'proxy':
      return 'a proxy is set up, and pages are only read directly'
    case 'network':
      return 'the connection failed or the page arrived damaged'
    case 'empty':
      return 'no readable text could be taken from the page'
  }
}
