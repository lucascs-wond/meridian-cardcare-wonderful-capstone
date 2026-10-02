# Dispute Pipeline — Agent 2 (Backoffice Decision), designed for Agent 3

Workspace: `<workspace-id>` (capstone) · All writes via `wful --profile capstone`.

## Ownership (per brief)

| Actor | Owns |
|---|---|
| Agent 1 (Mia, `40ec17ad-…`) | Dispute **intake only**: validate ownership, dedupe, file the case, fire the Agent 2 trigger |
| Agent 2 (backoffice, this build) | Asynchronous decision per rulebook, internal actions (provisional credit), state updates, audit, Campaign consumer creation |
| Campaign (paused skeleton now) | Outreach scheduling, retries, opt-out — consumes consumers Agent 2 creates |
| Agent 3 (skeleton now, built later) | The live outbound conversation; records disposition; sends collected info back to Agent 2 |

## Full-pipeline architecture

```mermaid
flowchart TB
    CALLER((Cardholder))
    CALLER -->|inbound call| A1
    subgraph A1["Agent 1 · lucas-meridian-cardcare (Mia, inbound)"]
        A1S["4 skills: account-servicing · fraud-and-disputes · card-knowledge (RAG) · rewards-redemption"]
    end
    A1 -->|"mcc-dispute-create: ownership + dedupe + complete case record"| T[("mcc_disputes<br/>shared case table")]
    A1 -->|"contract 1: X-Webhook-Secret webhook<br/>{case_id, dispute_type, customer_id, reason}"| A2
    A1 -->|"HITL: unblock Procedure + SMS"| APP
    subgraph A2["Agent 2 · mcc-backoffice (async decision)"]
        RB["rulebook: fraud_unauthorized · goods_not_received · duplicate_or_incorrect<br/>outcomes: auto_approve · auto_reject · request_info · close_resolved · blocked"]
    end
    A2 -->|"mcc-case-decide: idempotent state transitions + provisional credit once"| T
    A2 -->|"contract 2: consumer, external_id = case_id<br/>safe payload only · NEVER for blocked"| CAMP
    subgraph CAMP["Campaign · Meridian Dispute Outcomes (active)"]
        RULES["15 rules: retry / stop / opt-out matrix<br/>+ callback safety net + answered catch-all · windows · caps 4 total / 2 day"]
    end
    CAMP -->|"pre-call SMS, then outbound call"| A3
    subgraph A3["Agent 3 · mcc-outreach (outbound outcome call)"]
        TOOLS["7 tools incl. record-call-disposition (one business code per answered call)<br/>schedule-callback → ctx.campaign.callback"]
    end
    A3 -->|"attempt upsert by attempt_id"| ATT[("mcc_campaign_attempts")]
    A3 -->|"contract 3: request_info collected → mcc-case-info-submit<br/>re-fires the SAME webhook, same case_id"| A2
    T -.every transition audited by case_id.-> EV[("mcc_case_events<br/>audit trail")]
    subgraph OBS["Observability"]
        APP["Review Desk v3 (Wonderful App)<br/>unblock queue + pipeline board + case drawer"]
        CRON["mcc-stuck-case-monitor (hourly cron)<br/>stuck-case alert + TTR health (24h target / 48h concern)"]
    end
    T --> APP
    EV --> APP
    ATT --> APP
    T --> CRON
    CRON -->|"daily pipeline_health event + operator email"| EV
```

