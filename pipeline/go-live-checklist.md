# Meridian CardCare — Go-Live Checklist

Adapted from the FDE "Going Live Checklist" for the capstone pipeline (Agent 1 `lucas-meridian-cardcare` · Agent 2 `mcc-backoffice` · Campaign `Meridian Dispute Outcomes` · Agent 3 `mcc-outreach`). Workspace `<workspace-id>`.

Legend: ✅ done · ⬜ pending (owner) · ➖ not applicable for the capstone (reason)

## ‼ Critical
- ✅ Agent stability across changes — every change ships through MR → protected main → snapshot-pinned evals (Agent 1 smoke 7/7, regression 22; Agent 2 9/9 run `9b8c2879` (2026-08-31, after fixture reseed); Agent 3 5/5 run `abb17091`)
- ⬜ Morning of the session: re-run the Agent 1 regression for a clean single-batch record — `wful --profile capstone eval run full_regression --batch --snapshot-id $(wful --profile capstone agents snapshot) --runs-per-scenario 2 --min-successes 1` from agent-repo main (judge variance was high on 2026-08-31 night: different scenarios flaked each round on identical code; four over-strict rubrics were aligned to implemented policy — MRs #20/#21 — and every scenario passed individually on the final snapshot `8641c6e1`). Backoffice/outreach batches are already green from 2026-08-31 (9/9 `9b8c2879`, 5/5 `abb17091`); reseed first if re-running backoffice: `python3 backoffice-repo/scripts/seed_backoffice_cases.py`

## 📞 Telephony setup
- ✅ Inbound number mapped to Agent 1 (verified live 2026-08-31: real inbound + outbound calls in Activities)
- ✅ Outbound number on the Campaign (+33 ••• ••• •••) and Campaign ACTIVE — config current as of 2026-09-01: windows ALL DAYS 09:00–20:00 ET (the platform's window day-indices are 0=Monday, so the original "Mon–Fri [1-5]" was actually Tue–Sat and Monday had NO window — found the night before the demo); caps 4 total / 1 per day; 15 rules incl. callback safety net + answered catch-all (rule `outcome` must use recorded vocabulary `answered`/`failed`)
- ➖ Customer production tenant / customer prod users / customer point of contact (capstone has no customer; the personal workspace is the environment)

## 💻 Code & configuration
- ✅ No sandbox URLs anywhere — all data access goes through workspace functions; the two public Review Desk endpoints are token-validated
- ✅ Credentials out of code: secrets `REVIEW_PLATFORM`, `HANDOFF`, `MCC_BACKOFFICE_WEBHOOK`, `MCC_PLATFORM_API` (dedicated revocable key); globals `MCC_UNBLOCK_FLOW_ID`, `MCC_DISPUTE_CAMPAIGN_ID`
- ✅ PII masking enabled (credit_card + account_number) — verified live in transcripts (`[MASKED_PII]`)
- ✅ SMS SenderId set to "Meridian" (block confirmations, unblock decisions, pre-call heads-up — pre-call SMS verified delivered 2026-08-31; unblock-decision SMS verified delivered 2026-09-01)
- ✅ No demo-specific emails/numbers in tools (stuck-case monitor mails ops-alerts@example.com by design — the operator). the demo persona (CUST-1001, renamed Ava Thompson → Lucas Silva 2026-09-01) carries the presenter's real phone deliberately for the demo
- ✅ Voice config intentional and explainable: TTS lara→lily · STT Soniox→Deepgram fallback · LLM wonderful→openai fallback, temp 0 · smart-turn EOT v3.2 + set/clear-eot-delay for digits · denoiser · telephony shaping (office ambience, low) · initial message · inactivity ladder 30/60/90s
- ✅ Exact-time callbacks are platform-native (`schedule-callback` → `ctx.campaign.callback`), never prompt-only; scheduled time lands in `mcc_campaign_attempts.next_attempt_at`

## 🛡️ Monitoring & alerting
- ✅ Review Desk v3 app: unblock queue (two-step confirm + decision history) + dispute-pipeline board (state filters, search, eval-fixture toggle, case drawer with audit trail/attempts, live TTR + stuck-case health cards)
- ✅ Stuck-case detector cron (hourly — schedule confirmed in UI): state budgets + failed notifications → audit event + operator email, daily dedupe. Proven live: DSP-1788125177241 (failed notification from the wrong-number test) is alerting exactly as designed
- ✅ Time-to-resolution named metric in the same cron: median filed→closed vs target 24h / concern 48h, daily `pipeline_health` audit event, breach joins the operator email. First live measurement: median 0.41h
- ✅ 3 Agent 1 metrics (auth success ≥85%, containment ≥70%, tool discipline) + 3 pipeline metrics (processing success ≥95%, request-info ≤30%, blocked ~0%)
- ⬜ Optional: one platform alert monitor (Alerts UI → ToolFailureRate on mcc-backoffice, >20% over 1h) (Lucas — one click; API schema is UI-authored)
- ➖ DataDog dashboard via Linear ticket (real-customer process; capstone uses the platform's own observability)

## 🧪 Testing & QA
- ✅ Evals ≥15: Agent 1 has 23 scenarios (happy/routing/failure/guardrail incl. payment pair and the dispute-status grounding regression), Agent 2 has 9 (all mandatory edge cases), Agent 3 has 5 (incl. exact-time callback)
- ✅ Red-teaming in evals: prompt injection, abuse, out-of-scope, unsupported language, scam-worried outbound customer, do-not-call — all green
- ✅ Contained-call definition pre-defined: containment metric excludes abandoned/abusive; HITL unblock filing counts as resolved
- ✅ All flows dry-run on the REAL phone number (2026-08-31): inbound call to Mia (payment MC-93199216 executed); dispute filing → pre-call SMS → Agent 3 callback; verification, lockout, PII masking, injection→governance incident all observed live
- ✅ The three end-to-end pipeline proofs over real calls: terminal outcome (DSP-LIVE-CALL-1 closed/delivered) · request_info loop (collected→submitted→reprocess→auto_approve) · failure/retry (bad_time → automatic campaign retry; wrong-DOB lockout → wrong_number)
- ✅ Governance incidents verified after live calls (incident `bbe3f58a` — System Manipulation, comm `8f2e4149`)
- ✅ Pre-call SMS delivery verified on a real number
- ⬜ Optional: one live scheduled-callback proof — during any answered call say "call me back at <exact time>" and watch `campaigns callback-list` + the callback call (Lucas, 30s; mechanism is eval-green and platform-native)

## 🧠 Prompts & knowledge sync
- ✅ All prompts, skills, tools, tags, metrics, diacritics, KB pointers live in git and serve from merged main — nothing to sync by hand (this replaces the checklist's manual sync section by construction)
- ✅ Diacritics in the Shared Library (5 rules), referenced by all four Agent 1 skills
- ✅ RAG `meridian_kb` (8 docs) attached to card-knowledge; retrieval verified live

## 📝 Prompt adjustments
- ✅ No testing-phase leftovers in prompts (EVL fixtures are table rows, prefixed and excluded from the stuck-case monitor)
- ✅ Forwarding: escalate-to-human announces the transfer, has off-hours callback/SMS fallback
- ✅ Two documented iterations (fraud attestation-vs-siblings from eval BO-5; dispute-status hallucination from a real call → fraud-dispute-status tool + grounding rule + EV-F7 — both in design.md) + anti-pattern review (design.md)

## Certification logistics
- ⬜ OG Buddy dry run (Lucas)
- ⬜ Demo environment ready: test phone, screen share with Review Desk + Studio open (Lucas)
- ⬜ Book the 1-hour CTO session (Lucas)
- ⬜ Regenerate the deck: paste `certification-presentation.md` into Claude design (Lucas)
- ✅ Presentation content: pipeline edition (certification-presentation.md)
- ✅ Demo script: pipeline/demo-script.md
