import { cu, jsonError, mapTask, QA_LIST_ID, QA_PARENT_ID } from "@/lib/clickup";

export const dynamic = "force-dynamic";

// GET: all subtasks of the QA parent (open + closed)
export async function GET() {
  try {
    const parent = await cu<any>(`/task/${QA_PARENT_ID}?include_subtasks=true`);
    const tasks = (parent.subtasks || []).map(mapTask);

    // Statuses available on the list, so the UI can filter and colour them.
    let statuses: { status: string; color: string; orderindex: number }[] = [];
    try {
      const list = await cu<any>(`/list/${QA_LIST_ID}`);
      statuses = (list.statuses || []).map((s: any) => ({
        status: s.status,
        color: s.color,
        orderindex: s.orderindex,
      }));
    } catch {
      /* non-blocking */
    }

    return Response.json({
      parent: { id: parent.id, name: parent.name, url: parent.url, status: parent.status?.status },
      statuses,
      tasks,
      fetchedAt: Date.now(),
    });
  } catch (e) {
    return jsonError(e);
  }
}

// POST: create a new subtask under QA
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const name = String(body.name || "").trim();
    if (!name) return jsonError(new Error("A title is required"), 400);

    const payload: Record<string, unknown> = {
      name,
      parent: QA_PARENT_ID,
      markdown_content: String(body.description || ""),
    };
    if (Array.isArray(body.assignees) && body.assignees.length) {
      payload.assignees = body.assignees.map(Number).filter(Boolean);
    }
    if (body.priority) payload.priority = Number(body.priority); // 1 urgent · 2 high · 3 normal · 4 low
    if (body.status) payload.status = String(body.status);
    if (body.reporter) {
      payload.markdown_content =
        `${payload.markdown_content}\n\n---\n_Reported by ${String(body.reporter)} via the ADVC QA board_`.trim();
    }

    const created = await cu<any>(`/list/${QA_LIST_ID}/task`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return Response.json({ task: mapTask(created) }, { status: 201 });
  } catch (e) {
    return jsonError(e);
  }
}
