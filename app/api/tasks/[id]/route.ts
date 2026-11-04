import { cu, jsonError, mapTask, QA_PARENT_ID } from "@/lib/clickup";

export const dynamic = "force-dynamic";

async function getQASubtask(id: string, markdown = false) {
  const t = await cu<any>(`/task/${encodeURIComponent(id)}${markdown ? "?include_markdown_description=true" : ""}`);
  if (t.parent !== QA_PARENT_ID) {
    const err = new Error("This task is not a QA subtask");
    (err as any).status = 404;
    throw err;
  }
  return t;
}

function fail(e: unknown) {
  return jsonError(e, (e as any)?.status || 500);
}

function detail(t: any) {
  return {
    task: mapTask(t),
    description: t.markdown_description ?? t.description ?? "",
    attachments: (t.attachments || []).map((a: any) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      thumbnail: a.thumbnail_large || a.thumbnail_medium || a.thumbnail_small || null,
      extension: a.extension,
      mimetype: a.mimetype,
      size: a.size,
    })),
  };
}

// GET: one subtask with description and attachments (for the detail panel)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    return Response.json(detail(await getQASubtask(id, true)));
  } catch (e) {
    return fail(e);
  }
}

// PATCH: edit any field of a QA subtask. Only the fields present in the body change.
// Body: { name?, description?, status?, priority? (1-4 or null), dueDate? (ms or null), assignees? (full new set) }
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = await req.json();
    const current = await getQASubtask(id);
    const update: Record<string, unknown> = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return jsonError(new Error("A title is required"), 400);
      update.name = name;
    }
    if (typeof body.status === "string" && body.status) update.status = body.status;
    if ("priority" in body) update.priority = body.priority ? Number(body.priority) : null;
    if ("dueDate" in body) {
      update.due_date = body.dueDate ? Number(body.dueDate) : null;
      update.due_date_time = false;
    }
    if (Array.isArray(body.assignees)) {
      const wanted = new Set<number>(body.assignees.map(Number).filter(Boolean));
      const had = new Set<number>((current.assignees || []).map((a: any) => Number(a.id)));
      const add = [...wanted].filter((x) => !had.has(x));
      const rem = [...had].filter((x) => !wanted.has(x));
      if (add.length || rem.length) update.assignees = { add, rem };
    }
    const description = typeof body.description === "string" ? body.description : null;
    if (description !== null) update.markdown_content = description;

    if (Object.keys(update).length) {
      await cu(`/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(update) });
    }

    let fresh = await getQASubtask(id, true);
    // If this workspace ignored markdown_content, fall back to the plain description field.
    if (description !== null && (fresh.markdown_description ?? "").trim() !== description.trim()) {
      await cu(`/task/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify({ description: description || " " }),
      });
      fresh = await getQASubtask(id, true);
    }
    return Response.json(detail(fresh));
  } catch (e) {
    return fail(e);
  }
}

// DELETE: remove a QA subtask from ClickUp
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await getQASubtask(id); // refuse anything that isn't a QA subtask
    await cu(`/task/${encodeURIComponent(id)}`, { method: "DELETE" });
    return Response.json({ deleted: id });
  } catch (e) {
    return fail(e);
  }
}
