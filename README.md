
# Churn Rescue: AI Retention Workflow (n8n)

## Problem
At-risk telecom customers leave before anyone reaches out. Manual outreach is slow and inconsistent.

## Solution
Rules flag at-risk customers, an AI agent picks an approved retention offer from a Google Sheets menu and drafts an email, a manager approves it in Slack, and approved offers are emailed and logged.

## Workflow
Manual Trigger → Google Sheets → Risk scoring (Code) → IF → AI Agent + Offers tool → Parse → Slack human approval → Gmail → Log

## Key design decisions
- The AI never sees the churn label.
- The agent chooses only from an approved Offers menu and can't exceed max_discount.
- A human approves every outgoing offer.

## Tools
n8n Cloud, OpenAI gpt-4o-mini, Google Sheets, Slack, Gmail

## Data
IBM Telco Customer Churn (Kaggle), trimmed to a 50-row demo sample weighted toward at-risk customers. Names and emails are synthetic.

## Next steps
Wait-and-escalate follow-up, live Form trigger, error workflow, results dashboard.
