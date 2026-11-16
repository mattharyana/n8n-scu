-- ============================================================
-- Mizan - complete database setup, generated 2026-11-15
-- Paste this whole file into the Supabase SQL editor and run once.
-- Sections run in dependency order; do not reorder them.
-- SAMPLE/demo data throughout. Not legal or tax advice.
-- ============================================================


-- ============================================================
-- 1/8  Core: companies, obligations, tasks, money views, US+India seed
-- source: schema_and_seed_v2.sql
-- ============================================================
-- Compliance Autopilot v2 â€” US + India cross-border startups, every obligation priced
-- Three core features:
--   1) Price-tagged regulatory changes (WF3 adds fee/penalty to every new rule)
--   2) Pre-raise "compliance debt" score (view: compliance_debt)
--   3) US + India cross-border pack (Delaware/IRS + FEMA/RBI + ROC + transfer pricing)
-- DEMO DATA ONLY. Not legal or tax advice. Every amount carries an amount_type; verify against official sources.
-- INRâ†’USD at a fixed demo rate (see fx table).

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_email text,
  facts jsonb not null,              -- normalized intake answers
  created_at timestamptz default now()
);

create table fx (ccy text primary key, usd_rate numeric not null);
insert into fx values ('USD',1),('INR',0.012);   -- demo rate, update before demo

create table sources (
  id uuid primary key default gen_random_uuid(),
  agency text, doc_number text unique, title text, url text,
  published_on date, raw jsonb, content_hash text,
  fetched_at timestamptz default now()
);

create table obligations (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  title text not null,
  requirement text not null,
  jurisdiction text,                 -- 'US-FED','US-DE','IN-RBI','IN-MCA','IN-ITD'
  category text,
  rule jsonb not null,               -- applicability rule (rule-evaluator.js)
  frequency text,                    -- 'once','annual','per-event'
  due_rule text,                     -- machine hint: 'annual:03-01', 'annual:07-15', 'event+30d'
  due_hint text,                     -- human-readable deadline
  evidence text,
  owner_role text,
  -- financial impact
  currency text default 'USD',
  compliance_cost numeric,           -- fee to do it right (0 if none)
  penalty_flat numeric,              -- one-off late penalty
  penalty_per_day numeric,           -- accruing penalty per day late
  penalty_pct_per_year numeric,      -- % of amount_involved per year late (e.g. FEMA LSF)
  penalty_cap numeric,               -- max penalty, if any
  amount_type text,                  -- 'confirmed_fee' | 'potential_statutory_penalty' | 'estimate'
  money_source_url text,             -- official fee/penalty source
  source_id uuid references sources(id),
  status text default 'active',      -- 'draft' for LLM-extracted, pending review
  created_at timestamptz default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  obligation_id uuid references obligations(id) on delete cascade,
  status text default 'open',        -- open | done | missed | not_applicable
  due_date date,
  amount_involved numeric,           -- e.g. FDI amount for FC-GPR, in obligation currency
  completed_on date,
  evidence_url text,
  created_at timestamptz default now(),
  unique (company_id, obligation_id)
);

create table audit_log (
  id bigserial primary key, company_id uuid, event text, detail jsonb,
  at timestamptz default now()
);

-- Exposure per task, in USD. "If done today" vs "already/if late on this day".
create or replace view task_exposure as
select t.id task_id, t.company_id, o.code, o.title, o.jurisdiction, t.status, t.due_date,
       greatest(0, current_date - t.due_date) as days_late,
       o.amount_type,
       round(coalesce(o.compliance_cost,0) * f.usd_rate, 0) as cost_to_comply_usd,
       round(least(
         coalesce(o.penalty_cap, 1e12),
         coalesce(o.penalty_flat,0)
         + coalesce(o.penalty_per_day,0) * greatest(0, current_date - t.due_date)
         + coalesce(o.penalty_pct_per_year,0)/100 * coalesce(t.amount_involved,0)
             * greatest(0, current_date - t.due_date)/365.0
       ) * f.usd_rate * (case when t.due_date < current_date and t.status <> 'done' then 1 else 0 end), 0)
         as penalty_accrued_usd,
       round((coalesce(o.penalty_flat,0)
         + coalesce(o.penalty_pct_per_year,0)/100 * coalesce(t.amount_involved,0)) * f.usd_rate, 0)
         as avoidable_if_on_time_usd
from tasks t join obligations o on o.id = t.obligation_id join fx f on f.ccy = o.currency;

