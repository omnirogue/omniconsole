#!/usr/bin/env python3
"""Pick provider, model and effort for a dispatched prompt when the requester named none.

Sal, 2026-09-28: "when we are dispatching work through a session, we should either be able to select
model & effort levels (by requesting), and if we dont it should go through the router automatically.
this should be used for dispatching only ... and luna should be our fast model unless requested."
Design and evidence: Slite krdUBOje2HGOqh.

Three gates, first confident answer wins:
  0. rules (0 ms): money, customers, ads, credentials, deletes and deploys always go to frontier.
  1. semantic-router (~10 ms warm, served by `omni_route.py serve`): only short-circuits to frontier.
  2. JEV (one call, yes/no questions, ~0.4-0.7 s): the only gate allowed to route work down.
Anything unsure, slow or failing routes to frontier, which is what launches used before the router.

Stdlib only for callers; `serve` needs the omniconsole venv (semantic-router + fastembed).
CLI: omni_route.py route --prompt-file F|- [--title T] [--provider P] [--model M] [--effort E] [--json]
     (--json adds 'note': the escalation text to append to a routed-down brief)
     omni_route.py serve   (resident semantic gate on 127.0.0.1:8497)
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jev_route  # noqa: E402  (key lookup + endpoint shared with the company/domain classifier)

PORT = 8497
LOG = Path(os.environ.get('OMNI_ROUTE_LOG') or Path.home() / 'Work' / 'Ops' / 'var' / 'omni-route' / 'decisions.jsonl')
# Sal, 2026-09-28: Codex's top levels are max and ultra; Claude's is ultracode (xhigh + dynamic workflows,
# accepted by `claude --effort ultracode` though never listed in its effort ladder).
CODEX_EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max', 'ultra')
CLAUDE_EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max', 'ultracode')
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode')
TOP_EFFORTS = ('max', 'ultra', 'ultracode')
CODEX_ALIASES = {
    'astra': 'gpt-6-astra',
    'astra 6': 'gpt-6-astra',
    'astra-6': 'gpt-6-astra',
    'gpt-6-astra': 'gpt-6-astra',
    'sol': 'gpt-6.1-sol',
    'sol 6.1': 'gpt-6.1-sol',
    'sol-6.1': 'gpt-6.1-sol',
    'gpt-6.1-sol': 'gpt-6.1-sol',
    'luna': 'gpt-6-luna',
    'luna 6': 'gpt-6-luna',
    'luna-6': 'gpt-6-luna',
    'gpt-6-luna': 'gpt-6-luna',
    'terra': 'gpt-5.6-terra',
    'terra 5.6': 'gpt-5.6-terra',
    'terra-5.6': 'gpt-5.6-terra',
    'gpt-5.6-terra': 'gpt-5.6-terra',
}
GEMINI_ALIASES = {
    'gemini-4-argon': 'gemini-4-argon',
    'gemini 4 argon': 'gemini-4-argon',
    'argon': 'gemini-4-argon',
    'argon 4': 'gemini-4-argon',
    'gemini-3.8-flash': 'gemini-3.8-flash',
    'gemini-3-8-flash': 'gemini-3.8-flash',
    'gemini 3-8-flash': 'gemini-3.8-flash',
    'gemini 3.8 flash': 'gemini-3.8-flash',
    '3-8-flash': 'gemini-3.8-flash',
    '3.8-flash': 'gemini-3.8-flash',
}
CLAUDE_ALIASES = ('opus', 'opus 5.5', 'opus-5.5', 'sonnet', 'sonnet 5.5', 'haiku', 'haiku 5.5', 'fable', 'best', 'opusplan', 'default')

# Tier -> (provider, model, effort). Luna is the fast model (Sal, 2026-09-28). Bounded standard work runs on
# Sonnet 5.5 at medium (Sal, 2026-10-11, OmniOS decision 264, after Sonnet matched Opus on 10 real tickets at about
# a third of the cost); frontier keeps Opus at high, the launch default before the router existed.
TIERS = {
    'fast': ('codex', 'gpt-6-luna', 'medium'),
    'standard': ('claude', 'claude-opus-5-5', 'high'),
    'frontier': ('claude', 'claude-opus-5-5', 'high'),
}
# When the requester pinned a provider, stay inside it.
PROVIDER_TIERS = {
    'claude': {'fast': ('claude-sonnet-5-5', 'medium'), 'standard': ('claude-opus-5-5', 'high'),
               'frontier': ('claude-opus-5-5', 'high')},
    'codex': {'fast': ('gpt-6-luna', 'medium'), 'standard': ('gpt-6-astra', 'high'),
              'frontier': ('gpt-6-astra', 'xhigh')},
    'gemini': {'fast': ('gemini-3.8-flash', None), 'standard': ('gemini-4-argon', None),
               'frontier': ('gemini-4-argon', None)},
}
RENTED_CODEX_HOSTS = {
    'ssh:ssh-1789079711003-22um6q', 'ssh:ssh-1790288125545-ui57co',
    'ssh:ssh-1789079711003-iuiqy1', 'ssh:ssh-1789079711003-rodue7',
}
# When the requester pinned a model but not an effort.
EFFORT_BY_TIER = {'fast': 'medium', 'standard': 'high', 'frontier': 'high'}

RISK_PATTERNS = [re.compile(p, re.I) for p in (
    r'\b(payments?|stripe|paypal|billing|invoices?|charges?|payouts?|refunds?|checkout|credit ?cards?|chargebacks?)\b',
    r'\b(bank|banking|wire|transfer funds?|top ?up|gradyn)\b',
    r'\b(pricing|prices?|subscriptions?|rebills?|cancell?ations?|cancel)\b',
    r'\b(ads?|ad ?sets?|campaigns?|ad accounts?|budgets?|roas|meta ads|facebook ads)\b',
    r'\b(customers?|clients?|support (emails?|tickets?|replies)|cs replies|send (the )?emails?)\b',
    r'\b(migrations?|migrate|schema change|alter table|drop (table|column|database|schema|index))\b',
    r'\b(auth|oauth|sso|login|sign-?up|api ?keys?|secrets?|credentials?|passwords?|permissions?|tokens?)\b',
    r'\b(delete|truncate|wipe|purge|destroy|erase|drop)\b',
    r'\b(deploy|deployment|production|prod|go live|release|merge|rollout)\b',
)]
# Longer briefs carry more judgement; never send them to the fast tier.
FAST_WORD_CAP = 250

JEV_QUESTIONS = {
    'risk': 'Does the work in state.work involve money, payments, refunds, pricing, customers or messages to '
            'customers, paid ads, bank accounts, credentials or permissions, deleting data, or deploying or '
            'merging to production?',
    'bounded': 'Is the work in state.work a bounded, well-specified task, such as a lookup, a list or status '
               'report, a format conversion, a copy edit, a small mechanical change, or a summary of given material?',
    'checkable': 'Can the result of the work in state.work be confirmed correct with a quick mechanical check, '
                 'such as tests passing, a diff, a count or a visible output, without expert judgement?',
    'deep': 'Does the work in state.work require designing something new, finding an unknown root cause, '
            'research that reaches conclusions, planning, or judgement between competing options?',
}
# v1 cutoffs, set 2026-09-28 from ~20 real and synthetic briefs (constraint lines stripped first, since JEV
# misreads prohibitions as the topic). Gate 0 rules are the primary money/customer/deploy guard; JEV's risk
# answer is the second check. Re-calibrate from decisions.jsonl outcomes (JEV Exp 6: per question, per direction).
RISK_MAX = 0.15
FAST = {'bounded': 0.85, 'deep': 0.20, 'checkable': 0.50}
STANDARD = {'bounded': 0.50, 'deep': 0.35}
JEV_FIRST_TRY_S = 1.5
JEV_TIMEOUT_S = 3.5  # p50 ~0.35 s, tail 2-3 s measured 2026-09-28; slower falls back to frontier

SEMANTIC_ROUTES = {
    'fast': [
        'sort the stalled draft PRs by status', 'refresh the list of open pull requests',
        'status report of all active ad accounts', 'summarize this Slack thread into bullets',
        'convert these emails into HTML templates', 'rename these files to the new convention',
        'check CPU and memory on every machine', 'collect these links into one document',
        'upload the reference images to the shared folder', 'make five copies of the video in four sizes',
        'fix a typo in the README', 'bump the version number', 'list every file that imports this module',
        'inventory the repository and map its folders', 'reformat this data into a table',
        'update the wording of this label', 'find where this function is defined',
    ],
    'standard': [
        'fix the scroll bug in the video options panel', 'add an approve-all button to the list',
        'add a small dashboard widget showing weekly totals', 'write unit tests for the parser',
        'add a filter parameter to the search endpoint', 'fix the UI labels on the settings page',
        'add a toggle that expands every folder in the sidebar', 'implement the approved design for this page',
        'wire the existing endpoint into the new view', 'port this small script to the new API',
    ],
    'frontier': [
        'design the architecture for the new system', 'investigate why the app crashed and fix the root cause',
        'research the options and write a proposal', 'audit the system and fix what is wrong',
        'plan the new ads for each account', 'review this pull request adversarially',
        'coordinate several agents to build this feature', 'reliability review of the whole console',
        'why does this intermittently fail under load', 'decide which approach we should take and build it',
        'build the full pipeline end to end with verification', 'find and fix the bugs in this flow',
    ],
}
SEMANTIC_FRONTIER_CONF = 0.75


def _post(url, body, timeout, headers=None):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(200_000))


# Prohibitions name risky things without asking for them ("do not deploy", "never email customers");
# drop them, and any standing "Rules:" section, before matching.
NEGATED = re.compile(r"\b(do not|don't|dont|never|not|no|without|avoid)\b[^.;:\n]*", re.I)
# Guardrails phrased without a negation word ("Stop and ask the person before any production deploy",
# "ask Sal before merging", "unless the person explicitly asks", "requires approval for refunds").
GUARDRAIL = re.compile(r"\b(stop and ask|ask (the person|the user|sal|first)?\s*before|check with [^.;:\n]* before|"
                       r"unless\b|only (after|with|when)\b|requires? [^.;:\n]*approval|needs? [^.;:\n]*approval|"
                       r"approval (is )?required|with (sal's |explicit )?approval)[^.;:\n]*", re.I)
RULES_SECTION = re.compile(r'^\s*(rules|constraints|guardrails|do not)\b.*', re.I | re.S | re.M)


def strip_constraints(text):
    return GUARDRAIL.sub(' ', NEGATED.sub(' ', RULES_SECTION.sub(' ', text)))


def gate_rules(text):
    text = strip_constraints(text)
    for pattern in RISK_PATTERNS:
        match = pattern.search(text)
        if match:
            return 'frontier', 'risk term "' + match.group(0) + '"'
    return None, None


def gate_semantic(text, timeout=0.3):
    try:
        reply = _post(f'http://127.0.0.1:{PORT}/route', {'text': text[:2000]}, timeout)
        return reply.get('tier'), float(reply.get('confidence') or 0)
    except Exception:
        return None, 0.0


def gate_jev(text, timeout=JEV_TIMEOUT_S):
    key = jev_route._key()
    if not key:
        return None
    questions = {name: {'type': 'noul', 'instructions': q} for name, q in JEV_QUESTIONS.items()}
    body = {'model': jev_route.MODEL, 'state': {'work': text[:4000]}, 'questions': questions}
    started = time.monotonic()
    try:
        # Most calls answer in ~0.3 s; a slow one (2-3 s tail) is usually faster to re-ask than to wait for.
        reply = _post(jev_route.URL, body, min(JEV_FIRST_TRY_S, timeout), {'Authorization': 'Bearer ' + key})
    except Exception:
        # One retry for an error or a slow first try, inside the same total budget.
        left = timeout - (time.monotonic() - started)
        if left < 1.0:
            return None
        try:
            reply = _post(jev_route.URL, body, left, {'Authorization': 'Bearer ' + key})
        except Exception:
            return None
    answers = reply.get('answers') or {}
    out = {}
    for name in JEV_QUESTIONS:
        answer = answers.get(name) or {}
        value = answer.get('noul')
        if not isinstance(value, (int, float)):
            return None
        out[name] = round(float(value), 3)
    return out


def tier_from_jev(p, words):
    if p['risk'] > RISK_MAX:
        return 'frontier', 'JEV not sure it is risk-free'
    if (p['bounded'] >= FAST['bounded'] and p['deep'] <= FAST['deep'] and p['checkable'] >= FAST['checkable']
            and words <= FAST_WORD_CAP):
        return 'fast', 'JEV: bounded, checkable, no deep reasoning'
    if p['bounded'] >= STANDARD['bounded'] and p['deep'] <= STANDARD['deep']:
        return 'standard', 'JEV: bounded, light reasoning'
    return 'frontier', 'JEV: needs reasoning or not clearly bounded'


# Rules read only the title and the opening task statement: estate briefs end with standing constraints
# ("do not merge or deploy", "never touch customers") that would otherwise match every launch.
RULES_HEAD_CHARS = 600


def classify(text, title=''):
    started = time.monotonic()
    words = len(text.split())
    trace = {'words': words}
    tier, reason = gate_rules((title or '') + '\n' + text[:RULES_HEAD_CHARS])
    gate = 'rules' if tier else None
    if not tier:
        sem, conf = gate_semantic(text)
        trace['semantic'] = {'tier': sem, 'confidence': round(conf, 3)}
        if sem == 'frontier' and conf >= SEMANTIC_FRONTIER_CONF:
            tier, reason, gate = 'frontier', 'semantic match', 'semantic'
    if not tier:
        p = gate_jev(strip_constraints(text))
        trace['jev'] = p
        if p:
            tier, reason = tier_from_jev(p, words)
            gate = 'jev'
        else:
            tier, reason, gate = 'frontier', 'JEV unavailable', 'fallback'
    trace['ms'] = int((time.monotonic() - started) * 1000)
    return {'tier': tier, 'gate': gate, 'reason': reason, 'trace': trace}


def resolve(text, provider=None, model=None, effort=None, title='', host=None):
    """Honour anything requested; route the rest. Returns the full decision (also logged)."""
    requested = {'provider': provider, 'model': model, 'effort': effort}
    if model:
        provider, model = requested_model(provider, model, effort)
    if model and effort:
        decision = {'tier': None, 'gate': 'requested', 'reason': 'model and effort requested', 'trace': {}}
    else:
        decision = classify(text, title)
        tier = decision['tier']
        if not model and effort in TOP_EFFORTS and tier != 'frontier':
            # A lighter tier's model may not offer the requested top effort (Luna stops at max).
            decision['reason'] = str(decision['reason']) + f'; {effort} effort requested, raised to frontier'
            decision['tier'] = tier = 'frontier'
        if model:
            effort = EFFORT_BY_TIER[tier]
        elif provider:
            model, tier_effort = PROVIDER_TIERS[provider][tier]
            effort = effort or tier_effort
        else:
            provider, model, tier_effort = TIERS[tier]
            effort = effort or tier_effort
    if host in RENTED_CODEX_HOSTS and provider == 'codex' and not requested['model'] \
            and model == 'gpt-6-astra':
        model = 'gpt-6.1-sol'
        decision['reason'] += '; rented Mac Codex default: GPT-6.1 Sol (Sal, 2026-09-30)'
    effort = normalize_effort(provider, model, effort)
    decision.update({'provider': provider, 'model': model, 'effort': effort, 'requested': requested})
    _log(text, decision)
    return decision


def requested_model(provider, model, effort=None):
    """(provider, model) for a requested model: expands aliases and infers the provider when unnamed."""
    cleaned = ' '.join(model.strip().lower().split())
    if provider in (None, 'codex') and cleaned in CODEX_ALIASES:
        model = CODEX_ALIASES[cleaned]
        provider = provider or 'codex'
    elif provider in (None, 'gemini') and cleaned in GEMINI_ALIASES:
        model = GEMINI_ALIASES[cleaned]
        provider = provider or 'gemini'
    elif provider in (None, 'claude') and cleaned in ('opus 5.5', 'opus-5.5', 'claude-opus-5-5', 'claude-opus-4-7'):
        model = 'claude-opus-5-5'
        provider = provider or 'claude'
    elif provider in (None, 'claude') and cleaned in ('sonnet 5.5', 'sonnet-5.5', 'claude-sonnet-5-5', 'claude-sonnet-4-6'):
        model = 'claude-sonnet-5-5'
        provider = provider or 'claude'
    elif provider in (None, 'claude') and cleaned in ('haiku 5.5', 'haiku-5.5', 'claude-haiku-5-5', 'claude-haiku-4-5'):
        model = 'claude-haiku-5-5'
        provider = provider or 'claude'
    if provider:
        return provider, model
    if model.startswith('gemini-') or cleaned.startswith('gemini') or cleaned.startswith('argon'):
        return 'gemini', GEMINI_ALIASES.get(cleaned, model)
    if model.startswith('gpt-') or codex_model_efforts(model):
        return 'codex', model
    if effort in ('ultra', 'ultracode') and not (model.startswith('claude') or model in CLAUDE_ALIASES):
        raise ValueError(f'Cannot tell which provider runs {model!r}; pass --provider codex or --provider claude '
                         f'so {effort!r} maps to the right top effort.')
    return 'claude', model


def codex_model_efforts(model):
    """Efforts any local Codex catalog (every Codex home and OmniConsole seat) advertises for this model, or None
    when none lists it. The union keeps the answer the same whichever CODEX_HOME the caller runs under."""
    return _codex_catalog().get(model)


_CODEX_CATALOG = None


def _codex_catalog():
    global _CODEX_CATALOG
    if _CODEX_CATALOG is not None:
        return _CODEX_CATALOG
    home = Path.home()
    paths = [Path(os.environ['CODEX_HOME']) / 'models_cache.json'] if os.environ.get('CODEX_HOME') else []
    paths += sorted(home.glob('.codex*/models_cache.json'))
    for app in ('omniconsole-ide', 'omni-dev'):
        paths += sorted((home / 'Library' / 'Application Support' / app / 'codex-accounts').glob('*/home/models_cache.json'))
    found = {}
    for path in paths:
        try:
            catalog = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        for row in catalog.get('models', []) if isinstance(catalog, dict) else []:
            if not isinstance(row, dict):
                continue
            levels = [level.get('effort') for level in row.get('supported_reasoning_levels') or []
                      if isinstance(level, dict) and level.get('effort')]
            for name in {row.get('slug'), row.get('id')} - {None}:
                known = found.setdefault(name, [])
                known += [level for level in levels if level not in known]
    _CODEX_CATALOG = {name: tuple(levels) for name, levels in found.items() if levels}
    return _CODEX_CATALOG


def normalize_effort(provider, model, effort):
    """The effort to launch with. Maps each provider's top level onto the other's name (Claude ultra ->
    ultracode, Codex ultracode -> ultra) and refuses a level the provider or Codex model cannot run."""
    if provider == 'gemini':
        return None
    if not effort:
        return effort
    if provider == 'claude':
        effort = 'ultracode' if effort == 'ultra' else effort
        if effort not in CLAUDE_EFFORTS:
            raise ValueError(f'Claude has no {effort!r} effort; use one of {", ".join(CLAUDE_EFFORTS)}.')
        return effort
    effort = 'ultra' if effort == 'ultracode' else effort
    if effort not in CODEX_EFFORTS:
        raise ValueError(f'Codex has no {effort!r} effort; use one of {", ".join(CODEX_EFFORTS)}.')
    supported = codex_model_efforts(model) if model else None
    if supported and effort not in supported:
        raise ValueError(f'{model} does not offer {effort!r} effort (its Codex catalog lists '
                         f'{", ".join(supported)}). Pick one of those or a model that offers {effort}.')
    return effort


def escalation_note(decision):
    """Describe routed choices without authorizing effort changes or duplicate sessions."""
    if decision.get('tier') not in ('fast', 'standard'):
        return ''
    return ('\n\n--- Router note ---\nThe dispatcher filled only unspecified choices and selected '
            f"{decision['model']} at {decision['effort']} effort ({decision['reason']}). Preserve explicit "
            'provider, model and effort choices. Diagnose a failed check before changing the action; '
            'authentication, quota, transport or permission failures do not justify higher effort. '
            'If the task exceeds this seat capability, state the specific gap and retain ownership of '
            'the current work. Do not automatically relaunch or start unrelated fixes.\n')


def _log(text, decision):
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        row = {'at': int(time.time() * 1000), 'sha': hashlib.sha256(text.encode()).hexdigest()[:16],
               **decision}
        with LOG.open('a') as f:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
    except OSError:
        pass


def serve():
    import logging
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from semantic_router import Route
    from semantic_router.encoders import FastEmbedEncoder
    from semantic_router.routers import SemanticRouter
    logging.getLogger('semantic_router').setLevel(logging.ERROR)
    encoder = FastEmbedEncoder(name='BAAI/bge-small-en-v1.5')
    routes = [Route(name=name, utterances=utts) for name, utts in SEMANTIC_ROUTES.items()]
    router = SemanticRouter(encoder=encoder, routes=routes, auto_sync='local')
    router('warm up')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self._send(200, {'ok': True})

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
                started = time.monotonic()
                choice = router(str(body.get('text') or '')[:2000])
                self._send(200, {'tier': choice.name, 'confidence': choice.similarity_score or 0,
                                 'ms': round((time.monotonic() - started) * 1000, 1)})
            except Exception as error:  # the caller treats any failure as "no semantic verdict"
                self._send(500, {'error': type(error).__name__})

        def _send(self, code, payload):
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('route')
    r.add_argument('--prompt-file', type=Path)
    r.add_argument('--text')
    r.add_argument('--title', default='')
    r.add_argument('--provider', choices=['claude', 'codex', 'gemini'])
    r.add_argument('--model')
    r.add_argument('--effort', choices=EFFORTS)
    r.add_argument('--json', action='store_true')
    sub.add_parser('serve')
    a = p.parse_args()
    if a.cmd == 'serve':
        serve()
        return
    text = a.text if a.text is not None else (a.prompt_file.read_text() if a.prompt_file and str(a.prompt_file) != '-' else sys.stdin.read())
    try:
        decision = resolve(text, a.provider, a.model, a.effort, a.title)
    except ValueError as error:
        sys.exit(str(error))
    if a.json:
        print(json.dumps({**decision, 'note': escalation_note(decision)}))
    else:
        print(f"{decision['provider']} {decision['model']} {decision['effort']}  "
              f"[{decision['tier'] or 'requested'} via {decision['gate']}: {decision['reason']}, "
              f"{decision['trace'].get('ms', 0)} ms]")


if __name__ == '__main__':
    main()
