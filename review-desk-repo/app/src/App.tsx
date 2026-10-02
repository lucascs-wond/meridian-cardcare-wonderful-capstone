import "./style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWonderful } from "@wonderful/app-sdk";

/**
 * Meridian Card Review Desk v3
 *  - Unblock requests: HITL queue (two-step approve/deny with notes) + decision history.
 *  - Dispute pipeline: live board for the Agent1→Agent2→Campaign→Agent3 flow —
 *    state filters, search, eval-fixture toggle, pipeline health (TTR + stuck cases),
 *    and a right-hand case drawer with the full audit trail and outreach attempts.
 */

const CASES_TABLE = "mcc_block_review_cases";
const EVENTS_TABLE = "mcc_case_events";
const DECIDE_FN = "mcc-review-cases-decide";
const PIPELINE_FN = "mcc-case-events-list";
const PAGE_LIMIT = 200;
const REFRESH_MS = 15000;

// ------------------------------- Types --------------------------------------

type UnblockCase = {
  case_id: string;
  customer_id: string;
  card_id: string;
  card_last4: string;
  block_reason: string;
  customer_stated_reason: string;
  status: "pending" | "approved" | "denied";
  decision: string | null;
  reviewer: string | null;
  reviewer_notes: string | null;
  submitted_at: string;
  decided_at: string | null;
  channel: string;
};

type PipelineCase = {
  case_id: string;
  dispute_type: string | null;
  case_state: string;
  outcome: string | null;
  notification_status: string;
  filed_at: string;
  decided_at: string | null;
};

type CaseEventRow = {
  event_id: string;
  case_id: string;
  task_id: string | null;
  actor: string | null;
  event_type: string | null;
  from_state: string | null;
  to_state: string | null;
  outcome: string | null;
  rule_applied: string | null;
  detail: string | null;
  logged_at: string | null;
};

type CaseDetail = {
  case: {
    case_id: string;
    dispute_type: string | null;
    case_state: string;
    status: string;
    outcome: string | null;
    outcome_rationale: string | null;
    rule_applied: string | null;
    required_info: string | null;
    provisional_credit: boolean;
    notification_status: string;
    decided_at: string | null;
    decision_task_id: string | null;
    filed_at: string;
  };
  events: CaseEventRow[];
  attempts: Array<{
    attempt_id: string;
    attempt_number: number | null;
    technical_outcome: string | null;
    business_code: string | null;
    summary: string | null;
    retry_action: string | null;
    next_attempt_at: string | null;
    logged_at: string | null;
  }>;
};

type Health = {
  text: string;
  loggedAt: string | null;
  medianH: number | null;
  targetH: number | null;
  breached: boolean;
};