-- Feature 2: pre-raise compliance-debt score (what an investor's diligence would find)
create or replace view compliance_debt as
select c.id company_id, c.name,
       count(*) filter (where e.days_late > 0 and e.status <> 'done') as overdue_filings,
       sum(e.penalty_accrued_usd)                                      as accrued_penalties_usd,
       sum(e.avoidable_if_on_time_usd) filter (where e.status='open' and e.days_late = 0) as protectable_usd,
       greatest(0, 100 - 15 * count(*) filter (where e.days_late > 0 and e.status <> 'done')) as diligence_score
from companies c left join task_exposure e on e.company_id = c.id
group by c.id, c.name;

-- Fact keys: entity_type, incorporation_state, has_india_subsidiary (bool), foreign_owned_25pct (bool),
-- indian_resident_founders (bool), received_fdi_india (bool), employee_states, headcount,
-- customer_regions, data_types, industry, imports_goods, uses_ai, raising_soon (bool)

insert into obligations (code,title,requirement,jurisdiction,category,rule,frequency,due_rule,due_hint,evidence,owner_role,
  currency,compliance_cost,penalty_flat,penalty_per_day,penalty_pct_per_year,penalty_cap,amount_type,money_source_url) values

-- US side
('DE-ANNUAL','Delaware annual report + franchise tax','File annual report and pay franchise tax for the Delaware C-Corp.','US-DE','corporate',
 '{"all":[{"fact":"incorporation_state","op":"==","value":"DE"},{"fact":"entity_type","op":"==","value":"C-Corp"}]}',
 'annual','annual:03-01','March 1 every year','Filing receipt','Founder',
 'USD',225,200,null,null,null,'confirmed_fee','https://corp.delaware.gov/paytaxes/'),
('IRS-5472','IRS Form 5472 (25%+ foreign-owned US corp)','Report transactions with foreign related parties (e.g. Indian subsidiary, foreign founders) with the federal return.','US-FED','tax',
 '{"any":[{"fact":"foreign_owned_25pct","op":"true"},{"fact":"has_india_subsidiary","op":"true"}]}',
 'annual','annual:04-15','With corporate tax return','Filed 5472 copy','Finance',
 'USD',0,25000,null,null,null,'potential_statutory_penalty','https://www.irs.gov/instructions/i5472'),
('I9','Form I-9 for every US hire','Verify identity and work authorization for each new US employee.','US-FED','employment',
 '{"all":[{"fact":"headcount","op":">=","value":1}]}','per-event','event+3d','Within 3 business days of start','I-9s on file','HR',
 'USD',0,null,null,null,null,'estimate',null),
('CA-PRIVACY','California privacy review','Assess CCPA/CPRA applicability; privacy notice and request handling if in scope.','US-CA','privacy',
 '{"all":[{"fact":"customer_regions","op":"contains","value":"CA"},{"fact":"data_types","op":"contains","value":"personal"}]}',
 'once',null,'Before launch to CA users','Privacy policy + DSR process','Engineering','USD',0,null,null,null,null,'estimate',null),

-- India side: FEMA / RBI (the flip-structure pain point)
('IN-FCGPR','FEMA FC-GPR after share allotment','Report foreign investment (e.g. US parent funding the Indian subsidiary) on RBI FIRMS after allotting shares.','IN-RBI','fema',
 '{"all":[{"fact":"has_india_subsidiary","op":"true"},{"fact":"received_fdi_india","op":"true"}]}',
 'per-event','event+30d','Within 30 days of share allotment','FC-GPR acknowledgment','Finance',
 'INR',0,7500,null,0.025,null,'confirmed_fee','https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12393'),
('IN-FLA','FEMA FLA annual return','Annual Return on Foreign Liabilities and Assets for Indian entity with foreign investment.','IN-RBI','fema',
 '{"all":[{"fact":"has_india_subsidiary","op":"true"},{"fact":"received_fdi_india","op":"true"}]}',
 'annual','annual:07-15','July 15 every year','FLA submission receipt','Finance',
 'INR',0,7500,null,null,null,'confirmed_fee','https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12393'),
('IN-ODI-APR','ODI Annual Performance Report (Indian residents holding foreign shares)','Indian resident founders/entities with overseas investment file the APR via AD bank.','IN-RBI','fema',
 '{"all":[{"fact":"indian_resident_founders","op":"true"}]}',
 'annual','annual:12-31','By Dec 31 every year','APR acknowledgment','Founder',
 'INR',0,7500,null,null,null,'confirmed_fee','https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12393'),

-- India side: ROC / Income tax
('IN-ROC-ANNUAL','ROC annual filings (AOC-4, MGT-7)','File financial statements and annual return of the Indian private company with MCA.','IN-MCA','corporate',
 '{"all":[{"fact":"has_india_subsidiary","op":"true"}]}',
 'annual','annual:11-29','30/60 days after AGM','MCA SRNs','Finance',
 'INR',1000,null,100,null,null,'potential_statutory_penalty','https://www.mca.gov.in'),
('IN-TP-3CEB','Transfer pricing report (Form 3CEB)','Accountant''s report on international transactions between Indian subsidiary and US parent.','IN-ITD','tax',
 '{"all":[{"fact":"has_india_subsidiary","op":"true"}]}',
 'annual','annual:10-31','Oct 31 (one month before ITR due date)','Filed 3CEB','Finance',
 'INR',50000,100000,null,null,null,'potential_statutory_penalty','https://www.incometax.gov.in'),
('IN-SCHED-FA','Schedule FA: founders'' foreign shares in Indian ITR','Indian-resident founders disclose Delaware shares and foreign accounts in their personal return.','IN-ITD','tax',
 '{"all":[{"fact":"indian_resident_founders","op":"true"}]}',
 'annual','annual:07-31','With personal ITR','ITR acknowledgment','Founder',
 'INR',0,1000000,null,null,null,'potential_statutory_penalty','https://www.incometax.gov.in'),

-- Diligence readiness
('RAISE-DD','Pre-raise compliance clean-up','Resolve overdue filings before investor diligence; open contraventions surface in data rooms.','GLOBAL','corporate',
 '{"all":[{"fact":"raising_soon","op":"true"}]}',
 'once',null,'Before term sheet','Clean compliance_debt report','Founder',
 'USD',0,null,null,null,null,'estimate',null);

-- Demo company (a USâ€“India flip startup with a missed FC-GPR)
insert into companies (name, owner_email, facts) values
('Demo Flip Labs','founder@example.com',
 '{"entity_type":"C-Corp","incorporation_state":"DE","has_india_subsidiary":true,"foreign_owned_25pct":true,
   "indian_resident_founders":true,"received_fdi_india":true,"employee_states":["CA"],"headcount":4,
   "customer_regions":["US","CA","IN"],"data_types":["personal"],"industry":"saas","raising_soon":true}');
-- After WF2 creates tasks, set one overdue for the demo, e.g.:
-- update tasks set due_date = current_date - 300, amount_involved = 10000000
--   where obligation_id = (select id from obligations where code='IN-FCGPR');


-- ============================================================
-- 2/8  Smart intake: documents, fact_evidence, confirm_facts(), events, alerts
-- source: schema_v2_additions.sql
-- ============================================================
-- Run AFTER schema_and_seed_v2.sql
-- Adds: smart intake (documents, extracted facts with evidence), monitor queue, alerts.

-- Smart intake ------------------------------------------------------------
create table company_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  source text not null,              -- 'upload' | 'ai_assistant' | 'paste' | 'url'
  filename text,
  doc_type text,                     -- 'certificate_of_incorporation','cap_table','pitch_deck','fc_gpr_ack','board_resolution','firc','other'
  storage_path text,                 -- Supabase Storage path (bucket: company-docs)
  text_content text,                 -- extracted plain text
  created_at timestamptz default now()
);

create table fact_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  fact_key text not null,            -- e.g. 'has_india_subsidiary'
  value jsonb not null,
  confidence numeric not null,       -- 0..1 from extraction agent
  document_id uuid references company_documents(id) on delete set null,
  quote text,                        -- exact snippet supporting the value
  status text default 'proposed',    -- proposed | confirmed | rejected
  created_at timestamptz default now()
);

-- Founder confirms facts â†’ merge into companies.facts
create or replace function confirm_facts(p_company uuid) returns jsonb language plpgsql as $$
declare merged jsonb;
begin
  select coalesce(c.facts,'{}'::jsonb) || coalesce(jsonb_object_agg(f.fact_key, f.value),'{}'::jsonb)
    into merged
  from companies c
  left join lateral (
    select distinct on (fact_key) fact_key, value from fact_evidence
    where company_id = p_company and status = 'confirmed'
    order by fact_key, confidence desc, created_at desc
  ) f on true
  where c.id = p_company
  group by c.facts;
  update companies set facts = merged where id = p_company;
  insert into audit_log(company_id, event, detail) values (p_company, 'facts_confirmed', merged);
  return merged;
end $$;

-- Regulatory monitor queue -------------------------------------------------
create table events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources(id),
  stage text default 'new',          -- new | triaged | researched | extracted | verified | approved | published | discarded
  relevance jsonb,                   -- triage output
  brief jsonb,                       -- research output
  draft jsonb,                       -- extractor output (obligation + money fields)
  verification jsonb,                -- verifier output
  obligation_id uuid references obligations(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  obligation_id uuid references obligations(id),
  title text,
  body text,
  cost_to_comply_usd numeric,
  penalty_usd numeric,
  sent_at timestamptz,
  created_at timestamptz default now()
);


-- ============================================================
-- 3/8  Demo seed: Demo Flip Labs tasks so the dashboard has data
-- source: 06_seed_first_run.sql
-- ============================================================
-- Mizan first run: makes the dashboard work even before the n8n workflows are ready.
-- Run AFTER schema_and_seed_v2.sql and schema_v2_additions.sql. Safe to re-run.
-- SAMPLE data only (fictional company "Demo Flip Labs").

-- 1. Complete the demo company's facts (adds the allotment date and FDI amount)
update companies
set facts = facts || '{"last_allotment_date":"2025-12-20","fdi_amount_inr":10000000,"uses_ai":true,"imports_goods":false}'::jsonb
where name = 'Demo Flip Labs';

