#!/usr/bin/env python3
"""Seeds the EVL- fixture rows for the backoffice_regression eval batch.

The backoffice eval runtime does not honor start_tool_mocks, so these evals
run as state-seeded integration tests: every scenario names its own case id
in task_input and the live tools operate on these dedicated EVL- rows.

Run BEFORE each batch run:  python3 evals/seed_backoffice_cases.py
Idempotent: deletes existing EVL- rows (and EVL- campaign consumers), reinserts.
"""
import json
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

PROFILE = ["wful", "--profile", "capstone"]
CAMPAIGN_GLOBAL = "MCC_DISPUTE_CAMPAIGN_ID"

TODAY = date.today()
def d(days_ago): return (TODAY - timedelta(days=days_ago)).isoformat()
def d_future(days): return (TODAY + timedelta(days=days)).isoformat()
NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run(args, ok_codes=(0,)):
    r = subprocess.run(PROFILE + args, capture_output=True, text=True)
    if r.returncode not in ok_codes:
        print("FAILED:", " ".join(args), "\n", r.stderr[:300])
        sys.exit(1)
    return r.stdout


def rows(table):
    out = run(["tables", "row-list", table, "--json"])
    data = json.loads(out)
    return data if isinstance(data, list) else data.get("rows") or data.get("data", [])


def wipe(table, key_col, prefix):
    for r in rows(table):
        if str(r["data"].get(key_col, "")).startswith(prefix):
            run(["tables", "row-delete", table, r["id"], "--force", "--json"], ok_codes=(0, 1))


def insert(table, data):
    run(["tables", "row-insert", table, "--data", json.dumps(data), "--json"])


# ---- wipe in FK-safe order (children first) ----
print("wiping existing EVL- rows ...")
wipe("mcc_case_events", "case_id", "EVL-")
wipe("mcc_disputes", "dispute_id", "EVL-")
wipe("mcc_transactions", "transaction_id", "EVL-")
wipe("mcc_cards", "card_id", "EVL-")
wipe("mcc_accounts", "account_id", "EVL-")
wipe("mcc_customers", "customer_id", "EVL-")

# ---- base entities ----
print("seeding base entities ...")
insert("mcc_customers", {"customer_id": "EVL-CUST-1", "first_name": "Evie", "last_name": "Fixture",
                         "phone": "+15550190001", "verification_pin": "0000", "sms_opt_in": True,
                         "email": "evie.fixture@example.com", "status": "active"})
insert("mcc_customers", {"customer_id": "EVL-CUST-2", "first_name": "Omar", "last_name": "Fixture",
                         "phone": "+15550190002", "verification_pin": "0000", "sms_opt_in": True,
                         "email": "omar.fixture@example.com", "status": "active"})
product = rows("mcc_card_products")[0]["data"]
pid = product.get("product_id") or product.get("id")
insert("mcc_accounts", {"account_id": "EVL-ACC-1", "customer_id": "EVL-CUST-1", "product_id": pid})
insert("mcc_accounts", {"account_id": "EVL-ACC-2", "customer_id": "EVL-CUST-2", "product_id": pid})
insert("mcc_cards", {"card_id": "EVL-CARD-1", "account_id": "EVL-ACC-1", "customer_id": "EVL-CUST-1",
                     "last4": "9001", "status": "active", "is_fraud_flagged": False})
insert("mcc_cards", {"card_id": "EVL-CARD-2", "account_id": "EVL-ACC-1", "customer_id": "EVL-CUST-1",
                     "last4": "9002", "status": "blocked", "block_reason": "suspected_fraud",
                     "blocked_at": NOW, "is_fraud_flagged": True})

# ---- transactions ----
print("seeding transactions ...")
TXNS = [
    # BO-1 duplicate pair
    {"transaction_id": "EVL-TX-1A", "date": d(8), "merchant": "EvalMart", "amount": 89.20, "card_id": "EVL-CARD-1"},
    {"transaction_id": "EVL-TX-1B", "date": d(7), "merchant": "EvalMart", "amount": 89.20, "card_id": "EVL-CARD-1"},
    # BO-2 fraud-flagged online charge on the fraud-flagged card
    {"transaction_id": "EVL-TX-2", "date": d(11), "merchant": "LuxeWatch Online", "amount": 899.99,
     "card_id": "EVL-CARD-2", "is_fraud_flagged": True, "location": "ONLINE"},
    # BO-3 goods not received (premature)
    {"transaction_id": "EVL-TX-3", "date": d(14), "merchant": "BrightHome Furniture", "amount": 640.00, "card_id": "EVL-CARD-1"},
    # BO-4 goods, evidence missing
    {"transaction_id": "EVL-TX-4", "date": d(20), "merchant": "Parcelly", "amount": 54.30, "card_id": "EVL-CARD-1"},
    # BO-5 conflicting: disputed charge + undisputed same-merchant activity
    {"transaction_id": "EVL-TX-5", "date": d(9), "merchant": "Tampa Coffee Co", "amount": 42.10, "card_id": "EVL-CARD-1", "location": "Tampa FL"},
    {"transaction_id": "EVL-TX-5B", "date": d(9), "merchant": "Tampa Coffee Co", "amount": 12.40, "card_id": "EVL-CARD-1", "location": "Tampa FL", "is_disputed": False},
    {"transaction_id": "EVL-TX-5C", "date": d(8), "merchant": "Tampa Coffee Co", "amount": 18.75, "card_id": "EVL-CARD-1", "location": "Tampa FL", "is_disputed": False},
    # BO-6 already refunded
    {"transaction_id": "EVL-TX-6", "date": d(12), "merchant": "EvalMart", "amount": 120.00, "card_id": "EVL-CARD-1", "status": "refunded"},
    # BO-7 cross-account: belongs to CUST-2/ACC-2
    {"transaction_id": "EVL-TX-7", "date": d(5), "merchant": "OtherShop", "amount": 300.00,
     "card_id": "EVL-CARD-1", "account": "EVL-ACC-2", "customer": "EVL-CUST-2"},
    # BO-9 reprocess (goods, date passed)
    {"transaction_id": "EVL-TX-9", "date": d(30), "merchant": "BrightHome Furniture", "amount": 210.00, "card_id": "EVL-CARD-1"},
]
for t in TXNS:
    insert("mcc_transactions", {
        "transaction_id": t["transaction_id"],
        "account_id": t.get("account", "EVL-ACC-1"),
        "customer_id": t.get("customer", "EVL-CUST-1"),
        "card_id": t["card_id"], "date": t["date"], "merchant": t["merchant"],
        "category": "retail", "amount": t["amount"], "currency": "USD",
        "status": t.get("status", "posted"), "type": "purchase",
        "is_disputed": t.get("is_disputed", True), "is_fraud_flagged": t.get("is_fraud_flagged", False),
        "location": t.get("location", "Tampa FL")})

