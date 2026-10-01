import { createFileRoute } from "@tanstack/react-router";

// Advances any running background transfers by one slice.
// Takes no input and returns only a count; work is limited to jobs users
// already started, and each job is locked so overlapping calls are harmless.
// Call it every minute from a scheduler to keep transfers running while no
// browser tab is open.
export const Route = createFileRoute("/api/public/transfer-tick")({
  server: {
    handlers: {
      GET: async () => {
        const { advanceAll } = await import("@/lib/transferEngine.server");
        const n = await advanceAll();
        return Response.json({ processed: n });
      },
      POST: async () => {
        const { advanceAll } = await import("@/lib/transferEngine.server");
        const n = await advanceAll();
        return Response.json({ processed: n });
      },
    },
  },
});