-- 2. Create the tasks WF2 would create, with due dates from each obligation's due_rule
insert into tasks (company_id, obligation_id, due_date, amount_involved)
select c.id, o.id,
  case
    when o.code = 'IN-FCGPR' then ((c.facts->>'last_allotment_date')::date + 30)
    when o.due_rule like 'annual:%' then (
      select case when d < current_date then (d + interval '1 year')::date else d end
      from (select make_date(extract(year from current_date)::int,
                             split_part(substr(o.due_rule, 8), '-', 1)::int,
                             split_part(substr(o.due_rule, 8), '-', 2)::int) as d) x)
    else null
  end,
  case when o.code = 'IN-FCGPR' then (c.facts->>'fdi_amount_inr')::numeric end
from companies c
join obligations o on o.code in ('DE-ANNUAL','IRS-5472','I9','CA-PRIVACY','IN-FCGPR','IN-FLA',
                                 'IN-ODI-APR','IN-ROC-ANNUAL','IN-TP-3CEB','IN-SCHED-FA','RAISE-DD')
where c.name = 'Demo Flip Labs'
on conflict (company_id, obligation_id) do update
  set due_date = excluded.due_date, amount_involved = excluded.amount_involved, status = 'open';

insert into audit_log (company_id, event, detail)
select id, 'matched', '{"by":"06_seed_first_run.sql"}' from companies where name = 'Demo Flip Labs';

-- 3. Check: expect 11 tasks, FC-GPR ~300 days late on 2026-11-15, diligence score 85
select code, due_date, days_late, cost_to_comply_usd, penalty_accrued_usd
from task_exposure e join companies c on c.id = e.company_id
where c.name = 'Demo Flip Labs' order by due_date nulls last;

select name, overdue_filings, accrued_penalties_usd, diligence_score from compliance_debt;

-- Reset (to re-run the demo from scratch):
-- delete from tasks where company_id = (select id from companies where name='Demo Flip Labs');
-- delete from fact_evidence where company_id = (select id from companies where name='Demo Flip Labs');


-- ============================================================
-- 4/8  Coverage: taxonomy, regulation packs, coverage_map, task_cards, risk items
-- source: schema_v3_coverage.sql
-- ============================================================
-- Mizan v3: virtual consultant coverage â€” regulations, business risks, money leaks and roadmap pre-flight
-- Taxonomy: jurisdiction Ã— stage Ã— sector Ã— activity Ã— area (regulatory | risk) Ã— planned move
-- Run AFTER schema_and_seed_v2.sql and schema_v2_additions.sql. SAMPLE seed; extend freely.

-- 1. Taxonomy ---------------------------------------------------------------
create table taxonomy (
  code text primary key,             -- 'US', 'US-CA', 'IN', 'sector:healthtech', 'domain:privacy', 'stage:seed', 'act:health_data'
  kind text not null check (kind in ('jurisdiction','stage','sector','activity','domain','move')),
  family text,                       -- for domains: 'regulatory' | 'risk'
  label text not null,
  parent text references taxonomy(code),
  sort int default 0
);

insert into taxonomy (code, kind, label, parent, sort) values
-- jurisdictions (ISO 3166; sub-national as COUNTRY-REGION)
('GLOBAL','jurisdiction','Any country',null,0),('US','jurisdiction','United States',null,1),('US-DE','jurisdiction','Delaware','US',2),('US-CA','jurisdiction','California','US',3),
('US-NY','jurisdiction','New York','US',4),('US-TX','jurisdiction','Texas','US',5),('US-WA','jurisdiction','Washington','US',6),
('IN','jurisdiction','India',null,10),('IN-KA','jurisdiction','Karnataka','IN',11),('IN-MH','jurisdiction','Maharashtra','IN',12),
('EU','jurisdiction','European Union',null,20),('DE','jurisdiction','Germany','EU',21),('FR','jurisdiction','France','EU',22),
('GB','jurisdiction','United Kingdom',null,30),('SG','jurisdiction','Singapore',null,40),('AE','jurisdiction','United Arab Emirates',null,50),
('CA','jurisdiction','Canada',null,60),('BR','jurisdiction','Brazil',null,70),('AU','jurisdiction','Australia',null,80),
-- stages (by age, headcount, funding)
('stage:pre_incorporation','stage','Idea / not yet incorporated',null,1),('stage:incorporated','stage','Incorporated, pre-revenue',null,2),
('stage:first_hire','stage','First employees',null,3),('stage:fundraising','stage','Raising (pre-seed / seed)',null,4),
('stage:revenue','stage','Revenue and customers',null,5),('stage:scaling','stage','Series A+ / 50+ people',null,6),('stage:exit','stage','M&A / pre-IPO',null,7),
-- sectors (multi-select)
('sector:saas','sector','Software / SaaS',null,1),('sector:ai','sector','AI products',null,2),('sector:healthtech','sector','Healthtech / digital health',null,3),
('sector:medtech','sector','Medical devices / diagnostics',null,4),('sector:biotech','sector','Biotech / pharma',null,5),('sector:fintech','sector','Fintech / payments / lending',null,6),
('sector:crypto','sector','Crypto / digital assets',null,7),('sector:edtech','sector','Edtech',null,8),('sector:ecommerce','sector','E-commerce / D2C',null,9),
('sector:food','sector','Food / beverage',null,10),('sector:hardware','sector','Hardware / IoT',null,11),('sector:mobility','sector','Mobility / logistics',null,12),
('sector:energy','sector','Climate / energy',null,13),('sector:gaming','sector','Gaming',null,14),('sector:hrtech','sector','HR / staffing',null,15),
-- activities (what the company does, detected from docs)
('act:personal_data','activity','Processes personal data',null,1),('act:health_data','activity','Processes health data',null,2),
('act:children','activity','Serves or collects data from children',null,3),('act:payments','activity','Handles payments or money',null,4),
('act:lending','activity','Lends or brokers credit',null,5),('act:physical_goods','activity','Sells physical goods',null,6),
('act:imports','activity','Imports goods',null,7),('act:exports','activity','Exports goods or tech',null,8),
('act:cross_border_investment','activity','Cross-border investment between entities',null,9),('act:employees','activity','Has employees',null,10),
('act:contractors_abroad','activity','Uses contractors abroad',null,11),('act:esop','activity','Grants stock options',null,12),
('act:raising','activity','Raising capital',null,13),('act:ai_in_product','activity','Uses AI in product',null,14),
('act:marketing_email','activity','Sends marketing email / SMS',null,15),('act:clinical','activity','Runs clinical studies',null,16),
-- regulatory domains (the categories founders see)
('domain:corporate','domain','Corporate & governance',null,1),('domain:tax','domain','Tax',null,2),('domain:employment','domain','Employment & labour',null,3),
('domain:securities','domain','Fundraising & securities',null,4),('domain:privacy','domain','Data privacy & security',null,5),('domain:sector_license','domain','Sector licences & approvals',null,6),
('domain:product_safety','domain','Product safety & standards',null,7),('domain:consumer','domain','Consumer protection & marketing',null,8),('domain:trade_fx','domain','Trade, customs & foreign exchange',null,9),
('domain:financial_crime','domain','AML, KYC & sanctions',null,10),('domain:ip','domain','Intellectual property',null,11),('domain:ai_governance','domain','AI governance',null,12),
('domain:environment','domain','Environment & ESG',null,13),('domain:accessibility','domain','Accessibility',null,14),
-- business risks and money leaks (what you lose if you don't act)
('domain:risk_contracts','domain','Contract deadlines & auto-renewals',null,20),('domain:risk_insurance','domain','Insurance gaps',null,21),
('domain:risk_ip_ownership','domain','IP ownership & assignments',null,22),('domain:risk_cyber','domain','Security incidents & breach costs',null,23),
('domain:risk_money_left','domain','Unclaimed credits, refunds & incentives',null,24),('domain:risk_spend','domain','Duplicate & unused spend',null,25),
('domain:risk_key_person','domain','Key-person & founder risk',null,26),('domain:risk_cap_table','domain','Cap table & equity mistakes',null,27),
-- roadmap moves (pre-flight check before you do them)
('move:hire_new_country','move','Hire in a new country',null,1),('move:hire_new_state','move','Hire in a new US state',null,2),
('move:launch_new_market','move','Start selling in a new country',null,3),('move:raise_round','move','Raise a round',null,4),
('move:grant_esop','move','Start an option pool',null,5),('move:open_entity','move','Open a new entity or subsidiary',null,6),
('move:regulated_feature','move','Launch a regulated feature (health, payments, lending, kids)',null,7),
('move:sell_physical','move','Sell a physical product',null,8),('move:enterprise_customer','move','Sign an enterprise or government customer',null,9),
('move:exit','move','Sell the company / M&A',null,10);

update taxonomy set family = case when code like 'domain:risk_%' then 'risk' else 'regulatory' end where kind = 'domain';

-- 2. Regulation packs: the unit of coverage --------------------------------
create table regulation_packs (
  id uuid primary key default gen_random_uuid(),
  jurisdiction text references taxonomy(code) not null,
  domain text references taxonomy(code) not null,
  sector text references taxonomy(code),          -- null = applies to every sector
  title text not null,
  status text not null default 'draft' check (status in ('verified','draft','retired')),
  last_reviewed date,
  source_urls text[],
  created_at timestamptz default now(),
  unique (jurisdiction, domain, sector)
);

alter table obligations add column pack_id uuid references regulation_packs(id);
alter table obligations add column domain text references taxonomy(code);
alter table obligations add column stages text[];   -- stage codes when it starts to apply (null = any)
alter table obligations add column savings_estimate numeric;  -- money you could recover/avoid (risk_money_left, risk_spend)
alter table obligations add column lead_time_days int;        -- how long it takes to get done (for roadmap pre-flight)

-- Roadmap moves the founder plans; the pre-flight check prices them before they happen
create table company_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  move text references taxonomy(code) not null,
  jurisdiction text references taxonomy(code),
  sector text references taxonomy(code),
  target_date date,
  facts_delta jsonb,                 -- how facts change if the move happens, e.g. {"jurisdictions":["DE"],"activities":["act:employees"]}
  preflight jsonb,                   -- last pre-flight result: new obligations, costs, risks, lead times
  created_at timestamptz default now()
);