# ---- dispute cases ----
print("seeding dispute cases ...")
def case(cid, txn, reason, dtype, state, **kw):
    row = {"dispute_id": cid, "customer_id": kw.pop("customer", "EVL-CUST-1"),
           "account_id": kw.pop("account", "EVL-ACC-1"), "transaction_id": txn,
           "reason": reason, "status": kw.pop("status", "open"),
           "amount": kw.pop("amount", 0), "filed_at": NOW,
           "provisional_credit": False, "dispute_type": dtype, "case_state": state,
           "notification_status": "none"}
    row.update(kw)
    insert("mcc_disputes", row)

case("EVL-BO-1", "EVL-TX-1A", "duplicate_charge", "duplicate_or_incorrect", "received", amount=89.20,
     customer_stated_details="I was charged twice at EvalMart for the same order.")
case("EVL-BO-2", "EVL-TX-2", "unauthorized_transaction", "fraud_unauthorized", "received", amount=899.99,
     customer_stated_details="I never made this charge. I still have my card.")
case("EVL-BO-3", "EVL-TX-3", "goods_not_received", "goods_not_received", "received", amount=640.00,
     customer_stated_details="Sofa has not arrived.", merchant_contacted=True,
     expected_delivery_date=d_future(21))
case("EVL-BO-4", "EVL-TX-4", "goods_not_received", "goods_not_received", "received", amount=54.30,
     customer_stated_details="Package never arrived.")
case("EVL-BO-5", "EVL-TX-5", "unauthorized_transaction", "fraud_unauthorized", "received", amount=42.10,
     customer_stated_details="I was in Portugal all month - I could not have made this charge in Tampa.")
case("EVL-BO-6", "EVL-TX-6", "duplicate_charge", "duplicate_or_incorrect", "received", amount=120.00,
     customer_stated_details="Double charged.", resolution="merchant_refunded")
case("EVL-BO-7", "EVL-TX-7", "unauthorized_transaction", "fraud_unauthorized", "received", amount=300.00,
     customer_stated_details="Charge is not mine.")
# BO-8: already decided — a claim on it must no-op
case("EVL-BO-8", "EVL-TX-1B", "duplicate_charge", "duplicate_or_incorrect", "decided", amount=89.20,
     status="open", outcome="auto_approve", outcome_rationale="(seeded as already decided)",
     decided_at=NOW, provisional_credit=True, last_notified_outcome="auto_approve",
     notification_status="queued")
# BO-9: reprocess — info already received
case("EVL-BO-9", "EVL-TX-9", "goods_not_received", "goods_not_received", "info_received", amount=210.00,
     customer_stated_details="Bookshelf never arrived.",
     required_info="The date you contacted the merchant and their response.",
     info_submitted=f"[{NOW} via agent3-call] I called BrightHome on {d(10)}; they confirmed the parcel is lost and refused a refund.",
     expected_delivery_date=d(15))

# ---- clean EVL consumers from the campaign ----
print("cleaning EVL- campaign consumers ...")
gv = json.loads(run(["global-variables", "list", "--json"]))
items = gv if isinstance(gv, list) else gv.get("data", [])
cid = next((g["value"] for g in items if g.get("name") == CAMPAIGN_GLOBAL), None)
if cid:
    cid = cid.strip('"')
    out = json.loads(run(["campaigns", "consumer-list", cid, "--json"]))
    consumers = out.get("items") if isinstance(out, dict) else out
    for c in consumers or []:
        if str(c.get("external_id", "")).startswith("EVL-"):
            run(["campaigns", "consumer-delete", cid, c["id"], "--json"], ok_codes=(0, 1))

print("seed complete.")
