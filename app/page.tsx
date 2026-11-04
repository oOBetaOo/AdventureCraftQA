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
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min fa`;
  if (d < 86400) return `${Math.round(d / 3600)} h fa`;
  return `${Math.round(d / 86400)} g fa`;
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
      if (!r.ok) throw new Error(j.error || "Caricamento non riuscito");
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
          <h1 className="brand">ADVC QA<small>Subtask di QA · AdventureCraft</small></h1>
          <div className="spacer" />
          {parentUrl && <a className="btn" href={parentUrl} target="_blank" rel="noreferrer">Apri in ClickUp</a>}
          <button className="btn" onClick={() => { setLoading(true); load(); }} disabled={loading}>
            {loading ? "Aggiorno…" : "Aggiorna"}
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>Nuova segnalazione</button>
        </div>
        <div className="xp" aria-label={`${doneCount} di ${tasks.length} completate`}>
          <span className="xp-level">{doneCount}</span>
          <div className="xp-track"><div className="xp-fill" style={{ width: `${pct}%` }} /></div>
          <span className="xp-label">{pct}% completate, {openCount} ancora aperte</span>
        </div>
      </header>

      <div className="shell">
        <aside className="side">
          <h2>Stato</h2>
          <button className="fbtn" aria-pressed={statusF === "open"} onClick={() => setStatusF("open")}>
            Aperte <span className="n">{openCount}</span>
          </button>
          <button className="fbtn" aria-pressed={statusF === "all"} onClick={() => setStatusF("all")}>
            Tutte <span className="n">{tasks.length}</span>
          </button>
          {statusList.map((s) => (
            <button key={s.status} className="fbtn" aria-pressed={statusF === s.status.toLowerCase()} onClick={() => setStatusF(s.status.toLowerCase())}>
              <span className="dot" style={{ background: s.color }} />
              <span style={{ textTransform: "capitalize" }}>{s.status}</span>
              <span className="n">{s.n}</span>
            </button>
          ))}
          <h2>Assegnata a</h2>
          <button className="fbtn who" aria-pressed={personF === "all"} onClick={() => setPersonF("all")}>Chiunque</button>
          {people.map((p) => (
            <button key={p.id} className="fbtn who" aria-pressed={personF === p.id} onClick={() => setPersonF(p.id)}>
              <Avatar p={p} /> <span>{p.username}</span> <span className="n">{p.n}</span>
            </button>
          ))}
          {unassigned > 0 && (
            <button className="fbtn who" aria-pressed={personF === "none"} onClick={() => setPersonF("none")}>
              Nessuno <span className="n">{unassigned}</span>
            </button>
          )}
        </aside>

        <main className="main">
          <div className="toolbar">
            <input className="search" type="search" placeholder="Cerca per titolo" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cerca" />
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Ordina">
              <option value="updated">Aggiornate di recente</option>
              <option value="created">Create di recente</option>
              <option value="priority">Priorità</option>
            </select>
          </div>

          {error && <div className="err">{error}</div>}
          {loading && !tasks.length && <p className="empty">Carico le subtask da ClickUp…</p>}
          {!loading && !error && !filtered.length && (
            <p className="empty">Nessuna subtask con questi filtri. Cambia i filtri o crea una nuova segnalazione.</p>
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
                      <span className="row-meta">aggiornata {ago(t.dateUpdated)}{t.creator ? `, da ${t.creator}` : ""}</span>
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

      {openId && <Detail id={openId} onClose={() => setOpenId(null)} />}
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

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/tasks/${id}`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setData(j);
    }).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Dettaglio subtask">
        <button className="btn close" onClick={onClose}>Chiudi</button>
        {err && <div className="err">{err}</div>}
        {!data && !err && <p className="empty">Carico…</p>}
        {data && (
          <>
            <h2>{data.task.name}</h2>
            <p className="row-meta" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span><span className="dot" style={{ background: data.task.statusColor, display: "inline-block", marginRight: 6 }} />{data.task.status}</span>
              {data.task.priority && <span className="prio" style={{ color: data.task.priorityColor }}>{data.task.priority}</span>}
              <span className="avatars">{data.task.assignees.map((a: Person) => <Avatar key={a.id} p={a} />)}</span>
            </p>
            {data.description ? <div className="desc">{data.description}</div> : <p className="hint">Nessuna descrizione.</p>}
            {data.attachments.length > 0 && (
              <>
                <h3 style={{ fontSize: 14, marginTop: 18, marginBottom: 0 }}>Allegati</h3>
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
              <a className="btn primary" href={data.task.url} target="_blank" rel="noreferrer">Apri in ClickUp</a>
            </div>
          </>
        )}
      </aside>
    </>
  );
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
  const [reporter, setReporter] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [blobOn, setBlobOn] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { setReporter(localStorage.getItem("advc-reporter") || ""); } catch {}
    fetch("/api/blob-upload").then((r) => r.json()).then((j) => setBlobOn(Boolean(j.enabled))).catch(() => {});
  }, []);
  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.preview)), []); // eslint-disable-line

  function add(list: FileList | File[]) {
    const next = [...list]
      .filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
      .map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, file: f, preview: URL.createObjectURL(f), progress: 0, state: "idle" as const }));
    setFiles((p) => [...p, ...next]);
  }
  function patch(key: string, v: Partial<Pending>) {
    setFiles((p) => p.map((f) => (f.key === key ? { ...f, ...v } : f)));
  }

  async function uploadOne(taskId: string, p: Pending) {
    patch(p.key, { state: "up", progress: 5 });
    if (p.file.size <= SMALL_LIMIT) {
      const fd = new FormData();
      fd.append("file", p.file);
      const r = await fetch(`/api/tasks/${taskId}/attachments`, { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Errore ${r.status}`);
    } else {
      if (!blobOn) throw new Error("File oltre 4 MB: collega Vercel Blob per i video grandi");
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
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Errore ${r.status}`);
    }
    patch(p.key, { state: "done", progress: 100 });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setErr("Scrivi un titolo per la segnalazione."); return; }
    setBusy(true); setErr(null);
    try { localStorage.setItem("advc-reporter", reporter); } catch {}
    try {
      const r = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: desc, priority: priority || undefined, assignees, reporter: reporter || undefined }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Creazione non riuscita");
      const task: Task = j.task;

      let failed = 0;
      for (const p of files) {
        try { await uploadOne(task.id, p); }
        catch (e: any) { failed++; patch(p.key, { state: "fail", error: e.message }); }
      }
      if (failed) {
        setErr(`Subtask creata su ClickUp, ma ${failed} allegati non sono stati caricati. Aggiungili da ClickUp.`);
        setBusy(false);
        onCreated(task, "Subtask creata, alcuni allegati mancano");
        return;
      }
      onCreated(task, files.length ? `Subtask creata con ${files.length} allegati` : "Subtask creata su ClickUp");
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="scrim" onClick={() => !busy && onClose()} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Nuova segnalazione">
        <button className="btn close" onClick={onClose} disabled={busy}>Chiudi</button>
        <h2>Nuova segnalazione</h2>
        <p className="hint">Diventa una subtask di QA su ClickUp, con gli allegati.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Titolo</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Es. Il Frost Hammer non fa danno ai Goblin" autoFocus required />
          </label>
          <label className="field">
            <span>Descrizione</span>
            <textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)}
              onPaste={(e) => {
                const pasted = [...e.clipboardData.files];
                if (pasted.length) { e.preventDefault(); add(pasted); }
              }}
              placeholder={"Cosa succede, cosa ti aspettavi, come riprodurlo.\nSupporta Markdown."} />
          </label>
          <div className="field">
            <span>Priorità</span>
            <div className="chips">
              <button type="button" className="chip" style={{ paddingLeft: 10 }} aria-pressed={!priority} onClick={() => setPriority("")}>Nessuna</button>
              {PRIORITIES.map((p) => (
                <button type="button" key={p.v} className="chip" style={{ paddingLeft: 10 }} aria-pressed={priority === p.v} onClick={() => setPriority(p.v)}>
                  <span className="dot" style={{ background: p.color }} />{p.label}
                </button>
              ))}
            </div>
          </div>
          {members.length > 0 && (
            <div className="field">
              <span>Assegna a</span>
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
          <label className="field">
            <span>Il tuo nome</span>
            <input className="input" value={reporter} onChange={(e) => setReporter(e.target.value)} placeholder="Facoltativo, finisce in fondo alla descrizione" />
          </label>
          <div className="field">
            <span>Immagini e video</span>
            <div
              className={`drop${over ? " over" : ""}`}
              role="button" tabIndex={0}
              onClick={() => input.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
            >
              Trascina qui screenshot o clip, oppure clicca per sceglierli
              <div className="hint">
                {blobOn ? "Video fino a 1 GB." : "Fino a 4 MB per file; per video più grandi va collegato Vercel Blob."}
                {" "}Puoi anche incollare uno screenshot con Ctrl+V nella descrizione.
              </div>
            </div>
            <input ref={input} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => e.target.files && add(e.target.files)} />
            {files.length > 0 && (
              <div className="files">
                {files.map((f) => (
                  <div key={f.key} className={`file${f.state === "done" ? " done" : ""}${f.state === "fail" ? " fail" : ""}`} title={f.error || f.file.name}>
                    {f.file.type.startsWith("video/") ? <video src={f.preview} muted /> : <img src={f.preview} alt="" />}
                    <div className="fn">{f.file.name} · {fmtSize(f.file.size)}</div>
                    <div className="bar" style={{ width: `${f.progress}%` }} />
                    {f.state === "idle" && !busy && (
                      <button type="button" className="x" aria-label="Rimuovi" onClick={() => setFiles((p) => p.filter((x) => x.key !== f.key))}>×</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {err && <div className="err">{err}</div>}
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? "Creo su ClickUp…" : "Crea subtask"}</button>
            <button className="btn" type="button" onClick={onClose} disabled={busy}>Annulla</button>
          </div>
        </form>
      </aside>
    </>
  );
}
