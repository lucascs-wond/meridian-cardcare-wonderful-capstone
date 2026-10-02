---
name: "dispute-processing"
description: "Decide dispute cases per the Meridian rulebook: gather evidence, apply the eligibility rule for the dispute type, record exactly one outcome, queue customer outreach."
---

# Dispute Processing

Each webhook task is the doorbell for exactly one dispute case. Work every task in exactly this order:

0. **`case-claim`** — binds this task to one case (pass `case_id` only if the task context names one; normally call it with no arguments). If it returns `nothing_to_claim`, this was a duplicate delivery: mark the task completed as a no-op and stop.
1. **`case-evidence`** with the claimed case_id — the case, transaction, sibling transactions, card status, and rulebook flags. The claim result's `reprocess: true` means the customer answered a request for information.
2. Apply the rulebook below to choose ONE outcome.
3. **`case-decide`** with the outcome, a specific rationale (it becomes the audit record), the rule you applied, and — for request_info — exactly what the customer must provide.
4. **`case-notify`** to queue the customer call — for every outcome EXCEPT blocked.
5. `task_set_status` completed, summarizing: outcome, rule applied, credit issued or not, notification status.

## The rulebook

| Dispute type | Required evidence | Eligibility rule |
|---|---|---|
| `fraud_unauthorized` | Customer attestation (`customer_stated_details`), transaction metadata, card lost/stolen status | Approve when filed within the 60-day window AND nothing contradicts the fraud claim. A blocked/fraud-flagged card or fraud-flagged transaction corroborates. **Before approving, actively test the attestation against the evidence**: undisputed sibling activity on the same card at the same merchant or location during the period the attestation covers, a location claim that conflicts with where the sibling charges happened, or card-present activity while the customer claims the card was elsewhere — each of these is a CONTRADICTION → `request_info` naming it, never an approval. |
| `goods_not_received` | Expected delivery date, merchant-contact evidence (`merchant_contacted`) | Approvable only when the expected date has passed AND the customer contacted the merchant first. |
| `duplicate_or_incorrect` | Sibling transaction (same account/merchant within 3 days, `has_sibling_same_amount`) or a documented amount mismatch (`stated_correct_amount`) | Approve when a matching sibling transaction exists or the documented correct amount differs from the posted amount. |

## Outcomes

- **auto_approve** — the eligibility rule is met. Approval issues the provisional credit (the tool does this; mention "posts within 2 business days" in your summary).
- **auto_reject** — the evidence is present and it disproves eligibility (e.g. expected delivery date has not passed yet; the "duplicate" is two legitimate distinct purchases; the window expired). Rejection requires evidence, never its absence.
- **request_info** — evidence is missing or conflicting. Name the exact item: "the date you contacted the merchant", "your confirmation that you did not authorize this charge". Never reject for missing evidence; never guess between conflicting facts.
- **close_resolved** — the case was already resolved (merchant refunded, prior resolution recorded, `already_resolved` flag). Close with NO new credit.
- **blocked** — provenance failure: `ownership_ok` is false, or the case references data of another customer/account. No outreach ever happens for blocked cases.

## Mandatory edge cases

| Situation | Required behavior |
|---|---|
| Missing evidence | `request_info` naming the specific item — never a rejection |
| Duplicate task for a decided case | The tools no-op; end the task reporting the existing decision |
| Conflicting evidence (e.g. attestation contradicts card-present pattern, dates disagree) | `request_info` naming the specific conflict — never guess |
| Already resolved | `close_resolved`, no new credit, no second notification |
| Cross-account mismatch (`ownership_ok: false`) | `blocked` — refuse to read or write the other account's data |

## Reprocessing (`reprocess: true`)

The customer answered a request_info. Read `info_submitted` in the evidence, weigh it with the original evidence, and decide again — the same order, the same rules. If the new information changes nothing, `auto_reject` with the reason (the evidence now exists and disproves eligibility) rather than another request_info for the same item.

## Writing rationales

One or two sentences, specific, auditable: the facts you weighed and the rule they satisfied or failed. Example: "Sibling transaction TXN-2044 posted 2026-08-12 for the same $89.20 at the same merchant one day after the disputed charge — duplicate confirmed (duplicate_or_incorrect rule)."
