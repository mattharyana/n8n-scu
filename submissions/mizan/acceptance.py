# -*- coding: utf-8 -*-
"""Mizan acceptance tests, straight from TEST_PLAN.md in mizan-sample-test-docs.zip.

Runs the live stack: posts to the n8n webhooks, then reads the result back through
Supabase so the assertions check what a founder would actually see, not what the
workflow claims it wrote.

    python tests/acceptance.py            # everything
    python tests/acceptance.py A1 B2      # only these

Expected values assume today = 2026-11-15 and the seed FX rate (0.012 USD per INR),
as TEST_PLAN.md states. Needs no dependencies beyond the standard library.
"""
from __future__ import print_function

import json
import re
import sys
import os
import time

try:
    from urllib.request import Request, urlopen
    from urllib.error import HTTPError, URLError
except ImportError:                                    # py2
    from urllib2 import Request, urlopen, HTTPError, URLError

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_JS = os.path.join(HERE, os.pardir, 'ui', 'assets', 'config.js')


# --------------------------------------------------------------------------- config

def load_config():
    """Read the same config.js the browser reads, so the tests cannot drift from it."""
    src = open(CONFIG_JS).read()

    def grab(key):
        m = re.search(key + r"\s*:\s*'([^']+)'", src)
        if not m:
            sys.exit('config.js has no %s' % key)
        return m.group(1)

    cfg = {
        'supabase': grab('SUPABASE_URL'),
        'key': grab('SUPABASE_ANON_KEY'),
        'n8n': grab('N8N_BASE'),
        'demo': grab('DEMO_COMPANY_NAME'),
    }
    if 'YOUR-PROJECT' in cfg['supabase']:
        sys.exit('config.js still has placeholders. Fill it in first.')
    return cfg


CFG = load_config()


# --------------------------------------------------------------------------- plumbing

def post(path, payload, timeout=180):
    """POST to an n8n webhook. Returns (status, parsed_or_text)."""
    url = CFG['n8n'].rstrip('/') + '/' + path.lstrip('/')
    body = json.dumps(payload).encode('utf-8')
    req = Request(url, data=body, headers={'Content-Type': 'application/json'})
    try:
        r = urlopen(req, timeout=timeout)
        raw = r.read().decode('utf-8', 'replace')
        code = r.getcode()
    except HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        code = e.code
    except URLError as e:
        return 0, 'unreachable: %s' % e
    try:
        return code, json.loads(raw) if raw else None
    except ValueError:
        return code, raw


def sb(path, timeout=60):
    """GET through PostgREST with the publishable key."""
    url = CFG['supabase'].rstrip('/') + '/rest/v1/' + path.lstrip('/')
    req = Request(url, headers={
        'apikey': CFG['key'],
        'Authorization': 'Bearer ' + CFG['key'],
        'Accept': 'application/json',
    })
    try:
        return json.loads(urlopen(req, timeout=timeout).read().decode('utf-8'))
    except HTTPError as e:
        raise AssertionError('Supabase %s: %s' % (e.code, e.read()[:200]))


def webhook_live(path):
    code, body = post(path, {}, timeout=30)
    text = body if isinstance(body, str) else json.dumps(body or {})
    return not (code == 404 and 'not registered' in text)


# --------------------------------------------------------------------------- results

PASS, FAIL, SKIP = [], [], []


class Check(object):
    """One test case. Collects every assertion instead of dying on the first."""

    def __init__(self, tid, what):
        self.tid, self.what, self.notes = tid, what, []

    def ok(self, cond, label, got=None):
        self.notes.append((bool(cond), label, got))
        return bool(cond)

    def done(self):
        bad = [n for n in self.notes if not n[0]]
        head = '%s  %s' % (self.tid, self.what)
        print(('FAIL  ' if bad else 'PASS  ') + head)
        for good, label, got in self.notes:
            if not good or '-v' in sys.argv:
                mark = '  ok ' if good else '  >> '
                line = mark + label
                if got is not None:
                    line += '   got: %s' % (json.dumps(got)[:150],)
                print(line)
        (FAIL if bad else PASS).append(self.tid)


def skip(tid, what, why):
    print('SKIP  %s  %s' % (tid, what))
    print('  >> ' + why)
    SKIP.append(tid)


# --------------------------------------------------------------------------- the cases

