import { cu, jsonError, QA_LIST_ID } from "@/lib/clickup";

export const dynamic = "force-dynamic";

// GET: people who can be assigned on the QA list
export async function GET() {
  try {
    const data = await cu<any>(`/list/${QA_LIST_ID}/member`);
    const members = (data.members || [])
      .map((m: any) => ({
        id: m.id,
        username: m.username || m.email,
        email: m.email,
        initials: m.initials,
        color: m.color,
        profilePicture: m.profilePicture ?? null,
      }))
      .sort((a: any, b: any) => String(a.username).localeCompare(String(b.username)));
    return Response.json({ members });
  } catch (e) {
    return jsonError(e);
  }
}