// ------------------------------ Helpers -------------------------------------

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString(undefined, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function fmtFull(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function rel(ts: string | null | undefined): string {
  if (!ts) return "—";
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return String(ts);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return fmt(ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmt(ts);
}

function titleCase(s: string | null | undefined): string {
  return (s || "").replace(/_/g, " ");
}

const OUTCOME_KIND: Record<string, string> = {
  auto_approve: "ok", close_resolved: "ok", auto_reject: "warn",
  request_info: "info", blocked: "bad",
};

const STATE_KIND: Record<string, string> = {
  received: "info", processing: "info", info_requested: "warn",
  info_received: "warn", decided: "ok", closed: "muted", blocked: "bad",
};

function notifKind(status: string): string {
  if (status === "delivered") return "ok";
  if (status === "queued") return "info";
  if (status === "failed") return "bad";
  if (status === "opted_out" || (status || "").startsWith("skipped")) return "warn";
  return "muted";
}

const ACTOR_COLOR: Record<string, string> = {
  "agent1-inbound": "actor-a1", "agent2-backoffice": "actor-a2",
  "agent3-outbound": "actor-a3", system: "actor-sys",
};

function Badge({ kind, children }: { kind: string; children: string }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

async function fetchTableRows<T>(api: { get: <R = unknown>(p: string) => Promise<R> }, table: string, maxPages = 5): Promise<T[]> {
  const rows: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await api.get<{ data: Array<{ data: T }>; pagination: { total_pages: number } }>(
      `custom-tables/${table}/rows?page=${page}&limit=${PAGE_LIMIT}`
    );
    rows.push(...res.data.map((r) => r.data));
    totalPages = res.pagination.total_pages;
    page += 1;
  } while (page <= totalPages && page <= maxPages);
  return rows;
}

function parseHealth(ev: CaseEventRow | undefined): Health | null {
  if (!ev || !ev.detail) return null;
  const median = /median ([\d.]+)h/.exec(ev.detail);
  const target = /target (\d+)h/.exec(ev.detail);
  return {
    text: ev.detail,
    loggedAt: ev.logged_at,
    medianH: median ? Number(median[1]) : null,
    targetH: target ? Number(target[1]) : null,
    breached: /CONCERN BREACHED/.test(ev.detail),
  };
}

// ------------------------------ Unblock tab ---------------------------------

function DecisionButtons({ caseId, busy, onDecide }: {
  caseId: string;
  busy: boolean;
  onDecide: (caseId: string, decision: "approve" | "deny", notes: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "deny" | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const click = (decision: "approve" | "deny") => {
    if (confirm === decision) {
      setConfirm(null);
      onDecide(caseId, decision, notes);
      return;
    }
    setConfirm(decision);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setConfirm(null), 4000);
  };

  return (
    <div className="decision-panel">
      <label className="label" htmlFor={`notes-${caseId}`}>Reviewer notes (optional)</label>
      <textarea
        id={`notes-${caseId}`}
        className="reviewer-notes"
        placeholder="Reasoning, verification performed, follow-ups…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="decision-buttons">
        <button className={`btn btn-approve ${confirm === "approve" ? "btn-confirm" : ""}`} disabled={busy} onClick={() => click("approve")}>
          {confirm === "approve" ? "Click again to confirm" : "Approve unblock"}
        </button>
        <button className={`btn btn-deny ${confirm === "deny" ? "btn-confirm" : ""}`} disabled={busy} onClick={() => click("deny")}>
          {confirm === "deny" ? "Click again to confirm" : "Deny"}
        </button>
        {confirm && <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>}
      </div>
      <p className="hint">Approving reactivates the card and texts the customer — this is the pipeline's only unblock path.</p>
    </div>
  );
}

function UnblockCard({ item, onDecide, busy, compact }: {
  item: UnblockCase;
  onDecide: (caseId: string, decision: "approve" | "deny", notes: string) => void;
  busy: boolean;
  compact?: boolean;
}) {
  const pending = item.status === "pending";
  return (
    <article className={`case-card status-${item.status} ${compact ? "case-card-compact" : ""}`}>
      <div className="case-head">
        <strong className="mono">{item.case_id}</strong>
        <Badge kind={item.status === "pending" ? "info" : item.status === "approved" ? "ok" : "bad"}>{item.status}</Badge>
      </div>
      <dl className="case-meta">
        <div><dt>Customer</dt><dd className="mono">{item.customer_id}</dd></div>
        <div><dt>Card</dt><dd>•••• {item.card_last4}</dd></div>
        <div><dt>Block reason</dt><dd>{titleCase(item.block_reason)}</dd></div>
        <div><dt>Submitted</dt><dd title={fmtFull(item.submitted_at)}>{rel(item.submitted_at)}</dd></div>
      </dl>
      {item.customer_stated_reason && (
        <p className="stated"><span className="label">Customer stated reason</span>{item.customer_stated_reason}</p>
      )}
      {pending ? (
        <DecisionButtons caseId={item.case_id} busy={busy} onDecide={onDecide} />
      ) : (
        <p className="muted decided-line">
          {item.status === "approved" ? "✓ Approved" : "✕ Denied"} {fmt(item.decided_at)}
          {item.reviewer ? ` by ${item.reviewer}` : ""}
          {item.reviewer_notes ? ` — ${item.reviewer_notes}` : ""}
        </p>
      )}
    </article>
  );
}

function UnblockTab() {
  const { api, context, track } = useWonderful();
  const [cases, setCases] = useState<UnblockCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<"all" | "approved" | "denied">("all");
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setCases(await fetchTableRows<UnblockCase>(api, CASES_TABLE));
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cases");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const pending = useMemo(
    () => cases.filter((c) => c.status === "pending").sort((a, b) => (a.submitted_at < b.submitted_at ? -1 : 1)),
    [cases]
  );
  const history = useMemo(() => {
    const done = cases.filter((c) => c.status !== "pending").sort((a, b) => ((a.decided_at || "") > (b.decided_at || "") ? -1 : 1));
    return historyFilter === "all" ? done : done.filter((c) => c.status === historyFilter);
  }, [cases, historyFilter]);
  const counts = useMemo(() => ({
    approved: cases.filter((c) => c.status === "approved").length,
    denied: cases.filter((c) => c.status === "denied").length,
  }), [cases]);

  const decide = useCallback(async (caseId: string, decision: "approve" | "deny", notes: string) => {
    setBusy(true);
    try {
      const params: Record<string, unknown> = {
        case_id: caseId,
        decision,
        reviewer: context.userName || context.userId || "reviewer",
      };
      if (notes.trim()) params.reviewer_notes = notes.trim();
      await api.invokeFunction(DECIDE_FN, { method: "POST", params });
      track("unblock_decided", { case_id: caseId, decision });
      await load();
    } catch (e) {
      setError(e instanceof Error ? `Decision failed: ${e.message}` : "Decision failed");
    } finally {
      setBusy(false);
    }
  }, [api, context, load, track]);

  return (
    <section>
      <div className="section-head">
        <h2 className="section-title">Pending review <span className="count-pill">{pending.length}</span></h2>
        <span className="updated" title="Auto-refreshes every 15s">{updatedAt ? `Updated ${rel(new Date(updatedAt).toISOString())}` : ""}</span>
      </div>
      {error && <p className="error">Couldn't load cases: {error} <button className="chip" onClick={() => void load()}>Retry</button></p>}
      {loading ? (
        <p className="muted">Loading cases…</p>
      ) : pending.length === 0 ? (
        <div className="empty-state">
          <span className="empty-mark">✓</span>
          <p><strong>Queue is clear.</strong></p>
          <p className="muted">New requests land here the moment Mia files them — this view refreshes itself.</p>
        </div>
      ) : (
        <div className="case-grid">
          {pending.map((c) => <UnblockCard key={c.case_id} item={c} onDecide={decide} busy={busy} />)}
        </div>
      )}

      <div className="section-head history-head">
        <h2 className="section-title">Decision history</h2>
        <div className="filter-row" role="group" aria-label="Filter decision history">
          {(["all", "approved", "denied"] as const).map((f) => (
            <button key={f} className={`chip ${historyFilter === f ? "chip-active" : ""}`} onClick={() => setHistoryFilter(f)}>
              {f}{f !== "all" ? ` (${counts[f]})` : ` (${counts.approved + counts.denied})`}
            </button>
          ))}
        </div>
      </div>
      {history.length === 0 ? (
        <p className="muted">No decided cases{historyFilter !== "all" ? ` (${historyFilter})` : ""} yet.</p>
      ) : (
        <div className="case-grid">
          {history.map((c) => <UnblockCard key={c.case_id} item={c} onDecide={decide} busy={busy} compact />)}
        </div>
      )}
    </section>
  );
}

// ----------------------------- Pipeline tab ---------------------------------

const STATE_ORDER = ["received", "processing", "info_requested", "info_received", "decided", "closed", "blocked"];

function CaseDrawer({ detail, caseId, onClose }: { detail: CaseDetail | null; caseId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const events = useMemo(
    () => (detail ? [...detail.events].sort((a, b) => ((a.logged_at || "") < (b.logged_at || "") ? -1 : 1)) : []),
    [detail]
  );

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label={`Case ${caseId}`}>
        <div className="drawer-head">
          <div>
            <h2 className="mono drawer-title">{caseId}</h2>
            {detail && <span className="muted">{titleCase(detail.case.dispute_type) || "dispute"} · filed {fmt(detail.case.filed_at)}</span>}
          </div>
          <div className="drawer-actions">
            <button className="chip" onClick={() => { void navigator.clipboard?.writeText(caseId); }}>Copy ID</button>
            <button className="chip" onClick={onClose}>Close ✕</button>
          </div>
        </div>
        {!detail ? <p className="muted">Loading case…</p> : (
          <>
            <div className="drawer-chips">
              <Badge kind={STATE_KIND[detail.case.case_state] || "muted"}>{titleCase(detail.case.case_state)}</Badge>
              {detail.case.outcome && <Badge kind={OUTCOME_KIND[detail.case.outcome] || "muted"}>{titleCase(detail.case.outcome)}</Badge>}
              <Badge kind={notifKind(detail.case.notification_status)}>{`notify: ${titleCase(detail.case.notification_status)}`}</Badge>
              {detail.case.provisional_credit && <Badge kind="ok">credit issued</Badge>}
            </div>
            <dl className="case-meta detail-meta">
              <div><dt>Decided</dt><dd title={fmtFull(detail.case.decided_at)}>{fmt(detail.case.decided_at)}</dd></div>
              <div><dt>Decision task</dt><dd className="mono small">{detail.case.decision_task_id || "—"}</dd></div>
            </dl>
            {detail.case.rule_applied && <p className="stated"><span className="label">Rule applied</span>{detail.case.rule_applied}</p>}
            {detail.case.outcome_rationale && <p className="stated"><span className="label">Rationale</span>{detail.case.outcome_rationale}</p>}
            {detail.case.required_info && <p className="stated stated-warn"><span className="label">Awaiting from customer</span>{detail.case.required_info}</p>}

            <h3>Audit trail <span className="count-pill">{events.length}</span></h3>
            <ol className="timeline">
              {events.map((ev) => (
                <li key={ev.event_id} className={ACTOR_COLOR[ev.actor || ""] || "actor-sys"}>
                  <div className="tl-row">
                    <span className="evt">{titleCase(ev.event_type)}</span>
                    <span className="actor">{ev.actor || "system"}</span>
                    <span className="mono time" title={fmtFull(ev.logged_at)}>{fmt(ev.logged_at)}</span>
                  </div>
                  {ev.from_state && <span className="muted small">{titleCase(ev.from_state)} → {titleCase(ev.to_state)}</span>}
                  {ev.detail && <p className="muted evt-detail">{ev.detail}</p>}
                </li>
              ))}
            </ol>

            <h3>Outreach attempts <span className="count-pill">{detail.attempts.length}</span></h3>
            {detail.attempts.length === 0 ? <p className="muted">No call attempts for this case yet.</p> : (
              <table className="pipe-table">
                <thead><tr><th>#</th><th>Technical</th><th>Business code</th><th>Next attempt</th><th>When</th></tr></thead>
                <tbody>
                  {detail.attempts.map((a) => (
                    <tr key={a.attempt_id} title={a.summary || undefined}>
                      <td>{a.attempt_number ?? "—"}</td>
                      <td>{titleCase(a.technical_outcome) || "—"}</td>
                      <td>{a.business_code ? <Badge kind={a.business_code === "completed" ? "ok" : a.business_code === "do_not_call" || a.business_code === "wrong_number" ? "bad" : "info"}>{titleCase(a.business_code)}</Badge> : "—"}</td>
                      <td title={fmtFull(a.next_attempt_at)}>{a.next_attempt_at ? fmt(a.next_attempt_at) : "—"}</td>
                      <td title={fmtFull(a.logged_at)}>{fmt(a.logged_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function PipelineTab() {
  const { api, track } = useWonderful();
  const [cases, setCases] = useState<PipelineCase[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [stuckToday, setStuckToday] = useState<string[]>([]);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [showEvals, setShowEvals] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overview, events] = await Promise.all([
        api.invokeFunction<{ cases: PipelineCase[]; counts_by_state: Record<string, number> }>(PIPELINE_FN, { method: "POST", params: {} }),
        fetchTableRows<CaseEventRow>(api, EVENTS_TABLE),
      ]);
      setCases(overview.cases || []);
      setCounts(overview.counts_by_state || {});
      const healthEvents = events
        .filter((e) => e.case_id === "PIPELINE-HEALTH" && e.event_type === "pipeline_health")
        .sort((a, b) => ((a.logged_at || "") < (b.logged_at || "") ? 1 : -1));
      setHealth(parseHealth(healthEvents[0]));
      const today = new Date().toISOString().slice(0, 10);
      setStuckToday([...new Set(
        events
          .filter((e) => e.event_type === "stuck_case_alert" && (e.logged_at || "").slice(0, 10) === today)
          .map((e) => e.case_id)
      )]);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load pipeline");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases
      .filter((c) => showEvals || !c.case_id.startsWith("EVL-"))
      .filter((c) => !stateFilter || c.case_state === stateFilter)
      .filter((c) => !q ||
        c.case_id.toLowerCase().includes(q) ||
        (c.dispute_type || "").toLowerCase().includes(q) ||
        (c.outcome || "").toLowerCase().includes(q))
      .sort((a, b) => (a.filed_at < b.filed_at ? 1 : -1));
  }, [cases, search, stateFilter, showEvals]);

  const evalCount = useMemo(() => cases.filter((c) => c.case_id.startsWith("EVL-")).length, [cases]);

  const liveCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of cases) {
      if (!showEvals && c.case_id.startsWith("EVL-")) continue;
      out[c.case_state] = (out[c.case_state] || 0) + 1;
    }
    return out;
  }, [cases, showEvals]);

  const openDetail = useCallback(async (caseId: string) => {
    setSelected(caseId);
    setDetail(null);
    track("pipeline_case_opened", { case_id: caseId });
    try {
      setDetail(await api.invokeFunction<CaseDetail>(PIPELINE_FN, { method: "POST", params: { case_id: caseId } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load case detail");
      setSelected(null);
    }
  }, [api, track]);

  return (
    <section>
      <div className="kpi-row">
        <div className="state-strip">
          {STATE_ORDER.map((s) => (
            <button
              key={s}
              className={`state-pill ${liveCounts[s] ? "state-pill-live" : ""} ${stateFilter === s ? "state-pill-active" : ""}`}
              onClick={() => setStateFilter(stateFilter === s ? null : s)}
              title={`Filter by ${titleCase(s)}`}
            >
              <span className="state-name">{titleCase(s)}</span>
              <span className="state-count">{liveCounts[s] || 0}</span>
            </button>
          ))}
        </div>
        <div className="health-cards">
          <div className={`health-card ${health?.breached ? "health-bad" : "health-ok"}`} title={health?.text || "No pipeline_health event yet — the hourly monitor writes one per day."}>
            <span className="state-name">Time to resolution</span>
            <span className="state-count">{health?.medianH != null ? `${health.medianH}h` : "—"}</span>
            <span className="small muted">median · target {health?.targetH ?? 24}h</span>
          </div>
          <div className={`health-card ${stuckToday.length > 0 ? "health-bad" : "health-ok"}`} title={stuckToday.length ? `Flagged today: ${stuckToday.join(", ")}` : "No stuck cases flagged today."}>
            <span className="state-name">Stuck cases today</span>
            <span className="state-count">{stuckToday.length}</span>
            <span className="small muted">hourly monitor</span>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search case id, type, outcome…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search cases"
        />
        <label className="toggle">
          <input type="checkbox" checked={showEvals} onChange={(e) => setShowEvals(e.target.checked)} />
          <span>Show eval fixtures ({evalCount})</span>
        </label>
        <span className="updated" title="Auto-refreshes every 15s">{updatedAt ? `Updated ${rel(new Date(updatedAt).toISOString())}` : ""}</span>
      </div>

      {error && <p className="error">{error} <button className="chip" onClick={() => void load()}>Retry</button></p>}
      {loading ? <p className="muted">Loading pipeline…</p> :
        visible.length === 0 ? (
          <div className="empty-state">
            <span className="empty-mark">◎</span>
            <p><strong>No cases match.</strong></p>
            <p className="muted">{cases.length === 0 ? "No dispute cases in the pipeline yet — file one through Mia." : "Adjust the search, state filter, or the eval-fixture toggle."}</p>
          </div>
        ) : (
        <div className="table-wrap">
          <table className="pipe-table">
            <thead>
              <tr><th>Case</th><th>Type</th><th>State</th><th>Outcome</th><th>Notification</th><th>Filed</th><th>Decided</th></tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.case_id} className={selected === c.case_id ? "row-selected" : ""} onClick={() => void openDetail(c.case_id)}>
                  <td className="mono">{c.case_id}</td>
                  <td>{titleCase(c.dispute_type) || "—"}</td>
                  <td><Badge kind={STATE_KIND[c.case_state] || "muted"}>{titleCase(c.case_state)}</Badge></td>
                  <td>{c.outcome ? <Badge kind={OUTCOME_KIND[c.outcome] || "muted"}>{titleCase(c.outcome)}</Badge> : "—"}</td>
                  <td><Badge kind={notifKind(c.notification_status)}>{titleCase(c.notification_status)}</Badge></td>
                  <td title={fmtFull(c.filed_at)}>{rel(c.filed_at)}</td>
                  <td title={fmtFull(c.decided_at)}>{c.decided_at ? rel(c.decided_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <CaseDrawer detail={detail} caseId={selected} onClose={() => { setSelected(null); setDetail(null); }} />}
    </section>
  );
}

// --------------------------------- Shell -------------------------------------

export default function App() {
  const { context } = useWonderful();
  const [tab, setTab] = useState<"unblock" | "pipeline">("unblock");
  return (
    <div className={`app-root theme-${context.theme || "light"}`}>
      <header className="desk-header">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <h1 className="desk-title">Meridian Card Review Desk</h1>
            <p className="desk-subtitle">Human reviews & dispute-pipeline monitoring · fictional issuer (capstone)</p>
          </div>
        </div>
        <nav className="tab-row" role="tablist">
          <button role="tab" aria-selected={tab === "unblock"} className={`tab ${tab === "unblock" ? "tab-active" : ""}`} onClick={() => setTab("unblock")}>
            Unblock requests
          </button>
          <button role="tab" aria-selected={tab === "pipeline"} className={`tab ${tab === "pipeline" ? "tab-active" : ""}`} onClick={() => setTab("pipeline")}>
            Dispute pipeline
          </button>
        </nav>
      </header>
      {tab === "unblock" ? <UnblockTab /> : <PipelineTab />}
      <footer className="desk-footer">
        Review Desk v3 · one <span className="mono">case_id</span> traces every actor — Mia, backoffice, campaign, outreach, monitor.
      </footer>
    </div>
  );
}