(Agent 1's internal scope diagram lives in the drawio from the Agent 1 stage; this is the pipeline-extension view: all three agents, the Campaign, the shared tables, the monitoring App, and every handoff contract.)

## Case lifecycle (single source of truth: `mcc_disputes` row, keyed by `dispute_id` = the `case_id`)

```
received ──(task starts)──► processing ──► decided(auto_approve | auto_reject | close_resolved)
                                 │                        │
                                 ├──► info_requested ──(Agent 3 collects)──► info_received ──► processing (new task, same case_id)
                                 └──► blocked   [terminal, no outreach ever]
decided ──(notification delivered, Agent 3 later)──► closed
```

- `status` (legacy coarse field) stays: `open` while in flight, `closed`/`blocked` at the end — keeps `mcc-dispute-status` and Agent 1 compatible.
- `case_state` carries the pipeline step above.
- Valid transitions are enforced in `mcc-case-decide` (the function), not in prompts.

## Dispute types (derived from intake `reason`)

| `dispute_type` | intake reasons | evidence required | eligibility rule (rulebook) |
|---|---|---|---|
| `fraud_unauthorized` | unauthorized_transaction | customer attestation, transaction metadata, card lost/stolen status | within 60-day window AND no contradicting activity (card not reported compromised *after* a card-present charge pattern) |
| `goods_not_received` | goods_not_received, subscription_cancellation | order/expected date, merchant-contact evidence | expected date passed AND merchant contact attempted |
| `duplicate_or_incorrect` | duplicate_charge, incorrect_amount | sibling transaction (same account/merchant, ±3 days) or documented amount mismatch | matching sibling txn exists OR stated correct amount differs from posted |

Outcomes: `auto_approve` · `auto_reject` · `request_info` · `close_resolved` · `blocked`.
Internal action on `auto_approve` (fraud & duplicate): provisional credit — recorded ONCE (`provisional_credit=true` + audit event; replay-safe).

## Mandatory edge cases (enforced in `mcc-case-decide` + rulebook)

| Edge case | Behavior |
|---|---|
| Missing evidence | `request_info` with a specific `required_info` — never reject for missing evidence |
| Duplicate open case | Intake reuses the open dispute (already enforced by `is_disputed`); a second webhook for the same case_id is absorbed by state checks |
| Conflicting evidence | `request_info` naming the specific conflict — never guess |
| Already resolved | `close_resolved` with NO new credit and NO new consumer (decide is idempotent on terminal states) |
| Cross-account mismatch | `blocked` — decide re-validates customer/account/transaction ownership server-side and refuses foreign data |

## Handoff contracts (all keyed by one `case_id`)

### 1 · Agent 1 → Agent 2 (authenticated webhook — chosen trigger)
- **Why webhook** (vs. schedule / manual / email / chat / slack / whatsapp — the platform's task entry triggers): the event is *per-case and instantaneous*. A schedule polls (adds latency, wastes runs, needs a "new cases" query); chat/email triggers are conversational surfaces, not system events. A webhook gives exactly one task per filed case, carries the case_id, and is authenticated independently of user identity.
- **Auth**: `X-Webhook-Secret` header (platform-native), secret held in tenant secret `MCC_BACKOFFICE_WEBHOOK` `{trigger_url, secret}` — never in code.
- **Payload (safe)**: `{case_id, dispute_type, customer_id, reason}` — no PAN, no amounts needed (Agent 2 reads the row).
- **Idempotency/replay**: duplicate deliveries create duplicate *tasks*, but `mcc-case-decide` is the single write path: a replayed task finds the case already past `processing` and no-ops (`already_decided`). No internal action or consumer can repeat.
- Fire-and-forget from `mcc-dispute-create` (same pattern as the unblock Procedure invoke): filing NEVER fails because the pipeline is down; audit records the trigger result.

### 2 · Agent 2 → Campaign (consumer creation)
- **Auth**: platform REST as a service account via `context.api`; until a tenant service account exists, the vaulted secret `MCC_PLATFORM_API` (dedicated revocable key) with `X-Workspace-Id` pinned on every request — never a raw key in code, never an unpinned call.
- One consumer per actionable outcome, **`external_id = case_id`** — creation is idempotent (lookup by external_id before create). NEVER for `blocked`.
- **Safe payload only**: first name, outcome, required_info, expected credit timing. No PAN, no full account numbers, no addresses.
- Campaign id comes from global `MCC_DISPUTE_CAMPAIGN_ID` (workspace config, not code). If unset → `notification_status = "skipped_no_campaign"`, audited, case still decided (pipeline degrades gracefully until Agent 3 ships).
- `notification_status`: `none → queued → delivered | failed` (delivered/failed written by Agent 3's disposition tool later).

### 3 · Agent 3 → Agent 2 (`request_info` loop — function built now)
- **Auth**: the submitted info travels tool → private function (platform-internal invocation, no public surface); the reprocess signal re-fires the SAME `X-Webhook-Secret`-authenticated Agent 2 webhook as contract 1.
- **Safe payload**: only the customer's stated answer (as text) + `case_id`; no PAN, no verification data — DOB checks stay inside `confirm-identity` and are never persisted to the case.
- `mcc-case-info-submit` (private): validates case is `info_requested`, appends the submitted info, sets `info_received`, fires the SAME Agent 2 webhook with the same `case_id` → new task, same case. Re-notify only if the new outcome differs (decide records `previous_outcome`).
- Attempt logging (Agent 3, table created now): `mcc_campaign_attempts`, upsert by `attempt_id` — retries can't duplicate rows.

## Data changes

- `mcc_disputes` += `dispute_type, case_state, outcome, outcome_rationale, rule_applied, required_info, info_submitted, decided_at, decision_task_id, previous_outcome, notification_status, customer_stated_details, merchant_contacted, expected_delivery_date, stated_correct_amount` (all optional — additive, existing 4 rows stay valid).
- NEW `mcc_case_events` (audit): `event_id` PK, `case_id`, `task_id`, `actor`, `event_type`, `from_state`, `to_state`, `outcome`, `rule_applied`, `detail`, `logged_at`.
- NEW `mcc_campaign_attempts` (for Agent 3): `attempt_id` PK, `case_id`, `consumer_external_id`, `attempt_number`, `technical_outcome`, `business_code`, `summary`, `retry_action`, `next_attempt_at`, `logged_at`.
- Intake behavior change: **provisional credit moves from filing time to Agent 2's `auto_approve`** (the pipeline is now the credit grantor; Agent 3 explains it). Agent 1's spoken contract + eval EV-H4 updated to match: "a specialist system reviews it and we'll call you with the outcome."

## New functions (all private; enforcement lives here, not in prompts)

| Function | Role |
|---|---|
| `mcc-case-get` | Evidence bundle: case row + transaction + ±3-day sibling txns + card status + ownership re-validation + window math + derived flags (`has_sibling_txn`, `card_reported_lost`, `window_expired`, `ownership_ok`) |
| `mcc-case-decide` | THE gate: validates transition + ownership + outcome eligibility; idempotent; writes outcome/rationale/rule, internal action (credit) once, audit events |
| `mcc-case-notify` | Idempotent Campaign-consumer creation (external_id=case_id), safe payload, never for blocked; audits; graceful when no campaign |
| `mcc-case-info-submit` | Agent 3 → Agent 2 loop: store info, `info_received`, re-fire webhook |
| `mcc-case-events-list` | Audit trail + case list for the monitoring app (by case_id or state) |
| (modified) `mcc-dispute-create` | + dispute_type/evidence params, case_state=received, no credit at filing, fire webhook |
| (modified) `mcc-dispute-status` | expose case_state/outcome/notification_status so Agent 1 answers callbacks |

## Agent 2 (backoffice agent `mcc-backoffice`)

- Mode `backoffice`, no voice. Skill `dispute-processing`: the rulebook prompt (decision table + edge cases + tool order: evidence → decide → notify) with tools `case-evidence`, `case-decide`, `case-notify` (thin wrappers).
- The LLM applies judgment *within* the rulebook; every hard rule double-enforced in `mcc-case-decide`.
- Webhook entry trigger configured on the agent; secret stored as tenant secret.
- 8+ evals: 3 dispute types × happy path + the 5 mandatory edge cases.
- Metrics/tags: task-level outcome tags (`case-auto-approve`, `case-request-info`, `case-blocked`, …) for processing-success / request-info-rate / blocked-rate.

## Built now for Agent 3 (so nothing here changes later)

- Agent 3 skeleton agent (conversational, outbound) — prompt is a placeholder.
- Paused Campaign bound to Agent 3; id in `MCC_DISPUTE_CAMPAIGN_ID`.
- `mcc_campaign_attempts` table + `mcc-case-info-submit` + `notification_status` field + consumer contract above.

---

## Build log — verified facts (2026-08-30)

- Webhook trigger `<redacted-id>` on `mcc-backoffice` (`329060be-…`); secret in tenant secret `MCC_BACKOFFICE_WEBHOOK`. **Platform gap:** the webhook body/query never reaches the task runtime (verified across 7 payload shapes) → the claim contract above is the handoff; the webhook stays the per-case, secret-authenticated doorbell.
- Live E2E, zero manual steps: chat with Mia → case `DSP-1788125177241` filed (attestation captured, no credit promise) → task `fbb0937d` → auto_approve + provisional credit → consumer `DSP-1788125177241` in paused Campaign `913aa411-…`. Replay-safety proven: repeated webhook fire with empty queue → clean no-op task.
- Rulebook proven on legacy cases too: DSP-4001 (duplicate rule: sibling TXN-00116) and DSP-4002 (fraud rule) auto-approved with correct rationales and audit trails in `mcc_case_events`.
- Evals: backoffice runtime ignores `start_tool_mocks` → nine state-seeded integration scenarios (fixtures `EVL-*`, seeder `backoffice-repo/scripts/seed_backoffice_cases.py`); batch run `d11ab06f`: **9/9**. One real behavior bug found and fixed via evals (fraud approvals now actively test the attestation against sibling activity).
- Observability: six `case-*` task tags + tags.md task tagger; metrics processing-success (≥95%), request-info rate (≤30%), blocked rate (~0%).
- `context.api` requires a tenant service account (none exists; creating one is a tenant-level act — ask Lucas). Interim: `mcc-case-notify` falls back to secret `MCC_PLATFORM_API`, always sending `X-Workspace-Id`.
- Registered functions now 22 (`mcc-case-get/decide/notify/info-submit/events-list/claim` added); `mcc-transactions-search` now returns `transaction_id` (live-E2E bug find).

## Open items (next stage)

1. Monitoring App: extend Review Desk with dispute-case views (`mcc-case-events-list` is the ready-made API).
2. Agent 3 (Days 8–9): pre-call SMS, trust-first vs basic openings, per-outcome scripts, `record_call_disposition` + `mcc_campaign_attempts` upserts, retry/opt-out/callback rules, activate Campaign.
3. Day 10: three E2E cases, case_id traceability demo, pipeline metrics targets + stuck-case alert monitor, Go-Live checklist.
4. Agent 1 vs brief: add a payment-processing journey; add a fallback STT provider.
5. DECIDED (Lucas, 2026-08-30): no tenant service account for the capstone — the `MCC_PLATFORM_API` secret fallback (always workspace-pinned) stays. If the CTO asks: functions would normally authenticate as a service account (scoped, auditable, survives offboarding); the fallback exists because the tenant has none and creating one is a tenant-admin act. The code already prefers `context.api` automatically the moment a service account is bound.

## Build log — second wave (2026-08-30, evening)

- **Review Desk v2** live (git-backed; push-to-main auto-deploys): unblock queue restored + dispute-pipeline tab (state board, audit trail, notification status, attempts). Resources attached: mcc-case-events-list + the three pipeline tables.
- **Agent 1**: payment journey shipped (two-phase account-make-payment → mcc-payment-submit; overpayment/duplicate/no-bank guards; EV-H7 + EV-F6 green) and Deepgram STT fallback. Smoke suite 7/7 on main.
- **Agent 3 (mcc-outreach)** built and eval-green (4/4): trust-first/basic openings (deterministic A/B by case id), DOB verification, per-outcome scripts, request_info collection → submit-case-info → reprocess webhook, one-disposition rule. call-briefing binds the call to its case BY THE DIALED NUMBER — no campaign context needed.
- **Campaign**: 9 retry/stop/opt-out rules wired to business-code call tags (tag_conditions), Mon–Sat call windows, caps 4 total / 2 per day. Verified constraint: one consumer per phone → notify re-points the existing consumer to the newest case (and skips opted-out customers).
- **Pre-call SMS**: sent once per case from mcc-case-notify at queue time (bank name, safe reason, window, never-ask warning), delivery/failure audited.
- **Stuck-case alert**: mcc-stuck-case-monitor cron function (state budgets: received 1h, processing 2h, info_received 2h, decided 48h/failed-notification; one audit event per case per day; operator email). Manual trigger proven live (stuck_count 0). Hourly schedule: confirm in UI.
- Live loop demo on real data: DSP-LIVE-RI-1 (goods, no evidence) → request_info decided → consumer re-pointed with the review's exact question in consumer data.

## Human steps remaining

Done since: outbound number, campaign activation, real test calls, cron schedule, governance, Go-Live checklist. Still Lucas's: regenerate the deck (paste `certification-presentation.md` into Claude design), optional UI alert monitor, one live scheduled-callback proof (optional, 30s during any call), OG Buddy dry run, book the CTO session.

## Live telephony validation (2026-08-31, real phone)

Proven over real calls: full outbound loop (DSP-LIVE-CALL-1 → closed/delivered, disposition `completed`); `bad_time` → automatic campaign retry; wrong-DOB double-failure → lockout → `wrong_number`, zero case details leaked; the complete `request_info` loop (collected on-call → submitted → automatic reprocess → `auto_approve` on the new evidence); pre-call SMS delivered; inbound Agent 1: live payment executed (MC-93199216), HITL unblock case filed to the Review Desk queue, prompt injection deflected **and raised the first live governance incident** (System Manipulation), PII masking visible in transcripts, English-only + human transfer behaviors correct.

Live-call fixes shipped during testing: silent tool runs on outbound (first words = the introduction), office ambience on Agent 3, kv.get throw-on-missing wrapper, flat customers-lookup shape, call-time windows require the `days` array (a `day_of_week` field saves as null and never dials), and consumers that completed a call are recreated — not re-pointed — when a changed outcome needs outreach.

Post-test state: campaign ACTIVE with business-hour windows (Mon–Fri 9–20, Sat 10–18) and an empty queue; Ava's record carries the presenter's real phone; case DSP-LIVE-RI-1 parked at decided/auto_approve awaiting its delivery call; unblock case BRC-1788193404120 pending in the Review Desk.

## Review Desk v3 (2026-08-31, evening)

Rebuilt after live UI review in Chrome: pipeline-health cards read the monitor's own audit events (live median TTR vs target, stuck cases flagged today), state pills double as filters, search box, eval fixtures hidden behind a toggle, case detail moved into a right-hand drawer (actor-colored audit timeline, attempts incl. next scheduled attempt, copy-ID), unblock queue gained a two-step confirm and a decision-history section, theme follows the platform (light/dark), and decisions/case-opens emit SDK analytics events. Verified deployed and exercised in the browser.

## Exact-time callbacks (2026-08-31)

The brief's `callback_requested` row is now fully wired — scheduling is platform-native, never prompt-only:

- **Tool** `schedule-callback` (Agent 3): validates the requested time (parseable, ≥5 min out, ≤14 days), then calls the runtime's campaign API — `ctx.campaign.callback(<ISO time>)` — which schedules a first-class platform callback (they appear in `campaigns callback-list`; `enforce_call_times_for_callbacks=false` lets an explicitly requested time sit outside the normal windows). Discovered by runtime introspection: the tool context exposes `ctx.campaign.{callback, cancelCallback, getConsumerInfo, addContact, removeContact}` — there is no public REST route for callback creation; it is call-context-bound by design.
- **Flow** (prompt): confirm date + time + timezone back to the customer → `schedule-callback` → confirm once more in their words → disposition `callback_requested` (time in the summary). Works pre-verification — scheduling discloses nothing. If the tool fails, the agent must NOT pretend a callback is booked: it falls back to `bad_time` (next-window retry).
- **Durable record**: the disposition tool passes the scheduled time through to `mcc-attempt-record` → `mcc_campaign_attempts.next_attempt_at` + `retry_action="scheduled_callback"`, so the Review Desk shows the next scheduled attempt.
- **Campaign rule** (15 rules now): tag `callback_requested` → retry in 24h, max 2 — a bounded SAFETY NET only. The platform callback makes the exact-time dial; if that call completes, its own disposition resolves the consumer and the safety net never fires.

## Time-to-resolution & pipeline health (2026-08-31)

Named target, measured hourly by `mcc-stuck-case-monitor` (not just implied by state budgets):

- **TTR** = `filed_at` → the case's last audit event, over closed cases (EVL fixtures excluded). **Target: median ≤ 24h · concern: > 48h.** Full-pipeline success rate keeps its own metric (`mcc-case-processing-success`, ≥95%/concern <85%).
- The cron writes one `pipeline_health` audit event per day (case_id `PIPELINE-HEALTH`) with median/max TTR vs targets, and a concern breach joins the operator email alongside stuck cases.
- Verified live: first health run measured the real closed case at **median 0.41h** (DSP-LIVE-CALL-1: filed 14:19:39Z → delivered & closed 14:44:19Z) — well inside target.
- Per-state budgets stay as the early-warning layer: received 1h · processing 2h · info_received 2h · decided 48h · failed notifications immediately.

## Opening variants — evidence & decision (honest read)

- **Mechanism** (live): deterministic A/B split in `call-briefing` (even last case-id digit → `trust_first`, odd → `basic`); every attempt row stamps its variant (`[basic opening] …`) so retention/completion can be compared per variant from `mcc_campaign_attempts` alone.
- **Evidence so far**: the 5 real attempts all drew `basic` (both live case ids happened to have even-digit parity mapping to basic) — with one persona and n=5, no statistically honest winner exists. Both variants are eval-green (OV-H1 exercises `trust_first`, OV-H2/H3 `basic`); the live `basic` calls completed delivery and info-collection with zero early hang-ups.
- **Decision**: keep `trust_first` as the preferred default going forward — it front-loads identity, bank, purpose, and consent ("is now a good time?"), which is what earned trust fastest in the live calls' opening seconds — while the A/B stamp keeps accumulating real evidence. What we will NOT do is declare a data-driven winner from n=5; the CTO gets the mechanism, the stamps, and the criteria (early-hang-up rate + completion rate per variant).

## Documented prompt iteration — fraud rule (found by eval BO-5)

The clearest of the seven prompt iterations this build went through, end to end:

- **Symptom**: eval `bo_conflicting_evidence` (BO-5) — a fraud attestation of "card was with me, I never made this charge" alongside undisputed card-present sibling charges at the same merchant — was auto-approved. First diagnosis blamed the agent; re-reading the trace showed the agent was RIGHT under the old prompt: the seed data had marked the siblings `is_disputed`, so no contradiction existed. After fixing the fixture, the eval failed honestly: the rulebook only checked that an attestation was *present*, never that it was *consistent*.
- **Before** (rule line): approve when "filed within the 60-day window AND customer attestation present, no card compromise flags."
- **After** (rule line, shipped): "…**Before approving, actively test the attestation against the evidence**: undisputed sibling activity on the same card at the same merchant or location during the period the attestation covers, a location claim that conflicts with where the sibling charges happened, or card-present activity while the customer claims the card was elsewhere — each of these is a CONTRADICTION → `request_info` naming it, never an approval."
- **Result**: BO-5 green for the right reason; the house rule held (the *fixture* was wrong once and got fixed; the rubric was never weakened to make a failure pass).

## Documented iteration #2 — dispute-status hallucination (found on a REAL call, 2026-08-31)

- **Symptom**: on a live call, a customer re-reported an already-disputed charge. `fraud-file-dispute` correctly refused (`already_disputed`), and the agent then performed fake tool-use theater — "I'll check the current status… I'm still looking into that… I see the dispute is already in progress, and a specialist is currently reviewing the details" — with NO status check run. The case had been decided (auto_approve, provisional credit) a day earlier; the invented status was wrong in every part.
- **Root cause** (a tooling gap, not a prompt gap): the `mcc-dispute-create` error note said "check mcc-dispute-status" — but Agent 1 had **no tool exposing that function**. Instructed to check a status it could not check, the model fabricated a plausible one. Deterministic: it happened on both calls that hit this path.
- **Fix (three layers, tool-first per the house rule)**: (1) new `fraud-dispute-status` tool wrapping the existing function, with agent_notes that translate `case_state`/`outcome` into exact customer-facing phrasing (shared/dispute-status.ts); (2) `fraud-file-dispute` now auto-fetches the existing case's REAL state on `already_disputed` and returns it in the same tool result — the agent never faces that error without grounded facts again (and gets an explicit "status UNKNOWN — do not guess" note if even the lookup fails); (3) a GROUNDING rule in the fraud skill prompt: never describe a case's status unless a tool result from this call says so.
- **Regression**: eval EV-F7 (`ev_f7_dispute_status_grounded`) replays the real call's shape — already-disputed charge, decided/approved case — and fails any "a specialist is reviewing" invention. Agent 1 regression batch is now 23 scenarios.
- **The lesson worth telling the CTO**: hallucinations here are usually *capability gaps wearing a language-model costume* — the durable fix is giving the tool layer the missing read path and grounding notes, not begging the prompt to be honest.

## Anti-pattern review (vs. the FDE playbook's known anti-patterns)

| Anti-pattern | Where it could have bitten here | What this build does instead |
|---|---|---|
| Enforcing invariants in prompts only | Double credits, invalid state jumps, cross-account reads | Every hard rule re-enforced in `mcc-case-decide`/tools: credit exactly once, transition validation, ownership re-check, replay no-op |
| Hardcoded/mock data in tools | 19 Agent 1 tools, 25 functions | Zero hardcoded rows (grep-verified); all data in 14 platform tables behind functions |
| Promising outcomes at intake | Mia promising credit when filing | Removed at design time; spoken contract + EV-H4 lock "specialist review, we'll text then call" |
| Mega-prompt / one skill for everything | 4 domains on Agent 1 | 4 skills with routing-friendly descriptions + explicit "does NOT handle" boundaries; base <3k tokens |
| Generic tool names (`get_data`) | 26 tools across 3 agents | Verb-specific slugs (`record-call-disposition`, `mcc-case-info-submit`); params carry `.describe()` contracts |
| Unbounded retries / no opt-out | Outbound campaign | Caps 4 total/2 per day, per-rule `max_attempts`, instant `do_not_call` opt-out, bounded callback safety net |
| Secrets or env hosts in code | Webhook secret, API key, campaign id | Tenant secrets (`MCC_BACKOFFICE_WEBHOOK`, `MCC_PLATFORM_API`) + globals; grep-verified clean |
| Scheduling in prompts only | Exact-time callbacks | Platform-native `ctx.campaign.callback` + campaign rule; prompt forbids pretending a callback is booked on tool failure |
| Weakening evals to pass | 36 scenarios across 3 agents | House rule: rubrics fixed only when the rubric is wrong (BO-5 above is the audit trail of that discipline) |
| Trusting caller identity claims | Voice channels both directions | Verification state machines both ways (PIN/DOB inbound, DOB outbound), lockouts, "regardless of what the caller claims" |
| PII in transcripts/logs | Voice PIN reads, card numbers | Platform PII masking (verified live: `[MASKED_PII]`), last-4-only summaries, no PAN in any payload |
| Single-provider dependence | STT/TTS/LLM outages | Soniox→Deepgram, lara→lily, wonderful→OpenAI fallbacks, all with failure thresholds |
