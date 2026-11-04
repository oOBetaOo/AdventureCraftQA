"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Person = { id: number; username: string; initials?: string; color?: string; profilePicture?: string | null };
type Task = {
  id: string; name: string; status: string; statusColor: string;
  priority: string | null; priorityColor: string | null;
  assignees: Person[]; creator: string | null; tags: string[]; url: string;
  dateCreated: number; dateUpdated: number;
};
type Status = { status: string; color: string; orderindex: number };
type Pending = { key: string; file: File; preview: string; progress: number; state: "idle" | "up" | "done" | "fail"; error?: string };

const DONE = ["completed", "closed", "complete", "done"];
const PRIORITIES = [
  { v: "1", label: "Urgent", color: "#f50000" },
  { v: "2", label: "High", color: "#f8ae00" },
  { v: "3", label: "Normal", color: "#6fddff" },
  { v: "4", label: "Low", color: "#d8d8d8" },
];
const SMALL_LIMIT = 4 * 1024 * 1024; // above this, go through Vercel Blob
const REPORTER_KEY = "advc-reporter-id";

function initials(p: Person) {
  if (p.initials) return p.initials;
  return p.username.split(/[\s/_]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}
function Avatar({ p }: { p: Person }) {
  return (
    <span
      className="av"
      title={p.username}
      style={{ background: p.profilePicture ? `url(${p.profilePicture}) center/cover` : p.color || "#6b7b7d" }}
    >
      {p.profilePicture ? "" : initials(p)}
    </span>
  );
}
function ago(ms: number) {
  const d = (Date.now() - ms) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}
function fmtSize(b: number) {
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}

export default function Page() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [parentUrl, setParentUrl] = useState<string>("");
  const [members, setMembers] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState<string>("open");
  const [personF, setPersonF] = useState<number | "all" | "none">("all");
  const [sort, setSort] = useState<"updated" | "created" | "priority">("updated");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/tasks", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't load the QA subtasks");
      setTasks(j.tasks);
      setStatuses(j.statuses || []);
      setParentUrl(j.parent?.url || "");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    fetch("/api/members").then((r) => r.json()).then((j) => setMembers(j.members || [])).catch(() => {});
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const statusList = useMemo(() => {
    const map = new Map<string, { status: string; color: string; order: number; n: number }>();
    statuses.forEach((s) => map.set(s.status.toLowerCase(), { status: s.status, color: s.color, order: s.orderindex, n: 0 }));
    tasks.forEach((t) => {
      const k = t.status.toLowerCase();
      if (!map.has(k)) map.set(k, { status: t.status, color: t.statusColor, order: 99, n: 0 });
      map.get(k)!.n++;
    });
    return [...map.values()].filter((s) => s.n > 0).sort((a, b) => a.order - b.order);
  }, [tasks, statuses]);

  const people = useMemo(() => {
    const m = new Map<number, Person & { n: number }>();
    tasks.forEach((t) => t.assignees.forEach((a) => {
      if (!m.has(a.id)) m.set(a.id, { ...a, n: 0 });
      m.get(a.id)!.n++;
    }));
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [tasks]);

  const doneCount = tasks.filter((t) => DONE.includes(t.status.toLowerCase())).length;
  const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
  const openCount = tasks.length - doneCount;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const prioRank = (p: string | null) => ({ urgent: 1, high: 2, normal: 3, low: 4 } as any)[p || ""] || 5;
    return tasks
      .filter((t) => {
        const s = t.status.toLowerCase();
        if (statusF === "open" && DONE.includes(s)) return false;
        if (statusF !== "open" && statusF !== "all" && s !== statusF) return false;
        if (personF === "none" && t.assignees.length) return false;
        if (typeof personF === "number" && !t.assignees.some((a) => a.id === personF)) return false;
        if (needle && !t.name.toLowerCase().includes(needle)) return false;
        return true;
      })
      .sort((a, b) =>
        sort === "priority" ? prioRank(a.priority) - prioRank(b.priority) || b.dateUpdated - a.dateUpdated
        : sort === "created" ? b.dateCreated - a.dateCreated
        : b.dateUpdated - a.dateUpdated);
  }, [tasks, q, statusF, personF, sort]);

  const grouped = useMemo(() => {
    const g = new Map<string, Task[]>();
    filtered.forEach((t) => {
      const k = t.status.toLowerCase();
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(t);
    });
    return statusList.filter((s) => g.has(s.status.toLowerCase())).map((s) => ({ ...s, items: g.get(s.status.toLowerCase())! }));
  }, [filtered, statusList]);

  const unassigned = tasks.filter((t) => !t.assignees.length).length;

  return (
    <>
      <header className="top">
        <div className="top-row">
          <h1 className="brand">ADVC QA<small>QA subtasks · AdventureCraft</small></h1>
          <div className="spacer" />
          {parentUrl && <a className="btn" href={parentUrl} target="_blank" rel="noreferrer">Open in ClickUp</a>}
          <button className="btn" onClick={() => { setLoading(true); load(); }} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>New report</button>
        </div>
        <div className="xp" aria-label={`${doneCount} of ${tasks.length} completed`}>
          <span className="xp-level">{doneCount}</span>
          <div className="xp-track"><div className="xp-fill" style={{ width: `${pct}%` }} /></div>
          <span className="xp-label">{pct}% completed, {openCount} still open</span>
        </div>
      </header>

      <div className="shell">
        <aside className="side">
          <h2>Status</h2>
          <button className="fbtn" aria-pressed={statusF === "open"} onClick={() => setStatusF("open")}>
            Open <span className="n">{openCount}</span>
          </button>
          <button className="fbtn" aria-pressed={statusF === "all"} onClick={() => setStatusF("all")}>
            All <span className="n">{tasks.length}</span>
          </button>
          {statusList.map((s) => (
            <button key={s.status} className="fbtn" aria-pressed={statusF === s.status.toLowerCase()} onClick={() => setStatusF(s.status.toLowerCase())}>
              <span className="dot" style={{ background: s.color }} />
              <span style={{ textTransform: "capitalize" }}>{s.status}</span>
              <span className="n">{s.n}</span>
            </button>
          ))}
          <h2>Assigned to</h2>
          <button className="fbtn who" aria-pressed={personF === "all"} onClick={() => setPersonF("all")}>Anyone</button>
          {people.map((p) => (
            <button key={p.id} className="fbtn who" aria-pressed={personF === p.id} onClick={() => setPersonF(p.id)}>
              <Avatar p={p} /> <span>{p.username}</span> <span className="n">{p.n}</span>
            </button>
          ))}
          {unassigned > 0 && (
            <button className="fbtn who" aria-pressed={personF === "none"} onClick={() => setPersonF("none")}>
              Unassigned <span className="n">{unassigned}</span>
            </button>
          )}
        </aside>

        <main className="main">
          <div className="toolbar">
            <input className="search" type="search" placeholder="Search by title" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
              <option value="updated">Recently updated</option>
              <option value="created">Recently created</option>
              <option value="priority">Priority</option>
            </select>
          </div>

          {error && <div className="err">{error}</div>}
          {loading && !tasks.length && <p className="empty">Loading subtasks from ClickUp…</p>}
          {!loading && !error && !filtered.length && (
            <p className="empty">No subtasks match these filters. Change the filters or file a new report.</p>
          )}

          {grouped.map((g) => (
            <section className="group" key={g.status}>
              <h3 className="group-h"><span className="dot" style={{ background: g.color }} />{g.status} <span className="n">{g.items.length}</span></h3>
              <ul className="rows">
                {g.items.map((t) => (
                  <li
                    key={t.id}
                    className={`row${fresh === t.id ? " fresh" : ""}`}
                    tabIndex={0}
                    onClick={() => setOpenId(t.id)}
                    onKeyDown={(e) => e.key === "Enter" && setOpenId(t.id)}
                  >
                    <div className="row-title">
                      <span className="t">{t.name}</span>
                      <span className="row-meta">updated {ago(t.dateUpdated)}{t.creator ? `, by ${t.creator}` : ""}</span>
                    </div>
                    {t.priority ? <span className="prio" style={{ color: t.priorityColor || undefined }}>{t.priority}</span> : <span />}
                    <span className="avatars">{t.assignees.map((a) => <Avatar key={a.id} p={a} />)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </main>
      </div>

      {openId && (
        <Detail
          id={openId}
          members={members}
          onClose={() => setOpenId(null)}
          onUpdated={(t) => {
            setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...t } : x)));
            setToast("Assignees updated on ClickUp");
          }}
        />
      )}
      {creating && (
        <CreateForm
          members={members}
          onClose={() => setCreating(false)}
          onCreated={(t, msg) => {
            setTasks((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
            setFresh(t.id);
            setStatusF("open");
            setToast(msg);
            setCreating(false);
            setTimeout(load, 1500);
          }}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}

function Detail({ id, members, onClose, onUpdated }: {
  id: string;
  members: Person[];
  onClose: () => void;
  onUpdated: (t: Task) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<number[] | null>(null); // null = not editing
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetch(`/api/tasks/${id}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
    }).catch((e) => setErr(e.message));
  }, [id]);

  async function saveAssignees() {
    if (!picked) return;
    setSaving(true); setErr(null);
    try {
      const r = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignees: picked }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't update the assignees");
      setData((d: any) => ({ ...d, task: j.task }));
      onUpdated(j.task);
      setPicked(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  // Members of the list, plus anyone already assigned who isn't listed (e.g. a guest).
  const pool: Person[] = useMemo(() => {
    const m = new Map<number, Person>();
    members.forEach((p) => m.set(p.id, p));
    (data?.task.assignees || []).forEach((p: Person) => { if (!m.has(p.id)) m.set(p.id, p); });
    return [...m.values()];
  }, [members, data]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Subtask details">
        <button className="btn close" onClick={onClose}>Close</button>
        {err && <div className="err">{err}</div>}
        {!data && !err && <p className="empty">Loading…</p>}
        {data && (
          <>
            <h2>{data.task.name}</h2>
            <p className="row-meta" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span><span className="dot" style={{ background: data.task.statusColor, display: "inline-block", marginRight: 6 }} />{data.task.status}</span>
              {data.task.priority && <span className="prio" style={{ color: data.task.priorityColor }}>{data.task.priority}</span>}
            </p>
            <div className="field">
              <span>Assignees</span>
              {picked === null ? (
                <div className="chips">
                  {data.task.assignees.length
                    ? data.task.assignees.map((a: Person) => (
                        <span key={a.id} className="chip" style={{ cursor: "default" }}><Avatar p={a} />{a.username}</span>
                      ))
                    : <span className="hint" style={{ margin: 0 }}>Nobody assigned yet.</span>}
                  <button type="button" className="btn" style={{ padding: "4px 12px" }}
                    onClick={() => setPicked(data.task.assignees.map((a: Person) => a.id))}>
                    Edit assignees
                  </button>
                </div>
              ) : (
                <>
                  <div className="chips">
                    {pool.map((m) => (
                      <button type="button" key={m.id} className="chip" aria-pressed={picked.includes(m.id)} disabled={saving}
                        onClick={() => setPicked((p) => (p!.includes(m.id) ? p!.filter((x) => x !== m.id) : [...p!, m.id]))}>
                        <Avatar p={m} />{m.username}
                      </button>
                    ))}
                  </div>
                  <div className="actions" style={{ marginTop: 10 }}>
                    <button type="button" className="btn primary" onClick={saveAssignees} disabled={saving}>
                      {saving ? "Saving…" : "Save assignees"}
                    </button>
                    <button type="button" className="btn" onClick={() => setPicked(null)} disabled={saving}>Cancel</button>
                  </div>
                </>
              )}
            </div>
            {data.description ? <div className="desc">{data.description}</div> : <p className="hint">No description.</p>}
            {data.attachments.length > 0 && (
              <>
                <h3 style={{ fontSize: 14, marginTop: 18, marginBottom: 0 }}>Attachments</h3>
                <div className="att">
                  {data.attachments.map((a: any) => (
                    <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
                      {a.thumbnail || a.mimetype?.startsWith("image") ? <img src={a.thumbnail || a.url} alt="" /> : null}
                      <span>{a.title}</span>
                    </a>
                  ))}
                </div>
              </>
            )}
            <div className="actions">
              <a className="btn primary" href={data.task.url} target="_blank" rel="noreferrer">Open in ClickUp</a>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

// Pulls image/video files out of a paste event (screenshots copied to the clipboard).
function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f && (f.type.startsWith("image/") || f.type.startsWith("video/"))) out.push(f);
  }
  if (!out.length) {
    for (const f of Array.from(data.files || [])) {
      if (f.type.startsWith("image/") || f.type.startsWith("video/")) out.push(f);
    }
  }
  // Clipboard screenshots all arrive as "image.png": give each a unique, readable name.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return out.map((f, i) => {
    if (f.name && f.name !== "image.png" && f.name !== "image") return f;
    const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
    return new File([f], `screenshot-${stamp}${out.length > 1 ? `-${i + 1}` : ""}.${ext}`, { type: f.type });
  });
}

function CreateForm({ members, onClose, onCreated }: {
  members: Person[];
  onClose: () => void;
  onCreated: (t: Task, msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState("");
  const [assignees, setAssignees] = useState<number[]>([]);
  const [reporterId, setReporterId] = useState<number | null>(null);
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [blobOn, setBlobOn] = useState(false);
  const [pasted, setPasted] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const filesRef = useRef<Pending[]>([]);
  filesRef.current = files;

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(REPORTER_KEY));
      if (saved) setReporterId(saved);
    } catch {}
    fetch("/api/blob-upload").then((r) => r.json()).then((j) => setBlobOn(Boolean(j.enabled))).catch(() => {});
    return () => filesRef.current.forEach((f) => URL.revokeObjectURL(f.preview));
  }, []);

  const add = useCallback((list: FileList | File[]) => {
    const next = [...list]
      .filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
      .map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, file: f, preview: URL.createObjectURL(f), progress: 0, state: "idle" as const }));
    if (next.length) setFiles((p) => [...p, ...next]);
    return next.length;
  }, []);

  // Ctrl+V / Cmd+V anywhere while the form is open attaches clipboard images.
  // Plain text pastes still go into whichever field has focus.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (busy) return;
      const found = filesFromClipboard(e.clipboardData);
      if (!found.length) return;
      e.preventDefault();
      const n = add(found);
      if (n) setPasted((c) => c + n);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add, busy]);

  useEffect(() => {
    if (!pasted) return;
    const t = setTimeout(() => setPasted(0), 2200);
    return () => clearTimeout(t);
  }, [pasted]);

  function patch(key: string, v: Partial<Pending>) {
    setFiles((p) => p.map((f) => (f.key === key ? { ...f, ...v } : f)));
  }

  async function uploadOne(taskId: string, p: Pending) {
    patch(p.key, { state: "up", progress: 5 });
    if (p.file.size <= SMALL_LIMIT) {
      const fd = new FormData();
      fd.append("file", p.file);
      const r = await fetch(`/api/tasks/${taskId}/attachments`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
    } else {
      if (!blobOn) throw new Error("File over 4 MB: connect a Vercel Blob store to upload large videos");
      const blob = await upload(`qa/${taskId}/${p.file.name}`, p.file, {
        access: "public",
        handleUploadUrl: "/api/blob-upload",
        onUploadProgress: (e) => patch(p.key, { progress: Math.max(5, Math.round(e.percentage * 0.85)) }),
      });
      patch(p.key, { progress: 90 });
      const r = await fetch(`/api/tasks/${taskId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobUrl: blob.url, filename: p.file.name }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
    }
    patch(p.key, { state: "done", progress: 100 });
  }

  const reporter = members.find((m) => m.id === reporterId) || null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Add a title for the report."); return; }
    if (!reporter) { setErr("Pick who is reporting this."); return; }
    setBusy(true); setErr(null);
    try { localStorage.setItem(REPORTER_KEY, String(reporter.id)); } catch {}
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: desc,
          priority: priority || undefined,
          assignees,
          reporterId: reporter.id,
          reporter: reporter.username,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't create the subtask");
      const task: Task = j.task;

      let failed = 0;
      for (const p of files) {
        try { await uploadOne(task.id, p); }
        catch (e: any) { failed++; patch(p.key, { state: "fail", error: e.message }); }
      }
      if (failed) {
        setErr(`Subtask created on ClickUp, but ${failed} attachment(s) didn't upload. Add them from ClickUp.`);
        setBusy(false);
        onCreated(task, "Subtask created, some attachments missing");
        return;
      }
      onCreated(task, files.length ? `Subtask created with ${files.length} attachment(s)` : "Subtask created on ClickUp");
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="New report">
        <button className="btn close" onClick={onClose} disabled={busy}>Close</button>
        <h2>New report</h2>
        <p className="hint">Creates a QA subtask on ClickUp, with its attachments.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Title</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="E.g. The Frost Hammer deals no damage to Goblins" autoFocus required />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder={"What happens, what you expected, how to reproduce it.\nMarkdown supported."} />
          </label>
          <div className="field">
            <span>Reported by</span>
            {members.length ? (
              <div className="chips" role="radiogroup" aria-label="Reported by">
                {members.map((m) => (
                  <button type="button" key={m.id} className="chip" role="radio"
                    aria-checked={reporterId === m.id} aria-pressed={reporterId === m.id}
                    onClick={() => setReporterId(m.id)}>
                    <Avatar p={m} />{m.username}
                  </button>
                ))}
              </div>
            ) : <p className="hint">Loading team members…</p>}
            <div className="hint">Remembered on this device for your next reports.</div>
          </div>
          <div className="field">
            <span>Priority</span>
            <div className="chips">
              <button type="button" className="chip" style={{ paddingLeft: 10 }} aria-pressed={!priority} onClick={() => setPriority("")}>None</button>
              {PRIORITIES.map((p) => (
                <button type="button" key={p.v} className="chip" style={{ paddingLeft: 10 }} aria-pressed={priority === p.v} onClick={() => setPriority(p.v)}>
                  <span className="dot" style={{ background: p.color }} />{p.label}
                </button>
              ))}
            </div>
          </div>
          {members.length > 0 && (
            <div className="field">
              <span>Assign to</span>
              <div className="chips">
                {members.map((m) => (
                  <button type="button" key={m.id} className="chip" aria-pressed={assignees.includes(m.id)}
                    onClick={() => setAssignees((a) => (a.includes(m.id) ? a.filter((x) => x !== m.id) : [...a, m.id]))}>
                    <Avatar p={m} />{m.username}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <span>Images and videos</span>
            <div
              className={`drop${over ? " over" : ""}${pasted ? " over" : ""}`}
              role="button" tabIndex={0}
              onClick={() => input.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
            >
              {pasted
                ? `Pasted ${pasted} image${pasted > 1 ? "s" : ""} from the clipboard`
                : <>Paste screenshots with <kbd>Ctrl</kbd>+<kbd>V</kbd>, drop files here, or click to browse</>}
              <div className="hint">
                Paste works anywhere in this form, as many times as you like.{" "}
                {blobOn ? "Videos up to 1 GB." : "Up to 4 MB per file; large videos need a Vercel Blob store."}
              </div>
            </div>
            <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
            {files.length > 0 && (
              <div className="files">
                {files.map((f) => (
                  <div key={f.key} className={`file${f.state === "done" ? " done" : ""}${f.state === "fail" ? " fail" : ""}`} title={f.error || f.file.name}>
                    {f.file.type.startsWith("video/") ? <video src={f.preview} muted /> : <img src={f.preview} alt="" />}
                    <div className="fn">{f.file.name} · {fmtSize(f.file.size)}</div>
                    <div className="bar" style={{ width: `${f.progress}%` }} />
                    {f.state === "idle" && !busy && (
                      <button type="button" className="x" aria-label={`Remove ${f.file.name}`} onClick={() => {
                        URL.revokeObjectURL(f.preview);
                        setFiles((p) => p.filter((x) => x.key !== f.key));
                      }}>×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {err && <div className="err">{err}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? "Creating on ClickUp…" : "Create subtask"}</button>
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </aside>
    </>
  );
}
