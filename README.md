# Meridian CardCare — a three-agent credit-card servicing pipeline on Wonderful

Capstone for the Wonderful FDE certification track. **Meridian Card Services is a fictional issuer** created for this project; all customers, accounts, cards and transactions are synthetic.

## What is here

| Folder | What it is |
|---|---|
| `agent-repo/` | **Agent 1 — inbound servicing** (`lucas-meridian-cardcare`, "Mia"): base prompt, 4 skills, 20 tools, evals, tags, metrics, knowledge-base pointer, shared library |
| `backoffice-repo/` | **Agent 2 — backoffice decision**: dispute-processing skill, rulebook, tools, state-seeded evals, fixture seeder |
| `outreach-repo/` | **Agent 3 — outbound outcome calls**: trust-first skill, 7 tools (incl. one-disposition-per-call and exact-time callbacks), evals |
| `functions-repo/` | 26 platform functions + 1 scheduled health job — the entire data plane (case lifecycle, notifications, review desk API, stuck-case / time-to-resolution monitor) |
| `review-desk-repo/` | **Review Desk** — the human-review and pipeline-monitoring web app |
| `procedure/` | The deterministic human-in-the-loop Procedure (durable wait on the reviewer's decision → SMS) |
| `pipeline/` | Design document (contracts, lifecycle, rulebook, documented iterations), go-live checklist, live-demo script |

## How it fits together

Agent 1 files a dispute case → an authenticated webhook starts an Agent 2 task → the rulebook decides (approve / reject / request-info / close-resolved / blocked) → actionable outcomes create one Campaign consumer per case → Agent 3 delivers the outcome by phone and records exactly one disposition → collected information re-enters the same path on the same case id. One shared case table is the source of truth; every event is traceable by `case_id`. Card unblocks are the one action the AI can never take — a human decides in the Review Desk. See `pipeline/design.md`.

## Notes for readers

- This code targets the **Wonderful platform** (agents, skills, tools, functions, tables, campaigns, procedures, apps). It is published for reading, not as a standalone runnable project; platform-managed folders (`.wonderful/`, `.agents/`, `.claude/`), lockfile-only dependencies and build output are omitted.
- Workspace, tenant, agent, run and incident identifiers are replaced with `<redacted-id>` / `<workspace-id>` / `<tenant-id>`; the operator alert mailbox and phone numbers are placeholders. No credentials exist in this repository — every secret is read from platform-managed secrets at runtime.
