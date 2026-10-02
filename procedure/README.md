# MCC Unblock Case Flow — deterministic Procedure (Resources → Procedures)

**Automation id:** `<redacted-id>` · published `main` · global var `MCC_UNBLOCK_FLOW_ID`

Deterministic HITL flow satisfying the capstone's flow-based requirement with the platform's Procedures feature (not code):

```
trigger (manual/programmatic, input: case_id, customer_id, card_last4)
  → wait  [record condition — DURABLE: run suspends until reviewer decides]
  → if/else (wait-1.row.data.status == "approved")
      yes → function mcc-notify-unblock-decision (decision: approved)
      no  → function mcc-notify-unblock-decision (decision: denied)
```

- **Started automatically** by `mcc-review-cases-create` (fire-and-forget `context.automations.invoke`, id from global `MCC_UNBLOCK_FLOW_ID`; case filing never fails if the flow is down).
- **Wait node schema** (undocumented; recovered by authoring in the canvas and reading the draft JSON back via `wful automations draft-get`):
  `{"mode":"condition","table_name":…,"row_id":"{{trigger-1.case_id}}","field":"status","op":"!=","value":"pending","poll_interval_ms":60000,…}` — matches the record by ROW ID (= the table's single-column PK value). Row output nests columns under **`row.data`**.
- **Proven live (2026-08-28):** run `89aa5441` approve path (matched instantly on decided case → SMS approved); run `9a00e935` full durable path (suspended on pending case BRC-1787925379544 → reviewer denied via `mcc-review-cases-decide` → resumed within one 60 s poll → SMS denied). Trigger-from-agent proven by run `91029ad6` (`trigger_source: programmatic` after a live-chat filing).
- Known duplication nuance: if the customer calls back and asks for status after the decision, the agent's `send-sms-confirmation` can also send an `unblock_decision` text — acceptable; revisit post-capstone.

Division of labor vs the code tools: the **agent-side** flow tools (verify-identity, fraud-request-unblock) handle mid-call, latency-sensitive turns; the **Procedure** owns the cross-day, durable, human-gated part — which is exactly the platform's intended split.