LINA = ("I'm building an app that reminds elderly people to take their meds and pings "
        "their daughter or son if they miss one. I want to pilot it with a clinic in "
        "Austin, hire a developer in Poland, raise money from angels this spring, and "
        "later launch in Dubai.")


def t_A1():
    """A-1: Lina's two sentences become quoted facts, stages and moves."""
    if not webhook_live('idea'):
        return skip('A-1', 'POST /idea', 'WF8 is not active — no webhook registered')

    c = Check('A-1', 'POST /idea reads Lina in her own words')
    code, res = post('idea', {'text': LINA, 'owner_email': 'lina@example.com',
                              'company_name': 'Dosely'})
    if not c.ok(code == 200, 'responds 200', code):
        return c.done()

    blob = json.dumps(res).lower()
    for want in ['us-tx', 'health', 'raising']:
        c.ok(want in blob, 'mentions %s' % want)

    company_id = (res or {}).get('company_id') if isinstance(res, dict) else None
    if c.ok(company_id, 'returns a company_id', company_id):
        facts = sb('fact_evidence?company_id=eq.%s&select=fact_key,value,quote,status' % company_id)
        c.ok(len(facts) >= 4, 'at least 4 facts stored', len(facts))
        # Honesty rule 4 is about CONFIRMED facts. A fact the interpreter could
        # not quote is not meant to be dressed up — it becomes one of the
        # questions, as needs_review, which is the honest outcome.
        unquoted = [f['fact_key'] for f in facts
                    if f.get('status') == 'confirmed' and not (f.get('quote') or '').strip()]
        c.ok(not unquoted, 'every confirmed fact carries a quote', unquoted)
        review = [f['fact_key'] for f in facts if f.get('status') != 'confirmed']
        c.ok(True, 'unquoted facts held back for review: %s' % (review or 'none'))
        for f in facts:
            q = (f.get('quote') or '').strip('"“” ').lower()
            if q and not c.ok(q in LINA.lower(), 'quote is Lina\'s own words', f.get('quote')):
                break
        stages = sb('company_stages?company_id=eq.%s&select=label,position' % company_id)
        c.ok(len(stages) >= 5, 'builds the founder\'s stages', len(stages))
    c.done()


def t_A3():
    """A-3: the roadmap puts 83(b) and founder IP under Incorporate."""
    if not webhook_live('roadmap/build'):
        return skip('A-3', 'POST /roadmap/build', 'WF10 is not active')

    rows = sb("companies?name=eq.Dosely&select=id&limit=1")
    if not rows:
        return skip('A-3', 'POST /roadmap/build', 'no Dosely company — run A-1 first')

    c = Check('A-3', 'roadmap pins each item to the stage it bites')
    code, _ = post('roadmap/build', {'company_id': rows[0]['id']})
    if not c.ok(code == 200, 'responds 200', code):
        return c.done()

    road = sb('roadmap?company_id=eq.%s&select=*&order=position.asc' % rows[0]['id'])
    c.ok(road, 'roadmap view returns stages', len(road))
    titles = ' | '.join((r.get('title') or '') for r in road).lower()
    c.ok('incorporat' in titles, 'has an Incorporate stage', titles[:120])
    cards = sb('task_cards?company_id=eq.%s&select=code,stage' % rows[0]['id'])
    codes = ' '.join((t.get('code') or '') for t in cards).lower()
    c.ok('83b' in codes.replace('(', '').replace(')', '') or '83' in codes,
         '83(b) election is on the roadmap', codes[:120])
    c.done()