-- Requests for the Discovery agent to research a missing or stale pack
create table discovery_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  jurisdiction text references taxonomy(code),
  domain text references taxonomy(code),
  sector text references taxonomy(code),
  status text default 'queued' check (status in ('queued','researching','drafted','verified','failed')),
  created_at timestamptz default now(),
  unique (jurisdiction, domain, sector)
);

-- 3. Map the existing US + India obligations into packs --------------------
insert into regulation_packs (jurisdiction, domain, sector, title, status, last_reviewed) values
('US-DE','domain:corporate',null,'Delaware corporate maintenance','draft',null),
('US','domain:tax',null,'US federal tax for foreign-owned companies','draft',null),
('US','domain:employment',null,'US federal employment basics','draft',null),
('US-CA','domain:privacy',null,'California privacy','draft',null),
('IN','domain:trade_fx',null,'India FEMA / RBI reporting','verified','2026-11-15'),
('IN','domain:corporate',null,'India company law (MCA) filings','draft',null),
('IN','domain:tax',null,'India income tax & transfer pricing','draft',null),
('US','domain:securities',null,'Pre-raise readiness','draft',null),
('EU','domain:privacy',null,'GDPR baseline','draft',null),
('EU','domain:ai_governance',null,'EU AI Act','draft',null),
('US','domain:privacy','sector:healthtech','HIPAA','draft',null),
('US','domain:trade_fx',null,'US customs import readiness','draft',null),
('GLOBAL','domain:risk_ip_ownership',null,'Founder & contractor IP assignment','draft',null),
('GLOBAL','domain:risk_insurance',null,'Startup insurance basics (D&O, cyber, liability)','draft',null),
('GLOBAL','domain:risk_contracts',null,'Contract renewals & notice periods','draft',null),
('US','domain:risk_money_left',null,'US R&D tax credit','draft',null);

insert into obligations (code,title,requirement,jurisdiction,category,rule,frequency,due_hint,evidence,owner_role,currency,amount_type,status,lead_time_days) values
('RISK-IP-ASSIGN','IP assignment from founders and contractors','Every founder, employee and contractor signs an IP assignment so the company owns its code and designs. Missing assignments block diligence.','GLOBAL','risk_ip',
 '{"all":[{"fact":"headcount","op":">=","value":1}]}','once','Before raising','Signed assignments','Founder','USD','estimate','active',7),
('RISK-INSURANCE','D&O and cyber insurance before a raise','Most lead investors expect D&O cover after a priced round; cyber cover limits breach costs when you hold personal data.','GLOBAL','risk_insurance',
 '{"all":[{"fact":"activities","op":"contains","value":"act:raising"}]}','annual','Before closing the round','Policy certificates','Finance','USD','estimate','active',14),
('RISK-RD-CREDIT','US R&D tax credit not claimed','Startups with US R&D spend may claim a federal R&D credit; unclaimed credit is money left on the table.','US','risk_money',
 '{"all":[{"fact":"jurisdictions","op":"contains","value":"US"},{"fact":"activities","op":"contains","value":"act:employees"}]}','annual','With the annual tax return','Credit study + filed form','Finance','USD','estimate','active',30);

update obligations o set pack_id = p.id, domain = p.domain
from regulation_packs p
where (o.code, p.jurisdiction, p.domain) in (
  ('DE-ANNUAL','US-DE','domain:corporate'), ('IRS-5472','US','domain:tax'), ('I9','US','domain:employment'),
  ('CA-PRIVACY','US-CA','domain:privacy'), ('IN-FCGPR','IN','domain:trade_fx'), ('IN-FLA','IN','domain:trade_fx'),
  ('IN-ODI-APR','IN','domain:trade_fx'), ('IN-ROC-ANNUAL','IN','domain:corporate'), ('IN-TP-3CEB','IN','domain:tax'),
  ('IN-SCHED-FA','IN','domain:tax'), ('RAISE-DD','US','domain:securities'),
  ('RISK-IP-ASSIGN','GLOBAL','domain:risk_ip_ownership'), ('RISK-INSURANCE','GLOBAL','domain:risk_insurance'),
  ('RISK-RD-CREDIT','US','domain:risk_money_left'));

