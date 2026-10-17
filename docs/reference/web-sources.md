# Web sources in workflows

A workflow can read web pages that the person lists. The app fetches each page once before the steps that cite it start, keeps a copy, and gives the text only to the Do steps that asked for it. No agent gets a web tool: every seat keeps web search and fetch turned off, and the seat command files (`workflow-*-command.ts`) are unchanged.

Code: `src/shared/web-page-address.ts` (the shared address policy), `src/main/web-pages/` (the reader), `src/main/runtime/workflow-script/graph/graph-web-*.ts` (the web call, its record and replay), `src/shared/workflow-graph-web.ts` and `workflow-graph-validate-web.ts` (the spec and its rules), `src/shared/workflow-web-fence.ts` (fences around model text).

## Where pages come from

There is no search. The pages are the ones the person lists:

- **Pages to read** on a Do step in the step editor (`WorkflowWebPagesField.tsx`).
- **Setup** for Discover (the Find step), Investigate (the three investigators) and the Research panel (the research step). Setup fills in the http(s) addresses it finds in the request (`workflow-web-addresses.ts`), and each one can be removed. An address the person removed is never added back.
- Nothing is fetched until Start. Agents cannot add pages: that would give them a way to send data out.

## The policy

The same syntactic checks run in setup and at validation; the network checks run only in the main process.

| What         | Rule                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scheme       | `http:` and `https:` only                                                                                                                                                                                                                                                            |
| Credentials  | an address with a user name or password is refused                                                                                                                                                                                                                                   |
| Port         | 80 and 443 only                                                                                                                                                                                                                                                                      |
| Local names  | `localhost`, `*.localhost` and `localhost.` are refused                                                                                                                                                                                                                              |
| IP addresses | private and special ranges are refused (loopback, private networks, link-local, carrier-grade NAT, documentation, multicast, IPv4-mapped IPv6, NAT64, ULA). Setup refuses literal addresses early; main checks every address the resolver returns, and refuses if any one is blocked |
| DNS          | pinned: the socket connects only to an address that was checked                                                                                                                                                                                                                      |
| Redirects    | at most 5, each hop checked again; https to http is refused, and so are loops                                                                                                                                                                                                        |
| Request      | GET only, with no cookies, auth or Referer; a proxy means refusal                                                                                                                                                                                                                    |
| Time         | 15 seconds per page across all hops, 90 seconds for the whole web call                                                                                                                                                                                                               |
| Size         | 2 MB after decompression; text cut at 60,000 characters and marked as cut                                                                                                                                                                                                            |
| Types        | `text/html`, `application/xhtml+xml`, `text/plain`, `text/markdown`, `application/json`; anything else (PDF, images) is unreadable, with its type named                                                                                                                              |
| Count        | at most 12 pages per step and 24 per run; an address over 2,000 characters is refused, not cut                                                                                                                                                                                       |
| Parallel     | 4 pages at a time, at most 2 per site                                                                                                                                                                                                                                                |

Hidden page content (scripts, `display:none`, `hidden`, comments, hidden inputs, zero-size text and the like) is removed before the text is taken, and so are invisible characters. Lines that read as instructions to an AI are replaced by a marker, and the count is kept.

An unreadable page has a reason code (`src/shared/web-page-reason.ts`). It is never shown as a success: the run view uses the warning tone, the gaps list it ("1 of 3 web pages could not be read (W3)"), and readers are told it has no content.

## What runs where

- The app reads pages on the host that runs the workflow. Today workflows run only on the local host, and admission refuses a run that reads pages in a workspace that does not run on this computer.
- A future remote run must fetch on its execution host, under the same policy, and must never fall back to fetching on the client. The client's network, proxy and private addresses are not the execution host's.
- Each page is kept under `<userData>/local-workflow-attempts/<executionId>/web/` as hash-named blobs (the text and the raw bytes, files 0600, folder 0700). `web-sources.json` holds only metadata, never text. A replay reads the kept text and checks its hash. It never goes to the network: a changed or missing blob stops the run as `recovery_required`.
- Schema v42 `local_workflow_web_starts` records that a web call began, so a run whose record was lost never reads the pages again with different results.

## Who sees what

- **Readers.** Only a Do step with `web.urls` sees page text. Each page comes inside a fence whose tag carries the first 12 hex digits of the text's hash, so a page cannot close its own fence, after rules telling the model that the text is untrusted and that it may only quote from it.
- **Everyone else.** Every other step (reviews, rankings, syntheses, JEV screens and ballots, the Council final check, Improve judges) sees the readers' answers, never the pages. Each answer is fenced as `<<<MODEL TEXT nonce>>>`, followed by an app-owned "App quote checks" block. These steps see only a page's host and path, never its title, because the page wrote the title.
- **App quote checks.** The app checks each `[W2] "quote"` against the kept text and records `found`, `not-in-page`, `leaves-out`, `unreadable`, `unknown`, `unquoted` or `pending`. The checks are structured data (`webChecks`). The UI shows them as plain text (`WorkflowWebChecks.tsx`) and never reads them from model text. A citation mark inside a model's answer is the model's own claim.
- **Result.** The app's part of the result (`result.appendix`: the sources and the app's checks) is kept apart from the model's Markdown and shown separately, as inert text. Saving, copying and follow-ups put the app's part first.
- **Run view.** The Sources panel (`WorkflowWebSources.tsx`) shows each page's id, host and path, when it was read, how many lines were removed and whether it was cut, or why it could not be read. The view's `web` field never carries a page's title or text.

