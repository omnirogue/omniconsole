import {
  DISCOVER_OMNIOS_PICKS,
  DISCOVER_OMNIOS_MAX_FINDINGS,
  discoverOmniosKey,
  type DiscoverOmniosFinding,
  type DiscoverOmniosPick,
  type DiscoverOmniosRun,
  type DiscoverOmniosStatus
} from './discover-omnios-page'

/**
 * The OmniOS page for a finished Discover run (see discover-omnios-page.ts for what it holds). It
 * follows the console's page rules (docs/human-pages.md there): words not data, light, and no
 * button of its own; it reports the person's picks as the decision's edits.
 */

const escape = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const STATUS_WORDS: Record<DiscoverOmniosStatus, string> = {
  confirmed: 'Confirmed by a reviewer from another model family',
  'jev-confirmed': 'JEV judged it real; no reviewer settled it',
  unverified: 'Reviewed, but the reviewers did not settle it',
  unchecked: 'Not reviewed: past the number this run checks',
  'single-pass': 'Found in one read; no second model checked it'
}

const PICK_DETAIL: Record<DiscoverOmniosPick, string> = {
  Start: 'A session does the work and checks it against its own acceptance list.',
  'Dig deeper':
    'A focused Discover on this one (usually 20 to 40 minutes) brings its results back as a new page.',
  'Not now': 'Nothing happens.'
}

const EVIDENCE_WORDS: Partial<Record<string, string>> = {
  missing: 'its quote was not found in the file',
  unreadable: 'its file could not be read'
}

function option(finding: DiscoverOmniosFinding, pick: DiscoverOmniosPick): string {
  const chosen = finding.recommended === pick
  const detail = pick === 'Start' && finding.next ? finding.next : PICK_DETAIL[pick]
  return (
    `<label class="opt"><input type="radio" name="f${finding.n}" value="${pick}"` +
    `${chosen ? ' data-recommended checked' : ''}><span><b>${pick}` +
    `${chosen ? ' <span class="tag">recommended</span>' : ''}</b>` +
    `<span class="detail">${escape(detail)}</span></span></label>`
  )
}

function confidence(finding: DiscoverOmniosFinding): string {
  const votes = finding.votes ?? []
  const tally = ['pass', 'fail', 'unsure']
    .map((vote) => `${votes.filter((v) => v === vote).length} ${vote}`)
    .join(', ')
  return `Votes: ${tally}; ${votes.filter((v) => v === null).length} unanswered · Repeats: ${finding.repeats ?? 'unknown'} · JEV: ${finding.jevVerify ?? 'unknown'} · Independent work: ${finding.independent === undefined ? 'unknown' : finding.independent ? 'yes' : 'no'}`
}

function findingHtml(finding: DiscoverOmniosFinding): string {
  const severity = finding.severity && finding.severity !== 'none' ? finding.severity : ''
  const facts = [STATUS_WORDS[finding.status], severity && `severity ${severity}`]
    .concat(finding.location ? [finding.location] : [])
    .concat(
      finding.evidence && EVIDENCE_WORDS[finding.evidence]
        ? [EVIDENCE_WORDS[finding.evidence]!]
        : []
    )
    .filter(Boolean)
    .map((fact) => escape(String(fact)))
    .join(' · ')
  return [
    `<section class="finding"><fieldset data-n="${finding.n}" data-finding="${escape(finding.key)}" data-key="${escape(discoverOmniosKey(finding))}">`,
    `<legend>${finding.n}. ${escape(finding.title)}</legend>`,
    finding.why ? `<p class="why">${escape(finding.why)}</p>` : '',
    `<p class="facts">${facts}</p>`,
    `<p class="facts">${escape(confidence(finding))}</p>`,
    `<p class="facts">Effort: ${escape(finding.effort ?? 'unknown')} · Risk: ${escape(finding.risk ?? 'unknown')}</p>`,
    ...DISCOVER_OMNIOS_PICKS.map((pick) => option(finding, pick)),
    '</fieldset>',
    finding.detail
      ? `<details><summary>Evidence</summary><pre>${escape(finding.detail)}</pre></details>`
      : '',
    '</section>'
  ].join('')
}