-- 4. Coverage map per company: which (jurisdiction Ã— domain) cells are covered
--    companies.facts carries: jurisdictions[], sectors[], activities[], stage
create or replace view coverage_map as
with cj as (
  select c.id company_id, j.value as jurisdiction
  from companies c, jsonb_array_elements_text(coalesce(c.facts->'jurisdictions','[]')) j
  union select id, 'GLOBAL' from companies
), cs as (
  select c.id company_id, s.value as sector
  from companies c, jsonb_array_elements_text(coalesce(c.facts->'sectors','[]')) s
), relevant_domains as (
  -- domains that apply to everyone, plus domains switched on by activities or sectors
  select c.id company_id, d.code as domain
  from companies c cross join taxonomy d
  where d.kind = 'domain' and (
       d.code in ('domain:corporate','domain:tax','domain:ip')
    or (d.code = 'domain:employment'      and c.facts->'activities' ? 'act:employees')
    or (d.code = 'domain:securities'      and (c.facts->'activities' ? 'act:raising' or c.facts->'activities' ? 'act:esop'))
    or (d.code = 'domain:privacy'         and c.facts->'activities' ? 'act:personal_data')
    or (d.code = 'domain:trade_fx'        and (c.facts->'activities' ?| array['act:imports','act:exports','act:cross_border_investment']))
    or (d.code = 'domain:financial_crime' and (c.facts->'activities' ?| array['act:payments','act:lending']))
    or (d.code = 'domain:ai_governance'   and c.facts->'activities' ? 'act:ai_in_product')
    or (d.code = 'domain:consumer'        and (c.facts->'activities' ?| array['act:physical_goods','act:marketing_email']))
    or (d.code = 'domain:product_safety'  and (c.facts->'activities' ? 'act:physical_goods' or c.facts->'sectors' ?| array['sector:medtech','sector:hardware','sector:food']))
    or (d.code = 'domain:sector_license'  and c.facts->'sectors' ?| array['sector:healthtech','sector:medtech','sector:biotech','sector:fintech','sector:crypto','sector:food','sector:energy','sector:mobility'])
    or (d.code = 'domain:environment'     and c.facts->'sectors' ?| array['sector:hardware','sector:energy','sector:food','sector:mobility'])
    -- business risks and money leaks
    or d.code in ('domain:risk_contracts','domain:risk_ip_ownership','domain:risk_money_left','domain:risk_spend')
    or (d.code in ('domain:risk_insurance','domain:risk_cap_table') and (c.facts->'activities' ?| array['act:raising','act:esop','act:employees']))
    or (d.code = 'domain:risk_cyber'      and c.facts->'activities' ? 'act:personal_data')
    or (d.code = 'domain:risk_key_person' and c.facts->'activities' ? 'act:raising')
  )
)
select cj.company_id, cj.jurisdiction, rd.domain, (select family from taxonomy where code = rd.domain) as family,
       coalesce(max(case p.status when 'verified' then 3 when 'draft' then 2 end), 0) as level,
       case coalesce(max(case p.status when 'verified' then 3 when 'draft' then 2 end), 0)
         when 3 then 'verified' when 2 then 'draft' else 'missing' end as coverage,
       array_remove(array_agg(distinct p.title), null) as packs
from cj
join relevant_domains rd on rd.company_id = cj.company_id
 and ((cj.jurisdiction = 'GLOBAL') = (rd.domain like 'domain:risk_%') or rd.domain = 'domain:risk_money_left')
left join cs on cs.company_id = cj.company_id
left join regulation_packs p
  on p.status <> 'retired' and p.domain = rd.domain
 and (p.jurisdiction = cj.jurisdiction or p.jurisdiction in (select code from taxonomy where parent = cj.jurisdiction))
 and (p.sector is null or p.sector = cs.sector)
group by cj.company_id, cj.jurisdiction, rd.domain;

-- Demo roadmap move: hiring in Germany next quarter
insert into company_plans (company_id, move, jurisdiction, target_date, facts_delta)
select id, 'move:hire_new_country', 'DE', date '2027-03-01', '{"jurisdictions":["DE","EU"],"activities":["act:employees"]}'::jsonb
from companies where name = 'Demo Flip Labs';

-- 5. Give the demo company its taxonomy facts
update companies set facts = facts || '{
  "jurisdictions":["US","IN"],
  "sectors":["sector:saas","sector:ai"],
  "activities":["act:personal_data","act:employees","act:cross_border_investment","act:raising","act:ai_in_product"],
  "stage":"stage:fundraising"
}'::jsonb
where name = 'Demo Flip Labs';

-- 6. Every item names its kind of loss and links its evidence ----------------
alter table obligations add column risk_types text[];  -- fine | lawsuit | loss_of_asset | loss_of_licence | budget_leak | delay | reputation

create table obligation_evidence (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid references obligations(id) on delete cascade,
  kind text not null check (kind in ('official_source','case_or_enforcement','guidance','calculation')),
  url text not null,
  quote text not null,                -- exact line that supports the requirement or the amount
  supports text,                      -- which field it backs: requirement | deadline | penalty | savings
  retrieved_on date default current_date
);

update obligations set risk_types = case code
  when 'IN-FCGPR'       then array['fine','delay']
  when 'IN-FLA'         then array['fine']
  when 'IN-ODI-APR'     then array['fine']
  when 'IN-ROC-ANNUAL'  then array['fine','loss_of_licence']
  when 'IN-TP-3CEB'     then array['fine']
  when 'IN-SCHED-FA'    then array['fine']
  when 'DE-ANNUAL'      then array['fine','loss_of_licence']
  when 'IRS-5472'       then array['fine']
  when 'I9'             then array['fine']
  when 'CA-PRIVACY'     then array['fine','lawsuit']
  when 'RAISE-DD'       then array['delay','reputation']
  when 'RISK-IP-ASSIGN' then array['loss_of_asset','lawsuit','delay']
  when 'RISK-INSURANCE' then array['lawsuit','budget_leak']
  when 'RISK-RD-CREDIT' then array['budget_leak']
  else risk_types end;

insert into obligation_evidence (obligation_id, kind, url, quote, supports)
select id, 'official_source', 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12393',
       'Late Submission Fee for reporting delays under FEMA: INR 7,500 + (0.025% x amount involved x years of delay) for flow returns such as FC-GPR',
       'penalty'
from obligations where code = 'IN-FCGPR';

-- One row per task with everything a card needs: why it applies, what you could lose, and the proof
create or replace view task_cards as
select e.task_id, e.company_id, e.code, o.title, o.domain, t.family, o.risk_types,
       e.due_date, e.days_late, e.cost_to_comply_usd, e.penalty_accrued_usd, e.avoidable_if_on_time_usd,
       o.savings_estimate, o.lead_time_days, o.amount_type,
       (select jsonb_agg(jsonb_build_object('fact', f.fact_key, 'quote', f.quote, 'document', d.filename))
          from fact_evidence f left join company_documents d on d.id = f.document_id
          where f.company_id = e.company_id and f.status = 'confirmed') as company_evidence,
       (select jsonb_agg(jsonb_build_object('kind', v.kind, 'url', v.url, 'quote', v.quote, 'supports', v.supports))
          from obligation_evidence v where v.obligation_id = o.id) as source_evidence
from task_exposure e
join tasks tk on tk.id = e.task_id
join obligations o on o.id = tk.obligation_id
left join taxonomy t on t.code = o.domain;


-- ============================================================
-- 5/8  Idea mode: stages, roadmap view, clarifying questions, research threads
-- source: schema_v4_idea_mode.sql
-- ============================================================
-- Mizan v4: idea mode, founder roadmap by stage, clarifying questions, research threads
-- Run AFTER schema_v3_coverage.sql. Tested on Postgres 16.

-- 1. A company can start as just an idea
alter table companies add column mode text default 'company' check (mode in ('idea','company'));
alter table companies add column idea_text text;          -- the founder's own words

