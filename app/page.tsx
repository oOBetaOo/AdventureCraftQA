"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Person = { id: number; username: string; initials?: string; color?: string; profilePicture?: string | null };
type Task = {
  id: string; name: string; status: string; statusColor: string;
  priority: string | null; priorityColor: string | null;
  assignees: Person[]; creator: string | null; tags: string[]; url: string;
  dateCreated: number; dateUpdated: number; dueDate: number | null;
};
type Status = { status: string; color: string; orderindex: number };
type Pending = { key: string; file: File; preview: string | null; progress: number; state: "idle" | "up" | "done" | "fail"; error?: string };
type Attachment = { id: string; title: string; url: string; thumbnail: string | null; extension?: string; mimetype?: string; size?: number };

const DONE = ["completed", "closed", "complete", "done"];
const PRIORITIES = [
  { v: "1", label: "Urgent", key: "urgent", color: "#f50000" },
  { v: "2", label: "High", key: "high", color: "#f8ae00" },
  { v: "3", label: "Normal", key: "normal", color: "#6fddff" },
  { v: "4", label: "Low", key: "low", color: "#d8d8d8" },
];
const SMALL_LIMIT = 4 * 1024 * 1024; // above this, go through Vercel Blob
const REPORTER_KEY = "advc-reporter-id";

/* ---------------- small helpers ---------------- */

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
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}
function ext(name: string) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toUpperCase() : "FILE";
}
function toDateInput(ms: number | null) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromDateInput(v: string) {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime(); // noon local, so time zones don't shift the day
}
function prioValue(p: string | null) {
  return PRIORITIES.find((x) => x.key === (p || "").toLowerCase())?.v || "";
}

// Pulls files out of a paste event (screenshots or files copied to the clipboard).
function filesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  if (!out.length) out.push(...Array.from(data.files || []));
  // Clipboard screenshots all arrive as "image.png": give each a unique, readable name.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return out.map((f, i) => {
    if (f.name && f.name !== "image.png" && f.name !== "image") return f;
    const e = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
    return new File([f], `screenshot-${stamp}${out.length > 1 ? `-${i + 1}` : ""}.${e}`, { type: f.type });
  });
}

/* ---------------- attachments queue (shared by create + edit) ---------------- */

