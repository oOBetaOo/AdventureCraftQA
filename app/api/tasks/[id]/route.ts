import { cu, jsonError, mapTask, QA_PARENT_ID } from "@/lib/clickup";

export const dynamic = "force-dynamic";

// PATCH: change a QA subtask's assignees. Body: { assignees: number[] } (the full new set)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    if (!Array.isArray(body.assignees)) return jsonError(new Error("assignees must be a list of user ids"), 400);
    const wanted = new Set<number>(body.assignees.map(Number).filter(Boolean));

    const t = await cu<any>(`/task/${encodeURIComponent(id)}`);
    if (t.parent !== QA_PARENT_ID) return jsonError(new Error("This task is not a QA subtask"), 404);
    const current = new Set<number>((t.assignees || []).map((a: any) => Number(a.id)));

    const add = [...wanted].filter((x) => !current.has(x));
    const rem = [...current].filter((x) => !wanted.has(x));
    if (!add.length && !rem.length) return Response.json({ task: mapTask(t) });

    const updated = await cu<any>(`/task/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ assignees: { add, rem } }),
    });
    return Response.json({ task: mapTask(updated) });
  } catch (e) {
    return jsonError(e);
  }
}

// GET: one subtask with description and attachments (for the detail panel)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const t = await cu<any>(`/task/${encodeURIComponent(id)}?include_markdown_description=true`);
    if (t.parent !== QA_PARENT_ID) return jsonError(new Error("This task is not a QA subtask"), 404);
    return Response.json({
      task: mapTask(t),
      description: t.markdown_description || t.description || "",
      attachments: (t.attachments || []).map((a: any) => ({
        id: a.id,
        title: a.title,
        url: a.url,
        thumbnail: a.thumbnail_large || a.thumbnail_medium || a.thumbnail_small || null,
        extension: a.extension,
        mimetype: a.mimetype,
        size: a.size,
      })),
    });
  } catch (e) {
    return jsonError(e);
  }
}