-- 2. Stages in order (the roadmap spine)
create table stage_templates (
  stage text primary key references taxonomy(code),
  position int not null,
  title text not null,
  typical_moves text[]                                     -- moves founders usually make at this stage
);
insert into stage_templates values
('stage:pre_incorporation',1,'Idea',array['move:open_entity']),
('stage:incorporated',2,'Incorporate',array['move:open_entity','move:grant_esop']),
('stage:first_hire',3,'First hires and contractors',array['move:hire_new_state','move:hire_new_country']),
('stage:fundraising',4,'Raise',array['move:raise_round','move:grant_esop']),
('stage:revenue',5,'Launch and sell',array['move:launch_new_market','move:regulated_feature','move:sell_physical','move:enterprise_customer']),
('stage:scaling',6,'Scale',array['move:hire_new_country','move:open_entity','move:launch_new_market']),
('stage:exit',7,'Exit',array['move:exit']);

-- The founder's own roadmap: which stages, in what order, which is current
create table company_stages (
  company_id uuid references companies(id) on delete cascade,
  stage text references taxonomy(code),
  position int not null,
  label text,                                              -- founder's words, e.g. "Clinic pilot"
  status text not null default 'upcoming' check (status in ('done','current','upcoming')),
  target_date date,
  primary key (company_id, position)
);

-- 3. Tasks belong to a stage; future-stage tasks are 'planned' (from a hypothetical match)
alter table tasks add column stage text references taxonomy(code);
alter table tasks drop constraint if exists tasks_status_check;
-- statuses now: planned | open | done | missed | not_applicable

-- 4. Clarifying questions: only the ones that change the answer
create table clarifying_questions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  question text not null,
  why text not null,                                       -- what it decides
  fact_key text not null,                                  -- which fact the answer sets
  options jsonb not null,                                  -- [{"label":"Only remind","value":{"activities_remove":["act:clinical"]}}, â€¦]
  answer jsonb,
  status text default 'open' check (status in ('open','answered','skipped')),
  created_at timestamptz default now()
);

-- 5. Research threads: plain-language answers with official sources
create table research_threads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  stage text references taxonomy(code),
  question text not null,
  answer jsonb,                    -- {"short":â€¦, "steps":[â€¦], "risk_types":[â€¦], "needs_professional": "â€¦" | null}
  sources jsonb,                   -- [{"url":â€¦, "title":â€¦, "quote":â€¦, "summary":â€¦}]
  verified boolean default false,  -- true once the Verifier matched every claim to a quote
  added_to_roadmap boolean default false,
  created_at timestamptz default now()
);

-- 6. Stage starter obligations (apply to most startups; amounts left null until sourced)
insert into obligations (code,title,requirement,jurisdiction,category,rule,frequency,due_hint,evidence,owner_role,currency,amount_type,status,stages,risk_types,lead_time_days,domain) values
('US-83B','File 83(b) election for founder shares','File within 30 days of receiving restricted founder stock, or tax may be due as shares vest.','US','tax',
 '{"all":[{"fact":"jurisdictions","op":"contains","value":"US"}]}','once','Within 30 days of the share grant','IRS-stamped copy','Founder','USD','estimate','active',array['stage:incorporated'],array['fine'],1,'domain:tax'),
('US-FORM-D','SEC Form D for a private round','File Form D within 15 days after the first sale of securities in a Regulation D offering, plus state notices.','US','securities',
 '{"all":[{"fact":"jurisdictions","op":"contains","value":"US"},{"fact":"activities","op":"contains","value":"act:raising"}]}','per-event','Within 15 days of first sale','EDGAR filing receipt','Founder','USD','estimate','active',array['stage:fundraising'],array['fine','delay'],3,'domain:securities'),
('GLOBAL-FOUNDER-IP','Founders assign pre-company IP','Each founder assigns code, designs and domains created before incorporation to the company.','GLOBAL','risk_ip',
 '{"all":[{"fact":"jurisdictions","op":"contains","value":"US"}]}','once','With incorporation','Signed assignment','Founder','USD','estimate','active',array['stage:incorporated'],array['loss_of_asset','delay'],2,'domain:risk_ip_ownership');

update obligations set stages = array['stage:fundraising'] where code in ('RAISE-DD','RISK-INSURANCE');
update obligations set stages = array['stage:first_hire'] where code in ('I9','RISK-IP-ASSIGN');

insert into obligation_evidence (obligation_id, kind, url, quote, supports)
select id, 'official_source', 'https://www.sec.gov/resources-small-businesses/exempt-offerings/filing-form-d-notice', 'Form D must be filed within 15 days after the first sale of securities in the offering', 'deadline'
from obligations where code = 'US-FORM-D';

-- 7. Roadmap view: one row per stage with its to-dos and what you could lose
create or replace view roadmap as
select cs.company_id, cs.position, cs.stage, coalesce(cs.label, st.title) as title, cs.status, cs.target_date,
       count(t.id) filter (where t.status in ('planned','open')) as todos_open,
       count(t.id) filter (where t.status = 'done') as todos_done,
       (select array_agg(distinct rt) from tasks t2 join obligations o2 on o2.id = t2.obligation_id, unnest(o2.risk_types) rt
          where t2.company_id = cs.company_id and t2.stage = cs.stage) as could_lose,
       min(o.lead_time_days) filter (where t.status in ('planned','open')) as shortest_lead_days,
       max(o.lead_time_days) filter (where t.status in ('planned','open')) as longest_lead_days
from company_stages cs
join stage_templates st on st.stage = cs.stage
left join tasks t on t.company_id = cs.company_id and t.stage = cs.stage
left join obligations o on o.id = t.obligation_id
group by cs.company_id, cs.position, cs.stage, cs.label, st.title, cs.status, cs.target_date;

-- 8. Demo idea-stage founder (Case 1 in the case studies: Lina, "Dosely")
insert into companies (name, owner_email, mode, idea_text, facts) values
('Dosely','lina@example.com','idea',
 'I''m building an app that reminds elderly people to take their meds and pings their daughter or son if they miss one. I want to pilot it with a clinic in Austin, hire a developer in Poland, raise money from angels this spring, and later launch in Dubai.',
 '{"jurisdictions":["US","US-TX"],"sectors":["sector:healthtech"],"activities":["act:personal_data","act:health_data","act:contractors_abroad","act:raising"],"stage":"stage:pre_incorporation"}');

insert into company_stages (company_id, stage, position, label, status)
select c.id, v.stage, v.pos, v.label, v.status from companies c,
 (values ('stage:pre_incorporation',1,'Idea','done'),('stage:incorporated',2,'Incorporate','current'),
         ('stage:revenue',3,'Clinic pilot','upcoming'),('stage:first_hire',4,'First contractor','upcoming'),
         ('stage:fundraising',5,'Angel round','upcoming'),('stage:scaling',6,'Launch in UAE','upcoming')) v(stage,pos,label,status)
where c.name = 'Dosely';

insert into company_plans (company_id, move, jurisdiction, facts_delta)
select id, 'move:hire_new_country', 'EU', '{"jurisdictions":["EU"],"activities":["act:contractors_abroad"]}'::jsonb from companies where name='Dosely'
union all
select id, 'move:launch_new_market', 'AE', '{"jurisdictions":["AE"]}'::jsonb from companies where name='Dosely';

insert into clarifying_questions (company_id, question, why, fact_key, options)
select id, q, w, k, o::jsonb from companies,
 (values ('Will the app only remind, or also suggest or change doses?','Dose advice can make the app regulated medical software.','sectors',
          '[{"label":"Only remind","value":{}},{"label":"Suggest doses","value":{"sectors_add":["sector:medtech"]}},{"label":"Not sure","value":{"both_paths":true}}]'),
         ('Will the clinic send you patient information?','If yes, you work on the clinic''s behalf and health-privacy contracts apply.','activities',
          '[{"label":"Yes","value":{"activities_add":["act:health_data"],"acts_for_provider":true}},{"label":"No, families sign up","value":{}},{"label":"Not sure","value":{"both_paths":true}}]')) q(q,w,k,o)
