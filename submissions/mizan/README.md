# Mizan — a compliance and risk consultant for founders

**n8n Santa Clara University Buildathon, 15 November 2026**
Built by [@saifulquamar](https://github.com/saifulquamar) · source: https://github.com/saifulquamar/mizan

A founder types two sentences about what they are building. Mizan reads which
countries, sector and stage that implies, asks only the questions that change the
answer, and returns a roadmap of what they owe, what it costs, and what they could
lose — every item carrying the sentence or official quote it came from.

## The rule the whole thing is built around

**A model may explain a number. It may never produce one.**

Every amount lives in SQL — `task_exposure` and `compliance_debt` compute late fees,
accrued penalties and the diligence score from the obligation's own money fields and
an FX table. The LLM nodes read language and write language. They never do arithmetic
a founder could be hurt by.

Five more rules sit underneath it:

| Rule | Enforced by |
|---|---|
| No source, no number | An amount with no `obligation_evidence` row renders "Unverified", never a figure |
| Every item names what you could lose | `obligations.risk_types`, shown on every card |
| Every fact carries its quote | `fact_evidence.quote` — the founder's own sentence |
| A human approves new research | WF3 stops at `draft`; only a person promotes it |
| Sensitive fields never leave the browser | Tax IDs are typed locally into the printed form, never stored or posted |

## What runs

Seven workflows on n8n Cloud, ~130 nodes, all Claude nodes on n8n gateway credits.

| Workflow | Trigger | Does |
|---|---|---|
| WF0 Smart Intake | `POST /intake/text`, `/intake/upload` | PDFs and pasted text to quoted facts; confident ones auto-confirm |
| WF1 Confirm Facts | `POST /intake/confirm` | Applies the founder's answers, then runs WF2 |
| WF2 Matching + Deadlines | sub-workflow | The rule evaluator and deadline engine — **no LLM** |
| WF3 Regulatory Monitor | hourly + `POST /monitor/run` | Watch → triage → research → extract → verify, then a human gate |
| WF8 Idea Interpreter | `POST /idea` | Two sentences to a profile, stages and the 3–5 questions that matter |
| WF10 Roadmap Builder | `POST /roadmap/build` | Spreads obligations across the founder's own stages |
| WF11 Ask Mizan | `POST /ask` | Plain-words answers with official sources and a "needs a professional" flag |

Plus 13 static screens — no framework, no build step — reading Postgres through
PostgREST and writing only by calling an n8n webhook.

## The part worth looking at

**WF2 contains no model at all, and that is the point.** The rule evaluator reads each
obligation's applicability JSON against the company's facts (`==`, `>=`, `contains`,
nested with all/any) and the deadline engine turns `annual:MM-DD` and `event+Nd` into
real dates. Deterministic: the same facts always produce the same obligations. The
parts a founder would be hurt by getting wrong are the parts a language model never
touches.

**WF3 is four agents in a line with a person at the end.** Triage discards anything
unrelated with a reason. Research fetches the official page and must quote it. The
extractor leaves any number null that no source states. The verifier only returns
`high` if every money field is quote-backed. The obligation lands as `draft` — nothing
reaches a founder unapproved.

## Verified, not asserted

`tests/acceptance.py` in the main repo posts to the live webhooks and reads results
back through Postgres, so each assertion checks what a founder would actually see:

```
A-1  POST /idea reads Lina in her own words            PASS
B-2  Demo Flip Labs prices out exactly as specified    PASS
M-1  the monitor chain reaches verified                PASS
```

B-2 checks the figures the design called for and the database computes: diligence
score 85, $115 accrued on an FC-GPR filing 300 days late, $6,240/yr of spend leaks,
next notice deadline 2026-12-04.

## Running it

1. Run `sql/mizan-complete-setup.sql` on a Supabase project (27 tables, 7 views).
2. One Postgres credential in n8n named `Supabase Postgres`, pointed at the **session
   pooler** — the direct host has no IPv4 record and fails as "Connection refused".
3. Fill `ui/assets/config.js`, then serve `ui/` as static files.

Full setup, including the two connection traps that cost us an hour, is in
[SETUP.md](https://github.com/saifulquamar/mizan/blob/main/SETUP.md).

---

Mizan gives information, not legal or tax advice.