## Restrictions in runs that read pages

- **No model-written rubric.** A run that reads pages may not score by a rubric a model writes: `forEach.screen.rubricFrom`, `byCriterion.rubricFrom` and a Council final check's skeptic are refused.
  - **Decide** can't read pages yet: its comparison and shortlist take their rubric from its own first step.
  - **Discover** normally screens findings by the rubric in its brief. With pages, setup asks for the generic rubric or one the person writes ("Reading pages needs a written rubric"). Removing every page puts a generic choice back to the brief's rubric; a written rubric stays.
  - **Investigate** uses no model-written rubric, so it reads pages as it is.
- **No OpenRouter seats.** A provider may browse on its own side with queries a page steered, outside the app's policy, so a run that reads pages refuses every OpenRouter seat.
- **Only Do steps read.** Judges, rubric sources, Find the best and the Do step of a plateau loop (whose versions the judges compare) cannot read pages.
- **Unverified without a found quote.** An item that comes from a reader, or from any step downstream of one, stays unverified, whatever the reviewers voted, unless an app quote check found its quote in the page.

## Security checklist

- [ ] No change to seat argv or env: the diff of `workflow-*-command.ts` is empty.
- [ ] No `fetch(` line was added. No `rejectUnauthorized` or `NODE_TLS_REJECT_UNAUTHORIZED`.
- [ ] Every connection goes through the pinned lookup. IP literals are checked before connecting. Every hop is re-checked. https→http is refused. Caps apply to decompressed bytes.
- [ ] GET only, with no cookies, auth or Referer. A proxy leads to refusal.
- [ ] Hidden-content, invisible-character and fence fixtures pass.
- [ ] Page text reaches only Do readers; rubric sources cannot read pages.
- [ ] Unreadable is never shown as success.
- [ ] `cacheOnly` never touches the network. A tampered blob refuses. Files are 0600, the folder 0700, ids are validated, and blob names are hex.
- [ ] Workflow markdown never loads remote images automatically (#656).
- [ ] Web runs require a local host, and the future remote case is written down (above).
- [ ] OpenRouter models that browse on the provider's side are excluded (every OpenRouter seat is refused in a run that reads pages).
- [ ] Logs carry counts, never page text.

## GitHub harvest

Find the best can take a GitHub search as a source of candidates. The person types a search query
and how many repositories to bring back (1–100, 30 by default) in the Find options panel; nothing
else sets it. The spec compiler strips any `find.harvest` a model writes and restores the person's
own (`settleFindHarvest` in `src/shared/workflow-graph-compile.ts`), so a description that reads
like "search GitHub for…" never turns into a real search behind the person's back.

### What runs

The host runs the search once per run, through `gh`:

```
gh api -X GET search/repositories -f q=<query> -f sort=stars -f per_page=<n>
```

The query is a single literal argument value — it is never passed through a shell, so nothing in
it can be interpreted as a command. Calls go through `ghExecFileAsync` with `host: 'github.com'`,
under the same `acquire`/`release` concurrency gate as the rest of the app's GitHub work, so a
`GH_HOST` pointing at a company server cannot answer for github.com.

`src/main/runtime/workflow-script/graph/graph-github-harvest.ts` holds the call; the planner side
is `graph-find-harvest.ts`.

### What reaches a judge

Nothing the repository's owner wrote. A search result becomes a pool option with:

- **title** — the `full_name` GitHub returned, checked against the same `FULL_NAME` pattern the
  facts fetcher uses. A result without a usable owner/name is dropped and counted in the run's gaps.
- **url** — `https://github.com/<full_name>`.
- **detail** — empty.
- **facts** — `githubFactsLine` over the search response: stars, forks, open issues, last push,
  creation date, licence and language, with language and licence taken from the same fixed
  allowlists as `graph-github-facts.ts`.

The description, topics and homepage are read by nobody. A repository's own text could be worded
as instructions to the models, so it never enters a prompt, a JEV request or a judge's ballot —
the same rule `findJudgeText` (`src/shared/find-judge-text.ts`) enforces for every other option
that names GitHub.

Because harvested options already carry host-fetched facts, `graph-find-facts.ts` skips them when
it decides which repositories still need asking about.

### Recording and replay

The results are written once per run to `github-harvest.json` beside the run's other host records,
keyed by the call id and a digest of the request. A replay reads that record and never calls `gh`;
a cache-only replay with no record, or with a different request, fails rather than searching again.

A failure that may pass on its own (5xx, rate limiting, a network fault) keeps nothing at all: the
run fails with a reason naming Retry, and `graphHarvestHasRetryableFailure` makes Retry available.
A `gh` that is missing or not signed in, or a query GitHub rejects, is recorded as an honest
failure with zero repositories and an `error` — never an empty search that looks like a result.

### Gating

Harvest is planned only for runs admitted under Find rules 5 or later (`FIND_RULES` in
`graph-plan-types.ts`), and only when `find.harvest` is set. Older runs replay exactly as they ran.
`assertHarvestReplaySupported` refuses to resume a run that carries a search but was admitted under
earlier rules. `planWorkflowCalls` counts one extra host call when `find.harvest` is set.