where name = 'Dosely';

-- Tasks the matcher would create for Dosely, by stage (planned for future stages)
insert into tasks (company_id, obligation_id, stage, status)
select c.id, o.id, coalesce(o.stages[1], 'stage:incorporated'),
       case when o.stages[1] = 'stage:incorporated' then 'open' else 'planned' end
from companies c join obligations o on o.code in ('US-83B','GLOBAL-FOUNDER-IP','US-FORM-D','RISK-INSURANCE','RISK-IP-ASSIGN','I9')
where c.name = 'Dosely';


-- ============================================================
-- 6/8  Fix packs: forms, cost items, money leaks, reports, stage_budget
-- source: schema_v5_fix_packs.sql
-- ============================================================
-- Mizan v5: every item ends in a fix â€” forms, processes, money-leak plans, budgets, investor report
-- Run AFTER schema_v4_idea_mode.sql. Tested on Postgres 16.

-- 1. Fix packs: the ready-to-use output attached to an obligation or a risk
create table fix_packs (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid references obligations(id) on delete cascade,
  kind text not null check (kind in ('form','process','plan')),
  title text not null,
  explain text,                         -- "In plain words" line for first-time founders
  template jsonb,                       -- for forms: {"fields":[{"key","label","fact_key"|null,"sensitive":bool}], "body": "...{{field}}..."}
  steps jsonb not null,                 -- [{"order":1,"text":"Sign and mail to the IRS","when":"within 30 days","owner_role":"Founder"}]
  official_form_url text,               -- the regulator's own form, if one exists
  needs_professional text,              -- null = not needed; otherwise when and why
  status text default 'draft' check (status in ('draft','verified','retired')),
  last_checked date,
  source_urls text[]
);

-- 2. A founder's filled copy of a form (sensitive fields are never stored)
create table generated_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  fix_pack_id uuid references fix_packs(id),
  filled jsonb not null,                -- field key -> value; fields marked sensitive stay null ("enter yourself")
  missing_fields text[],                -- shown as "Needs you"
  file_path text,                       -- Supabase Storage PDF
  created_at timestamptz default now()
);

-- 3. Cost of doing it right, per item, with a source (budget per stage)
create table cost_items (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid references obligations(id) on delete cascade,
  label text not null,                  -- "IRS filing fee", "Delaware filing fee", "Lawyer review"
  kind text not null check (kind in ('government_fee','professional_estimate','tool','insurance_quote')),
  currency text default 'USD',
  amount_low numeric,                   -- null = researching
  amount_high numeric,
  amount_type text check (amount_type in ('confirmed_fee','estimate')),
  source_url text,                      -- required before an amount is shown
  last_checked date
);

-- 4. Money leaks found in the company's own invoices, contracts and accounts
create table leak_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  kind text not null check (kind in ('duplicate_tool','unused_seats','auto_renewal','unclaimed_credit','overpaid_fee','penalty_avoidable','other')),
  title text not null,
  evidence text not null,               -- "Invoices #2041, #2077", "Contract Â§7"
  document_id uuid references company_documents(id),
  annual_amount numeric,                -- from the company's own documents
  notice_deadline date,                 -- for auto-renewals
  status text default 'open' check (status in ('open','planned','fixed','ignored')),
  saved_amount numeric                  -- confirmed after the fix, from new invoices
);

-- 5. Fix plans for leaks and risks: options compared, one recommended, steps
create table fix_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  title text not null,
  leak_ids uuid[],
  options jsonb not null,               -- [{"key":"A","title","summary","saves_low","saves_high","effort","recommended":true}]
  chosen text,
  steps jsonb,                          -- [{"order","text","when","owner_role","fix_pack_id"}]
  estimated_saving numeric,
  confirmed_saving numeric,
  created_at timestamptz default now()
);

-- 6. Reminders, expert handoffs and investor report snapshots
create table reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete cascade,
  channel text check (channel in ('email','whatsapp','calendar')),
  send_on date not null,
  sent_at timestamptz
);

create table expert_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  research_thread_id uuid references research_threads(id),
  task_id uuid references tasks(id),
  area text references taxonomy(code),
  jurisdiction text references taxonomy(code),
  status text default 'requested' check (status in ('requested','matched','done')),
  created_at timestamptz default now()
);

create table report_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  diligence_score int,
  body jsonb not null,                  -- areas, open items with plans, proof list, sources, generated date
  share_token text unique,              -- view-only link
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- 7. Views ------------------------------------------------------------------
-- Budget per stage: only amounts with a source; the rest counted as "researching"
create or replace view stage_budget as
select t.company_id, t.stage,
       sum(ci.amount_low)  filter (where ci.source_url is not null) as known_low,
       sum(ci.amount_high) filter (where ci.source_url is not null) as known_high,
       count(ci.id) filter (where ci.source_url is null or ci.amount_low is null) as items_researching,
       count(distinct t.id) as tasks
from tasks t
join obligations o on o.id = t.obligation_id
left join cost_items ci on ci.obligation_id = o.id
where t.status in ('planned','open')
group by t.company_id, t.stage;

-- Money leaks summary per company
create or replace view leak_summary as
select company_id,
       sum(annual_amount) filter (where status in ('open','planned')) as leaking_per_year,
       sum(saved_amount)  filter (where status = 'fixed') as saved_per_year,
       min(notice_deadline) filter (where status in ('open','planned') and notice_deadline >= current_date) as next_notice_deadline
from leak_items group by company_id;

-- 8. Seed: fix packs, cost items, demo leaks ---------------------------------
insert into fix_packs (obligation_id, kind, title, explain, template, steps, needs_professional, status, last_checked, source_urls)
select id, 'form', '83(b) election',
  'A one-page form to the IRS saying you''ll pay tax on your shares now, while they''re worth almost nothing.',
  '{"fields":[{"key":"name","label":"Taxpayer name","fact_key":"founder_name"},{"key":"address","label":"Home address","fact_key":null},{"key":"tin","label":"Taxpayer ID","fact_key":null,"sensitive":true},{"key":"property","label":"Shares","fact_key":"founder_shares"},{"key":"transfer_date","label":"Date of transfer","fact_key":"founder_share_grant_date"},{"key":"fmv","label":"Fair market value","fact_key":"founder_share_fmv"},{"key":"paid","label":"Amount paid","fact_key":"founder_share_price_paid"}]}'::jsonb,
  '[{"order":1,"text":"Fill the missing fields and sign","when":"now","owner_role":"Founder"},{"order":2,"text":"Send to the IRS (or use the IRS 83(b) form)","when":"within 30 days of the share transfer","owner_role":"Founder"},{"order":3,"text":"Use tracked mail and keep the receipt","when":"same day","owner_role":"Founder"},{"order":4,"text":"Give a copy to the company","when":"same day","owner_role":"Founder"},{"order":5,"text":"Upload the receipt to close the task","when":"after mailing","owner_role":"Founder"}]'::jsonb,
  'Optional; recommended if you paid less than fair value', 'draft', current_date, array['https://www.irs.gov']
from obligations where code = 'US-83B';