function useAttachQueue(blobOn: boolean) {
  const [files, setFiles] = useState<Pending[]>([]);
  const ref = useRef<Pending[]>([]);
  ref.current = files;
  useEffect(() => () => ref.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);

  const add = useCallback((list: FileList | File[]) => {
    const next = [...list].map((f) => ({
      key: `${f.name}-${f.size}-${Math.random()}`,
      file: f,
      preview: f.type.startsWith("image/") || f.type.startsWith("video/") ? URL.createObjectURL(f) : null,
      progress: 0,
      state: "idle" as const,
    }));
    if (next.length) setFiles((p) => [...p, ...next]);
    return next.length;
  }, []);
  const remove = useCallback((key: string) => {
    setFiles((p) => {
      const f = p.find((x) => x.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return p.filter((x) => x.key !== key);
    });
  }, []);
  const clearDone = useCallback(() => setFiles((p) => p.filter((x) => x.state !== "done")), []);
  const patch = (key: string, v: Partial<Pending>) => setFiles((p) => p.map((f) => (f.key === key ? { ...f, ...v } : f)));

  async function uploadOne(taskId: string, p: Pending) {
    patch(p.key, { state: "up", progress: 5, error: undefined });
    if (p.file.size <= SMALL_LIMIT) {
      const fd = new FormData();
      fd.append("file", p.file);
      const r = await fetch(`/api/tasks/${taskId}/attachments`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
    } else {
      if (!blobOn) throw new Error("File over 4 MB: connect a Vercel Blob store to upload large files");
      const blob = await upload(`qa/${taskId}/${p.file.name}`, p.file, {
        access: "public",
        handleUploadUrl: "/api/blob-upload",
        contentType: p.file.type || "application/octet-stream",
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

  // Uploads every file not yet uploaded; returns how many failed.
  async function uploadAll(taskId: string) {
    let failed = 0;
    for (const p of ref.current.filter((x) => x.state !== "done")) {
      try { await uploadOne(taskId, p); }
      catch (e: any) { failed++; patch(p.key, { state: "fail", error: e.message }); }
    }
    return failed;
  }

  return { files, add, remove, uploadAll, clearDone };
}

function useBlobEnabled() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    fetch("/api/blob-upload").then((r) => r.json()).then((j) => setOn(Boolean(j.enabled))).catch(() => {});
  }, []);
  return on;
}

// Ctrl+V / Cmd+V anywhere while a panel is open attaches clipboard files.
// Plain text pastes still go into whichever field has focus.
function usePasteFiles(enabled: boolean, add: (f: File[]) => number) {
  const [pasted, setPasted] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    function onPaste(e: ClipboardEvent) {
      const found = filesFromClipboard(e.clipboardData);
      if (!found.length) return;
      e.preventDefault();
      const n = add(found);
      if (n) setPasted((c) => c + n);
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enabled, add]);
  useEffect(() => {
    if (!pasted) return;
    const t = setTimeout(() => setPasted(0), 2200);
    return () => clearTimeout(t);
  }, [pasted]);
  return pasted;
}

function FileDrop({ queue, blobOn, busy, pasted }: {
  queue: ReturnType<typeof useAttachQueue>;
  blobOn: boolean;
  busy: boolean;
  pasted: number;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <div
        className={`drop${over || pasted ? " over" : ""}`}
        role="button" tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); queue.add(e.dataTransfer.files); }}
      >
        {pasted
          ? `Pasted ${pasted} file${pasted > 1 ? "s" : ""} from the clipboard`
          : <>Paste with <kbd>Ctrl</kbd>+<kbd>V</kbd>, drop files here, or click to browse</>}
        <div className="hint">
          Images, videos, logs, .zip, .mcaddon… any file type.{" "}
          {blobOn ? "Up to 1 GB each." : "Up to 4 MB each until a Vercel Blob store is connected."}
        </div>
      </div>
      <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) queue.add(e.target.files); e.target.value = ""; }} />
      {queue.files.length > 0 && (
        <div className="files">
          {queue.files.map((f) => (
            <div key={f.key} className={`file${f.state === "done" ? " done" : ""}${f.state === "fail" ? " fail" : ""}`} title={f.error || f.file.name}>
              {f.preview && f.file.type.startsWith("video/") ? <video src={f.preview} muted />
                : f.preview ? <img src={f.preview} alt="" />
                : <div className="ficon">{ext(f.file.name)}</div>}
              <div className="fn">{f.file.name} · {fmtSize(f.file.size)}</div>
              {f.error && <div className="ferr">{f.error}</div>}
              <div className="bar" style={{ width: `${f.progress}%` }} />
              {f.state !== "up" && f.state !== "done" && !busy && (
                <button type="button" className="x" aria-label={`Remove ${f.file.name}`} onClick={() => queue.remove(f.key)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ---------------- people dropdown with search ---------------- */

function PeoplePicker({ people, value, onChange, multiple = true, placeholder, disabled, label }: {
  people: Person[];
  value: number[];
  onChange: (ids: number[]) => void;
  multiple?: boolean;
  placeholder: string;
  disabled?: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const selected = value.map((id) => people.find((p) => p.id === id)).filter(Boolean) as Person[];
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? people.filter((p) => p.username.toLowerCase().includes(n)) : people;
  }, [people, q]);

  useEffect(() => {
    if (!open) return;
    setHi(0);
    setTimeout(() => search.current?.focus(), 0);
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => setHi(0), [q]);

  function toggle(id: number) {
    if (!multiple) { onChange([id]); setOpen(false); setQ(""); return; }
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (list[hi]) toggle(list[hi].id); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  }

  return (
    <div className="pp" ref={box}>
      <button type="button" className="pp-trigger" onClick={() => setOpen((o) => !o)} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
        {selected.length ? (
          <span className="pp-sel">
            {selected.map((p) => (
              <span key={p.id} className="pp-tag">
                <Avatar p={p} />{p.username}
                {multiple && !disabled && (
                  <span className="pp-rm" role="button" aria-label={`Remove ${p.username}`}
                    onClick={(e) => { e.stopPropagation(); toggle(p.id); }}>×</span>
                )}
              </span>
            ))}
          </span>
        ) : <span className="pp-ph">{placeholder}</span>}
        <span className="pp-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="pp-pop">
          <input ref={search} className="pp-search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Type a name" aria-label={`Search ${label.toLowerCase()}`} />
          <ul className="pp-list" role="listbox" aria-multiselectable={multiple}>
            {list.map((p, i) => {
              const on = value.includes(p.id);
              return (
                <li key={p.id} role="option" aria-selected={on} className={`pp-opt${i === hi ? " hi" : ""}`}
                  onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); toggle(p.id); }}>
                  {multiple && <span className={`pp-check${on ? " on" : ""}`} aria-hidden>{on ? "✓" : ""}</span>}
                  <Avatar p={p} />{p.username}
                </li>
              );
            })}
            {!list.length && <li className="pp-none">Nobody matches “{q}”</li>}
          </ul>
          {multiple && (
            <div className="pp-foot">
              <button type="button" className="btn" onClick={() => onChange([])}>Clear</button>
              <button type="button" className="btn primary" onClick={() => { setOpen(false); setQ(""); }}>Done</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AssigneeField({ people, value, onChange, me, disabled }: {
  people: Person[]; value: number[]; onChange: (ids: number[]) => void; me: Person | null; disabled?: boolean;
}) {
  return (
    <div className="assign-row">
      <PeoplePicker people={people} value={value} onChange={onChange} placeholder="Nobody assigned" label="Assignees" disabled={disabled} />
      {me && !value.includes(me.id) && (
        <button type="button" className="btn small" onClick={() => onChange([...value, me.id])} disabled={disabled}>Assign me</button>
      )}
    </div>
  );
}

function PriorityChips({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="chips">
      <button type="button" className="chip" style={{ paddingLeft: 10 }} aria-pressed={!value} onClick={() => onChange("")} disabled={disabled}>None</button>
      {PRIORITIES.map((p) => (
        <button type="button" key={p.v} className="chip" style={{ paddingLeft: 10 }} aria-pressed={value === p.v} onClick={() => onChange(p.v)} disabled={disabled}>
          <span className="dot" style={{ background: p.color }} />{p.label}
        </button>
      ))}
    </div>
  );
}

function useMe(people: Person[]) {
  const [meId, setMeId] = useState<number | null>(null);
  useEffect(() => {
    try { const v = Number(localStorage.getItem(REPORTER_KEY)); if (v) setMeId(v); } catch {}
  }, []);
  const set = (id: number | null) => {
    setMeId(id);
    try { id ? localStorage.setItem(REPORTER_KEY, String(id)) : localStorage.removeItem(REPORTER_KEY); } catch {}
  };
  return { me: people.find((p) => p.id === meId) || null, meId, setMeId: set };
}

/* ---------------- page ---------------- */

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

  // People ordered by how often they're assigned on QA, so the regulars are at the top of every dropdown.
  const ranked = useMemo(() => {
    const count = new Map<number, number>();
    tasks.forEach((t) => t.assignees.forEach((a) => count.set(a.id, (count.get(a.id) || 0) + 1)));
    const all = new Map<number, Person>();
    members.forEach((m) => all.set(m.id, m));
    tasks.forEach((t) => t.assignees.forEach((a) => { if (!all.has(a.id)) all.set(a.id, a); }));
    return [...all.values()].sort((a, b) =>
      (count.get(b.id) || 0) - (count.get(a.id) || 0) || a.username.localeCompare(b.username));
  }, [members, tasks]);

  const statusList = useMemo(() => {
    const map = new Map<string, { status: string; color: string; order: number; n: number }>();
    statuses.forEach((s) => map.set(s.status.toLowerCase(), { status: s.status, color: s.color, order: s.orderindex, n: 0 }));
    tasks.forEach((t) => {
      const k = t.status.toLowerCase();
      if (!map.has(k)) map.set(k, { status: t.status, color: t.statusColor, order: 99, n: 0 });
      map.get(k)!.n++;
    });
    return [...map.values()].sort((a, b) => a.order - b.order);
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
          {statusList.filter((s) => s.n > 0).map((s) => (
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
          people={ranked}
          statuses={statusList}
          onClose={() => setOpenId(null)}
          onUpdated={(t) => {
            setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...t } : x)));
            setToast("Changes saved to ClickUp");
          }}
          onDeleted={(id) => {
            setTasks((prev) => prev.filter((x) => x.id !== id));
            setOpenId(null);
            setToast("Subtask deleted from ClickUp");
          }}
        />
      )}
      {creating && (
        <CreateForm
          people={ranked}
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

/* ---------------- detail / edit panel ---------------- */

function Detail({ id, people, statuses, onClose, onUpdated, onDeleted }: {
  id: string;
  people: Person[];
  statuses: { status: string; color: string }[];
  onClose: () => void;
  onUpdated: (t: Task) => void;
  onDeleted: (id: string) => void;
}) {
  const [data, setData] = useState<{ task: Task; description: string; attachments: Attachment[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const blobOn = useBlobEnabled();
  const queue = useAttachQueue(blobOn);
  const pasted = usePasteFiles(Boolean(data) && !saving, queue.add);
  const { me } = useMe(people);

  // editable copy
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [due, setDue] = useState("");
  const [assignees, setAssignees] = useState<number[]>([]);

  function fill(d: { task: Task; description: string }) {
    setName(d.task.name);
    setDesc(d.description || "");
    setStatus(d.task.status);
    setPriority(prioValue(d.task.priority));
    setDue(toDateInput(d.task.dueDate));
    setAssignees(d.task.assignees.map((a) => a.id));
  }

  useEffect(() => {
    fetch(`/api/tasks/${id}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j); fill(j);
    }).catch((e) => setErr(e.message));
  }, [id]);

  const dirtyFields = useMemo(() => {
    if (!data) return {} as Record<string, unknown>;
    const t = data.task;
    const out: Record<string, unknown> = {};
    if (name.trim() !== t.name) out.name = name;
    if (desc !== (data.description || "")) out.description = desc;
    if (status.toLowerCase() !== t.status.toLowerCase()) out.status = status;
    if (priority !== prioValue(t.priority)) out.priority = priority || null;
    if (due !== toDateInput(t.dueDate)) out.dueDate = fromDateInput(due);
    const had = t.assignees.map((a) => a.id).sort().join(",");
    if ([...assignees].sort().join(",") !== had) out.assignees = assignees;
    return out;
  }, [data, name, desc, status, priority, due, assignees]);
  const pendingFiles = queue.files.filter((f) => f.state !== "done").length;
  const dirty = Object.keys(dirtyFields).length > 0 || pendingFiles > 0;

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // Escape already handled (e.g. closing a dropdown)
      if (e.key === "Escape" && !saving && !deleting) {
        if (dirty && !confirm("Discard your unsaved changes?")) return;
        onClose();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, dirty, saving, deleting]);

  function tryClose() {
    if (saving || deleting) return;
    if (dirty && !confirm("Discard your unsaved changes?")) return;
    onClose();
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (!data || !dirty) return;
    if (!name.trim()) { setErr("The title can't be empty."); return; }
    setSaving(true); setErr(null);
    try {
      let next = data;
      if (Object.keys(dirtyFields).length) {
        const r = await fetch(`/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dirtyFields),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Couldn't save the changes");
        next = j;
      }
      if (pendingFiles) {
        const failed = await queue.uploadAll(id);
        const r = await fetch(`/api/tasks/${id}`);
        if (r.ok) next = await r.json();
        if (failed) setErr(`${failed} file(s) didn't upload. Hover them to see why, then save again to retry.`);
        else queue.clearDone();
      }
      setData(next); fill(next);
      onUpdated(next.task);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setDeleting(true); setErr(null);
    try {
      const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Couldn't delete the subtask");
      onDeleted(id);
    } catch (e: any) {
      setErr(e.message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const busy = saving || deleting;
  const statusColor = statuses.find((s) => s.status.toLowerCase() === status.toLowerCase())?.color || data?.task.statusColor;

  return (
    <>
      <div className="scrim" onClick={tryClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Edit subtask">
        <button className="btn close" onClick={tryClose} disabled={busy}>Close</button>
        {!data && !err && <p className="empty">Loading…</p>}
        {!data && err && <div className="err">{err}</div>}
        {data && (
          <form onSubmit={save}>
            <label className="field" style={{ marginTop: 0 }}>
              <span>Title</span>
              <input className="input title-input" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} required />
            </label>

            <div className="grid2">
              <label className="field">
                <span>Status</span>
                <span className="select-wrap">
                  <span className="dot" style={{ background: statusColor }} />
                  <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy}>
                    {statuses.map((s) => <option key={s.status} value={s.status}>{s.status}</option>)}
                    {!statuses.some((s) => s.status.toLowerCase() === status.toLowerCase()) && <option value={status}>{status}</option>}
                  </select>
                </span>
              </label>
              <label className="field">
                <span>Due date</span>
                <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={busy} />
              </label>
            </div>

            <div className="field">
              <span>Priority</span>
              <PriorityChips value={priority} onChange={setPriority} disabled={busy} />
            </div>

            <div className="field">
              <span>Assignees</span>
              <AssigneeField people={people} value={assignees} onChange={setAssignees} me={me} disabled={busy} />
            </div>

            <label className="field">
              <span>Description</span>
              <textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)} disabled={busy}
                placeholder={"What happens, what you expected, how to reproduce it.\nMarkdown supported."} />
            </label>

            <div className="field">
              <span>Attachments</span>
              {data.attachments.length > 0 ? (
                <div className="att">
                  {data.attachments.map((a) => (
                    <a key={a.id} href={a.url} target="_blank" rel="noreferrer" title={a.title}>
                      {a.thumbnail || a.mimetype?.startsWith("image") ? <img src={a.thumbnail || a.url} alt="" />
                        : <div className="ficon">{(a.extension || ext(a.title)).toUpperCase()}</div>}
                      <span>{a.title}</span>
                    </a>
                  ))}
                </div>
              ) : <p className="hint" style={{ marginTop: 0 }}>No attachments yet.</p>}
              <div style={{ marginTop: 10 }}>
                <FileDrop queue={queue} blobOn={blobOn} busy={busy} pasted={pasted} />
              </div>
            </div>

            {err && <div className="err">{err}</div>}

            <div className="actions sticky-actions">
              <button className="btn primary" type="submit" disabled={busy || !dirty}>
                {saving ? "Saving…" : pendingFiles && !Object.keys(dirtyFields).length ? `Upload ${pendingFiles} file${pendingFiles > 1 ? "s" : ""}` : "Save changes"}
              </button>
              {dirty && !busy && <button className="btn" type="button" onClick={() => { fill(data); queue.files.forEach((f) => f.state !== "done" && queue.remove(f.key)); setErr(null); }}>Undo changes</button>}
              <span className="spacer" />
              <a className="btn" href={data.task.url} target="_blank" rel="noreferrer">Open in ClickUp</a>
            </div>

            <div className="danger-zone">
              {!confirmDelete ? (
                <button type="button" className="btn danger-ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete subtask</button>
              ) : (
                <div className="confirm">
                  <span>Delete “{data.task.name}” from ClickUp?</span>
                  <button type="button" className="btn danger" onClick={remove} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
                  <button type="button" className="btn" onClick={() => setConfirmDelete(false)} disabled={deleting}>Keep it</button>
                </div>
              )}
            </div>
          </form>
        )}
      </aside>
    </>
  );
}

/* ---------------- create panel ---------------- */

function CreateForm({ people, onClose, onCreated }: {
  people: Person[];
  onClose: () => void;
  onCreated: (t: Task, msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState("");
  const [assignees, setAssignees] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blobOn = useBlobEnabled();
  const queue = useAttachQueue(blobOn);
  const pasted = usePasteFiles(!busy, queue.add);
  const { me, meId, setMeId } = useMe(people);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Add a title for the report."); return; }
    if (!me) { setErr("Pick who is reporting this."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: desc, priority: priority || undefined, assignees, reporter: me.username }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Couldn't create the subtask");
      const task: Task = j.task;
      const n = queue.files.length;
      const failed = await queue.uploadAll(task.id);
      if (failed) {
        setErr(`Subtask created on ClickUp, but ${failed} file(s) didn't upload. Open the subtask to add them again.`);
        setBusy(false);
        onCreated(task, "Subtask created, some attachments missing");
        return;
      }
      onCreated(task, n ? `Subtask created with ${n} attachment(s)` : "Subtask created on ClickUp");
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
          <div className="grid2">
            <div className="field">
              <span>Reported by</span>
              <PeoplePicker people={people} value={meId ? [meId] : []} onChange={(ids) => setMeId(ids[0] ?? null)}
                multiple={false} placeholder="Pick yourself" label="Reported by" disabled={busy} />
              <div className="hint">Remembered on this device.</div>
            </div>
            <div className="field">
              <span>Assign to</span>
              <AssigneeField people={people} value={assignees} onChange={setAssignees} me={me} disabled={busy} />
            </div>
          </div>
          <div className="field">
            <span>Priority</span>
            <PriorityChips value={priority} onChange={setPriority} disabled={busy} />
          </div>
          <div className="field">
            <span>Attachments</span>
            <FileDrop queue={queue} blobOn={blobOn} busy={busy} pasted={pasted} />
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
