import { NextResponse, type NextRequest } from "next/server";

// Optional shared password (HTTP Basic Auth). Set APP_PASSWORD on Vercel to enable it.
// Any username works; only the password is checked.
export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === password) return NextResponse.next();
    } catch {
      /* fall through */
    }
  }
  return new NextResponse("Restricted to the AdventureCraft team", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ADVC QA", charset="UTF-8"' },
  });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