const STYLE = `:root{--bg:#f7f7f5;--panel:#fff;--line:#e4e4df;--text:#1d1d1b;--muted:#6b6b66;--accent:#2f5bea;--ok:#1f7a4d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 20px 48px}.eyebrow{color:var(--muted);font-size:13px;margin:0 0 4px}
h1{font-size:24px;line-height:1.25;margin:0 0 12px}.lead{font-size:17px;margin:0 0 8px}.how{color:var(--muted);font-size:14px;margin:0 0 24px}
.finding{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 18px 12px;margin:0 0 14px}
fieldset{border:0;margin:0;padding:0}legend{font-weight:650;font-size:18px;padding:0;margin:0 0 6px}.why{margin:0 0 8px}
.facts{color:var(--muted);font-size:13px;margin:0 0 12px}.opt{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin:0 0 6px;cursor:pointer}
.opt:has(input:checked){border-color:var(--accent);background:#f2f5fe}.opt input{margin-top:4px}.opt b{display:block;font-weight:600}
.detail{display:block;color:var(--muted);font-size:14px}.tag{font-size:12px;color:var(--ok);border:1px solid var(--ok);border-radius:999px;padding:0 7px;margin-left:6px;font-weight:500}
details{margin:10px 0 0}summary{cursor:pointer;color:var(--accent);font-size:14px}pre{white-space:pre-wrap;font-size:13px;background:var(--bg);padding:10px;border-radius:8px}
.method{margin-top:28px;color:var(--muted);font-size:14px}.gaps{background:#fff8e6;border:1px solid #f0dca8;border-radius:8px;padding:8px 12px;font-size:14px;margin:0 0 16px}`

/** One decision surface: no button here; every pick is reported to the decision bar as edits. */
const SCRIPT = `(() => {
  const send = () => {
    const edits = { picks: [] }
    for (const group of document.querySelectorAll('fieldset')) {
      const picked = Array.from(group.querySelectorAll('input[type=radio]')).find((r) => r.checked)
      if (picked && group.dataset.key) {
        edits[group.dataset.key] = picked.value
        edits.picks.push({ n: Number(group.dataset.n), key: group.dataset.finding, pick: picked.value })
      }
    }
    parent.postMessage({ type: 'omni-artifact:edits', edits }, '*')
  }
  document.addEventListener('change', send)
  send()
})()`

function headline(run: DiscoverOmniosRun): string {
  if (!run.findings.length) {
    return 'Nothing worth acting on'
  }
  const confirmed = run.findings.filter((finding) => finding.status === 'confirmed').length
  return `${confirmed} confirmed; ${run.findings.length - confirmed} needing review`
}

export function discoverOmniosPage(run: DiscoverOmniosRun, page = 1): string {
  const start = (page - 1) * DISCOVER_OMNIOS_MAX_FINDINGS
  const findings = run.findings.slice(start, start + DISCOVER_OMNIOS_MAX_FINDINGS)
  const kind = run.template === 'quick-discover' ? 'Quick Discover' : 'Discover'
  const eyebrow = [kind, run.workspace, run.minutes ? `${run.minutes} min` : '']
    .filter(Boolean)
    .map(escape)
    .join(' · ')
  const how = findings.length
    ? `<p class="how">Pick Start, Dig deeper or Not now for each one, then approve. Each Start opens its own session. Showing ${start + 1}–${start + findings.length} of ${run.findings.length} findings. ${run.rankingComplete ? 'Start is ticked for the first three confirmed findings.' : 'The ranking is incomplete; choose Starts explicitly.'}${start + findings.length < run.findings.length ? ' The session brings the remaining findings as the next decision page, with their evidence and controls.' : ''}</p>`
    : ''
  const gaps = run.gaps.length
    ? `<p class="gaps"><b>Not covered:</b> ${escape(run.gaps.join(' '))}</p>`
    : ''
  const more = run.more.length
    ? `<details><summary>${run.more.length} more found, not on this page</summary><ul>${run.more.map((title) => `<li>${escape(title)}</li>`).join('')}</ul></details>`
    : ''
  const { refuted, jev, noFile } = run.setAside
  const setAside = [
    refuted ? `${refuted} the reviewers refuted` : '',
    jev ? `${jev} JEV set aside as not real` : '',
    noFile ? `${noFile} citing no file that exists` : ''
  ].filter(Boolean)
  const method = [
    `The question: ${escape(run.goal)}`,
    run.requestedBy ? `Asked by ${escape(run.requestedBy)}.` : '',
    setAside.length ? `Also found and set aside: ${escape(setAside.join(', '))}.` : '',
    run.models.length ? `Models: ${escape(run.models.join(', '))}.` : ''
  ]
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join('')
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escape(`${kind}: ${run.goal}`.slice(0, 160))}</title><style>${STYLE}</style></head><body><main>`,
    `<p class="eyebrow">${eyebrow}</p>`,
    `<h1>${escape(headline(run))}</h1>`,
    run.summary ? `<p class="lead">${escape(run.summary)}</p>` : '',
    gaps,
    how,
    ...findings.map(findingHtml),
    more,
    run.report
      ? `<details class="method"><summary>The full report</summary><pre>${escape(run.report)}</pre></details>`
      : '',
    `<details class="method"><summary>How this was found</summary>${method}</details>`,
    `</main><script>${SCRIPT}</script></body></html>`
  ].join('')
}
