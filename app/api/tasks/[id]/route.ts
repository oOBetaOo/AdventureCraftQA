import { cu, jsonError, mapTask, QA_PARENT_ID } from "@/lib/clickup";

export const dynamic = "force-dynamic";

// GET: one subtask with description and attachments (for the detail panel)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const t = await cu<any>(`/task/${encodeURIComponent(id)}?include_markdown_description=true`);
    if (t.parent !== QA_PARENT_ID) return jsonError(new Error("Questa task non è una subtask di QA"), 404);
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
