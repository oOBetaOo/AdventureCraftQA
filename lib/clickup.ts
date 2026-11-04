// Server-only helpers for the ClickUp REST API (v2).
// The token never reaches the browser: every call goes through /api/* routes.

export const CLICKUP_API = "https://api.clickup.com/api/v2";

// Adventurecraft › ADVC - What's Left? › QA
export const QA_PARENT_ID = process.env.QA_PARENT_TASK_ID || "123n15he40e";
export const QA_LIST_ID = process.env.QA_LIST_ID || "901523125199";

function token(): string {
  const t = process.env.CLICKUP_API_TOKEN;
  if (!t) throw new Error("CLICKUP_API_TOKEN is not set on Vercel");
  return t;
}

export async function cu<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", token());
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${CLICKUP_API}${path}`, { ...init, headers, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ClickUp ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type Person = { id: number; username: string; email?: string; initials?: string; color?: string; profilePicture?: string | null };

export type QATask = {
  id: string;
  name: string;
  status: string;
  statusColor: string;
  priority: string | null;
  priorityColor: string | null;
  assignees: Person[];
  creator: string | null;
  tags: string[];
  url: string;
  dateCreated: number;
  dateUpdated: number;
};

export function mapTask(t: any): QATask {
  return {
    id: t.id,
    name: t.name,
    status: t.status?.status ?? "",
    statusColor: t.status?.color ?? "#999",
    priority: t.priority?.priority ?? null,
    priorityColor: t.priority?.color ?? null,
    assignees: (t.assignees || []).map((a: any) => ({
      id: a.id,
      username: a.username,
      email: a.email,
      initials: a.initials,
      color: a.color,
      profilePicture: a.profilePicture ?? null,
    })),
    creator: t.creator?.username ?? null,
    tags: (t.tags || []).map((x: any) => x.name),
    url: t.url,
    dateCreated: Number(t.date_created) || 0,
    dateUpdated: Number(t.date_updated) || 0,
  };
}

export function jsonError(e: unknown, status = 500) {
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: message }, { status });
}
