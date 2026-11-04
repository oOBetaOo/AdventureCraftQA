import { del } from "@vercel/blob";
import { CLICKUP_API, cu, jsonError, QA_PARENT_ID } from "@/lib/clickup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function assertQASubtask(id: string) {
  const t = await cu<any>(`/task/${encodeURIComponent(id)}`);
  if (t.parent !== QA_PARENT_ID) throw new Error("Questa task non è una subtask di QA");
}

async function sendToClickUp(id: string, file: Blob, filename: string) {
  const fd = new FormData();
  fd.append("attachment", file, filename);
  const res = await fetch(`${CLICKUP_API}/task/${encodeURIComponent(id)}/attachment`, {
    method: "POST",
    headers: { Authorization: process.env.CLICKUP_API_TOKEN || "" },
    body: fd,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// POST: attach a file to a QA subtask.
//  - multipart/form-data with "file" (small files, < ~4 MB on Vercel)
//  - JSON { blobUrl, filename } for large files already uploaded to Vercel Blob
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await assertQASubtask(id);

    const type = req.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const { blobUrl, filename } = await req.json();
      const host = new URL(String(blobUrl)).hostname;
      if (!host.endsWith(".public.blob.vercel-storage.com")) {
        return jsonError(new Error("URL blob non valido"), 400);
      }
      const r = await fetch(blobUrl);
      if (!r.ok) throw new Error(`Download blob fallito (${r.status})`);
      const blob = await r.blob();
      const out = await sendToClickUp(id, blob, String(filename || "file"));
      // The file now lives on ClickUp: remove the temporary copy.
      try { await del(blobUrl); } catch { /* ignore */ }
      return Response.json({ attachment: out });
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError(new Error("Nessun file ricevuto"), 400);
    const out = await sendToClickUp(id, file, file.name);
    return Response.json({ attachment: out });
  } catch (e) {
    return jsonError(e);
  }
}