insert into fix_packs (obligation_id, kind, title, explain, steps, status, source_urls)
select id, 'process', 'File SEC Form D',
  'A short online notice to the SEC that you raised money privately. There is no SEC filing fee.',
  '[{"order":1,"text":"Get EDGAR access codes for the company","when":"2 weeks before the first close","owner_role":"Founder"},{"order":2,"text":"File Form D on EDGAR","when":"within 15 days of the first sale","owner_role":"Founder"},{"order":3,"text":"File state notices where investors live","when":"per state deadline","owner_role":"Founder"}]'::jsonb,
  'draft', array['https://www.sec.gov/resources-small-businesses/exempt-offerings/filing-form-d-notice']
from obligations where code = 'US-FORM-D';

insert into cost_items (obligation_id, label, kind, amount_low, amount_high, amount_type, source_url, last_checked)
select id, 'IRS filing fee', 'government_fee', 0, 0, 'confirmed_fee', 'https://www.irs.gov', current_date from obligations where code = 'US-83B'
union all
select id, 'SEC filing fee', 'government_fee', 0, 0, 'confirmed_fee', 'https://www.sec.gov/resources-small-businesses/exempt-offerings/filing-form-d-notice', current_date from obligations where code = 'US-FORM-D'
union all
select id, 'State notice fees', 'government_fee', null, null, null, null, null from obligations where code = 'US-FORM-D'
union all
select id, 'Lawyer review', 'professional_estimate', null, null, 'estimate', null, null from obligations where code = 'US-83B';

insert into leak_items (company_id, kind, title, evidence, annual_amount, notice_deadline)
select id, k, t, e, a, d from companies,
 (values ('duplicate_tool','Two design tools doing the same job','Invoices #2041, #2077',1440,null::date),
         ('unused_seats','9 unused seats on the team chat plan','Seat report: last login over 60 days',1800,null),
         ('auto_renewal','Analytics tool auto-renews at list price','Contract Â§7: 30-day notice',3000,current_date + 19)) v(k,t,e,a,d)
where name = 'Demo Flip Labs';


-- ============================================================
-- 7/8  Read access for the browser UI + indexes the workflows need
-- source: sql/07_grants_and_indexes.sql
-- ============================================================
-- Mizan: demo read access for the browser UI + indexes the workflows rely on.
-- Run LAST, after schema_and_seed_v2 â†’ schema_v2_additions â†’ 06_seed_first_run â†’ schema_v3_coverage â†’ schema_v4_idea_mode.
-- Safe to re-run.

-- 1. Index the workflows depend on ------------------------------------------
-- WF0 upserts companies by owner_email; without this it is a sequential scan
-- and two simultaneous intakes can create duplicate companies.
create unique index if not exists companies_owner_email_key
  on companies (owner_email) where owner_email is not null;

-- Monitor dedupe and roadmap/task lookups
create index if not exists sources_content_hash_idx on sources (content_hash);
create index if not exists tasks_company_stage_idx on tasks (company_id, stage);
create index if not exists fact_evidence_company_status_idx on fact_evidence (company_id, status);
create index if not exists events_stage_idx on events (stage, created_at desc);

-- 2. DEMO-ONLY read access for the anon key ---------------------------------
-- The browser UI reads through Supabase with the public anon key, so everything
-- granted here is world-readable to anyone who has your project URL.
--
--   DO NOT run this block on a project holding real customer data.
--
-- It is SELECT only: every write goes through an n8n webhook, never the browser.
-- Before going live, delete these grants and put real auth + row level security
-- in front of the tables instead.
grant usage on schema public to anon;

grant select on
  companies,
  obligations,
  tasks,
  alerts,
  events,
  sources,
  audit_log,
  fact_evidence,
  company_documents,
  taxonomy,
  regulation_packs,
  obligation_evidence,
  company_plans,
  discovery_requests,
  stage_templates,
  company_stages,
  clarifying_questions,
  research_threads,
  fix_packs,
  generated_documents,
  cost_items,
  leak_items,
  fix_plans,
  reminders,
  report_snapshots,
  fx
to anon;

grant select on
  task_exposure,
  compliance_debt,
  coverage_map,
  task_cards,
  roadmap,
  stage_budget,
  leak_summary
to anon;

-- expert_requests is deliberately NOT granted: it carries a founder's question
-- and context to a named professional, so it should never be world-readable.

-- 3. Check what the UI will see ---------------------------------------------
select 'companies' as src, count(*) from companies
union all select 'tasks', count(*) from tasks
union all select 'obligations (active)', count(*) from obligations where status = 'active'
union all select 'coverage_map rows', count(*) from coverage_map
union all select 'roadmap rows', count(*) from roadmap
union all select 'fix_packs', count(*) from fix_packs
union all select 'leak_items', count(*) from leak_items;


-- ============================================================
-- 8/8  View patches: widen task_cards for the UI
-- source: sql/08_view_patches.sql
-- ============================================================
-- Mizan: widen task_cards so the UI can render a card without extra round trips.
-- Run after schema_v5_fix_packs.sql (it is section 7 of mizan-complete-setup.sql).
--
-- Why: the v3 definition of task_cards omits obligation_id, stage, status,
-- jurisdiction, requirement, due_hint and the raw money fields. Every screen that
-- renders a task needs them, so each one was re-fetching tasks and obligations and
-- joining client-side. This puts the join back where it belongs.
--
-- Column order changes, so the view is dropped and recreated rather than replaced.

drop view if exists task_cards;

create view task_cards as
select e.task_id,
       e.company_id,
       tk.obligation_id,
       tk.stage,
       e.status,
       e.code,
       o.title,
       o.requirement,
       o.jurisdiction,
       o.domain,
       tx.family,
       o.risk_types,
       o.due_hint,
       o.frequency,
       o.owner_role,
       o.evidence,
       e.due_date,
       e.days_late,
       e.cost_to_comply_usd,
       e.penalty_accrued_usd,
       e.avoidable_if_on_time_usd,
       o.savings_estimate,
       o.lead_time_days,
       o.amount_type,
       o.currency,
       o.compliance_cost,
       o.penalty_flat,
       o.penalty_per_day,
       o.penalty_pct_per_year,
       o.penalty_cap,
       o.money_source_url,
       tk.amount_involved,
       tk.completed_on,
       tk.evidence_url,
       (select jsonb_agg(jsonb_build_object('fact', f.fact_key, 'quote', f.quote, 'document', d.filename))
          from fact_evidence f
          left join company_documents d on d.id = f.document_id
         where f.company_id = e.company_id and f.status = 'confirmed') as company_evidence,
       (select jsonb_agg(jsonb_build_object('kind', v.kind, 'url', v.url, 'quote', v.quote, 'supports', v.supports))
          from obligation_evidence v where v.obligation_id = o.id) as source_evidence,
       (select jsonb_build_object('id', fp.id, 'kind', fp.kind, 'title', fp.title, 'explain', fp.explain,
                                  'official_form_url', fp.official_form_url, 'needs_professional', fp.needs_professional,
                                  'last_checked', fp.last_checked, 'status', fp.status)
          from fix_packs fp where fp.obligation_id = o.id limit 1) as fix_pack
from task_exposure e
join tasks tk on tk.id = e.task_id
join obligations o on o.id = tk.obligation_id
left join taxonomy tx on tx.code = o.domain;

grant select on task_cards to anon;

-- Check: every column the screens reference should appear here.
select column_name from information_schema.columns
where table_name = 'task_cards' order by ordinal_position;


