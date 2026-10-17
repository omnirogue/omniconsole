"""Classify work text into company and domain with JEV (TypeSafe System One), one request, bounded time.

Used by the launcher (once per launch) and by the per-prompt memory hook. Any failure returns None so
callers fall back to the deterministic resolution; JEV output is a routing label, never authority.
"""
import json
import os
import re
import time
import urllib.request
from pathlib import Path

URL = 'https://api.typesafe.ai/v1/systemone'
MODEL = 'jev-1.13.0'
CONNECTIONS = Path.home() / '.config' / 'omni' / 'connections.env'
MIN_CONFIDENCE = 0.7

COMPANIES = {
    'omnirogue': 'OmniRogue: AI video/content product, its Enterprise and DTC ads, webinars, customers and site.',
    'betacorp': 'BetaCorp: secondary brand with its own campaigns, customers, emails and site.',
    'acme': 'ACME (Example Academy): courses, webinars and memberships.',
    'apexlabs': 'ApexLabs: the campaign-launch and analytics platform product.',
    'hardwaredirect': 'HardwareDirect: the workstation hardware reseller business.',
    'estate': 'Internal tooling for the agents themselves (OmniConsole, omni-ide, omniconsole, fleet, rules), '
              'or no specific company.',
}
DOMAINS = {
    'advertising': 'Paid ads: campaigns, ad sets, budgets, pausing, ROAS/CPA, ad accounts.',
    'marketing': 'Creating content: ad copy, landing pages, emails, social posts, SEO, brand material.',
    'sales': 'Turning leads and visitors into purchases, and measuring it: funnels, webinar registrations and '
             'attendance through to purchases, lead follow-up, GHL pipelines, booked calls, offers, pricing, '
             'checkout, upsells, close rates.',
    'customer-success': 'Customer support replies, tickets, refunds, chargebacks, retention.',
    'engineering': 'Writing or reviewing code, PRs, tests, builds, deploys, bugs.',
    'finance-admin': 'Invoices, payouts, accounting, taxes, reconciliation.',
    'operations': 'Hosts, fleet, processes, automations, scheduling, internal ops.',
    'research': 'Researching, comparing or auditing without producing one of the above.',
}


def _key():
    key = os.environ.get('TYPESAFE_API_KEY')
    if key:
        return key
    try:
        for line in CONNECTIONS.read_text(encoding='utf-8').splitlines():
            match = re.match(r'\s*(?:export\s+)?TYPESAFE_API_KEY=(.*)$', line)
            if match:
                return match.group(1).strip().strip('"\'') or None
    except OSError:
        return None
    return None


def classify(text, timeout=3.0):
    """Return {'company': (slug|None, conf), 'domain': (slug|None, conf), 'ms': int} or None."""
    key = _key()
    if not key or not (text or '').strip():
        return None
    body = {'model': MODEL, 'state': {'work': text[:4000]}, 'questions': {
        'company': {'type': 'choice', 'criteria': COMPANIES,
                    'instructions': 'Which company is the work described in state.work for?'},
        'domain': {'type': 'choice', 'criteria': DOMAINS,
                   'instructions': 'Which kind of work does state.work ask for?'}}}
    request = urllib.request.Request(URL, data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            answers = json.loads(response.read(200_000)).get('answers') or {}
    except Exception:
        return None
    out = {'ms': int((time.monotonic() - started) * 1000)}
    for name in ('company', 'domain'):
        answer = answers.get(name) or {}
        choice, conf = answer.get('choice'), float(answer.get('confidence') or 0)
        keep = choice if conf >= MIN_CONFIDENCE and choice != 'estate' else None
        out[name] = (keep, round(conf, 3), choice)
    return out
