import { type Env, buildInfo } from "./env.js";

/**
 * knag — one plain-text document, always live.
 *
 * Scaffold state: `/health` only. The API (spec §5), auth (§4) and MCP server (§10)
 * arrive with build-order steps 1, 2 and 10 respectively — see docs/spec.md §13.
 *
 * Routing note: `run_worker_first` in wrangler.jsonc lists exactly the paths that
 * reach this handler. Everything else is served from `public/` by Workers Static
 * Assets without a Worker invocation, which is most of the free-tier request budget
 * (spec §14.4). Adding a route here means adding it there too.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated by design, and reports nothing about the document. `make health`
    // asserts this matches the checkout it is run from, which is the only thing that
    // catches "deployed from the wrong branch."
    if (url.pathname === "/health") {
      return Response.json(buildInfo(env));
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
} satisfies ExportedHandler<Env>;
