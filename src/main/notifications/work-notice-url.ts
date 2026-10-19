const WORK_PAGE = 'https://console.example.com/work'

export function workNoticeClickUrl(value?: string): string {
  try {
    const url = new URL(value ?? '')
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'console.example.com' || url.hostname === 'example-team.atlassian.net')
    ) {
      return url.href
    }
  } catch {
    // Invalid links land on Work.
  }
  return WORK_PAGE
}
