import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const dynamic = "force-dynamic";

// Issues short-lived tokens so the browser can upload big videos straight to Vercel Blob,
// bypassing the ~4.5 MB request limit of serverless functions.
export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json({ error: "Blob store not connected" }, { status: 501 });
  }
  const body = (await req.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["image/*", "video/*"],
        maximumSizeInBytes: 1024 * 1024 * 1024, // ClickUp accepts up to 1 GB
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {},
    });
    return Response.json(json);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function GET() {
  return Response.json({ enabled: Boolean(process.env.BLOB_READ_WRITE_TOKEN) });
}