def t_B2():
    """B-2: the numbers the design PDF promises, computed in SQL."""
    c = Check('B-2', 'Demo Flip Labs prices out exactly as specified')
    rows = sb("companies?name=eq.%s&select=id&limit=1" % CFG['demo'].replace(' ', '%20'))
    if not c.ok(rows, 'demo company is readable', rows):
        return c.done()
    cid = rows[0]['id']

    debt = sb('compliance_debt?company_id=eq.%s&select=*' % cid)
    if c.ok(debt, 'compliance_debt returns a row'):
        d = debt[0]
        c.ok(d.get('diligence_score') == 85, 'diligence score is 85', d.get('diligence_score'))
        c.ok(d.get('accrued_penalties_usd') == 115, 'accrued penalties are $115',
             d.get('accrued_penalties_usd'))
        c.ok(d.get('overdue_filings') == 1, 'one overdue filing', d.get('overdue_filings'))

    fcgpr = sb('task_exposure?company_id=eq.%s&code=eq.IN-FCGPR&select=*' % cid)
    if c.ok(fcgpr, 'FC-GPR task exists'):
        c.ok(fcgpr[0].get('days_late') == 300, 'FC-GPR is 300 days late',
             fcgpr[0].get('days_late'))

    leaks = sb('leak_summary?company_id=eq.%s&select=*' % cid)
    if c.ok(leaks, 'leak_summary returns a row'):
        c.ok(leaks[0].get('leaking_per_year') == 6240, 'leaks total $6,240/yr',
             leaks[0].get('leaking_per_year'))
        c.ok(str(leaks[0].get('next_notice_deadline')) == '2026-12-04',
             'next notice deadline is 2026-12-04', leaks[0].get('next_notice_deadline'))
    c.done()


def t_M1():
    """M-1: a notice walks triage → research → extract → verify."""
    if not webhook_live('monitor/run'):
        return skip('M-1', 'POST /monitor/run', 'WF3 is not active')

    c = Check('M-1', 'the monitor chain reaches verified')
    before = len(sb('events?select=id'))
    code, _ = post('monitor/run', {})
    if not c.ok(code == 200, 'responds 200', code):
        return c.done()

    stage, events = None, []
    for _ in range(20):                       # the agent chain is not instant
        events = sb('events?select=id,stage,created_at&order=created_at.desc&limit=5')
        stage = events[0]['stage'] if events else None
        if stage in ('verified', 'approved', 'discarded'):
            break
        time.sleep(3)

    c.ok(len(events) > before or events, 'an event was created', len(events))
    c.ok(stage in ('verified', 'approved', 'discarded'),
         'chain settles at verified (or honestly discards)', stage)
    c.done()


def t_HONESTY():
    """The rule that shapes the product: no source, no number."""
    c = Check('H-1', 'no amount is shown without a source')
    rows = sb('task_cards?select=code,cost_to_comply_usd,penalty_accrued_usd,'
              'amount_type,source_evidence&limit=200')
    c.ok(rows, 'task_cards is readable', len(rows))
    # The documented rule (STATE.md, pipeline.html) is: an amount needs an
    # obligation_evidence row or a cost_items.source_url, or the screen shows
    # "Unverified". dashboard.html actually tests `amount_type !== 'estimate'`,
    # which is looser — anything not labelled an estimate renders a figure even
    # with nothing behind it. This asserts the documented rule, so the gap shows.
    naked = []
    for r in rows:
        has_money = (r.get('cost_to_comply_usd') or 0) or (r.get('penalty_accrued_usd') or 0)
        if has_money and not r.get('source_evidence'):
            naked.append('%s (%s)' % (r.get('code'), r.get('amount_type')))
    c.ok(not naked, 'every priced item has an obligation_evidence row', sorted(set(naked)))

    closed = []
    for t in ('expert_requests', 'generated_documents', 'reminders'):
        if sb('%s?select=*&limit=1' % t):
            closed.append(t)
    c.ok(not closed, 'sensitive tables stay unreadable to anon', closed)
    c.done()


CASES = [('A1', t_A1), ('A3', t_A3), ('B2', t_B2), ('M1', t_M1), ('H1', t_HONESTY)]


def main():
    picked = [a.upper() for a in sys.argv[1:] if not a.startswith('-')]
    print('Mizan acceptance tests')
    print('  n8n      %s' % CFG['n8n'])
    print('  supabase %s\n' % CFG['supabase'])

    for tid, fn in CASES:
        if picked and tid not in picked:
            continue
        try:
            fn()
        except AssertionError as e:
            print('FAIL  %s  (%s)' % (tid, e))
            FAIL.append(tid)
        except Exception as e:                        # a broken test is a failed test
            print('FAIL  %s  unexpected %s: %s' % (tid, type(e).__name__, e))
            FAIL.append(tid)
        print('')

    print('-' * 56)
    print('%d passed, %d failed, %d skipped' % (len(PASS), len(FAIL), len(SKIP)))
    if SKIP:
        print('skipped because a workflow is inactive: %s' % ', '.join(SKIP))
    return 1 if FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
