import { auth } from "@/auth";
import { clientIp } from "@/lib/ratelimit/policy";
import { guardResume } from "@/lib/ratelimit/guard";
import { readResumeBuffer } from "@/lib/streaming/resumeBuffer";
import { encodeHeartbeat, encodeStreamEvent } from "@/lib/streaming/protocol";

// Same runtime/reasoning as /api/generate (route.ts) — the Node runtime is
// already the default, stated explicitly so a deployment platform reads
// maxDuration from the build output. Sized to comfortably outlast the worst
// case a reconnect can land in: the original generation's remaining
// STREAM_IDLE_TIMEOUT_MS (30s) plus RESUME_GRACE_MS (15s), with margin.
export const runtime = "nodejs";
export const maxDuration = 60;

/** Comment/heartbeat cadence while polling for new events, same reasoning as
 *  the generate route's own heartbeat (docs/adr/0042). */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** How often to re-check the resume buffer for events the original
 *  generation has written since the last check. Upstash Redis speaks HTTP,
 *  not pub/sub, so a short poll is the mechanism that actually fits this
 *  client — simpler than standing up a message bus for a recovery path that
 *  is, by design, rare (docs/adr/0043). */
const POLL_INTERVAL_MS = 300;

/** Gives up waiting for the original generation to reach a terminal state and
 *  closes the stream — well under `maxDuration`, leaving margin for the
 *  response itself to be sent. A client that reconnects again afterward
 *  (Last-Event-ID advanced to whatever this response already sent) is safe:
 *  reading the buffer is idempotent. */
const MAX_WAIT_MS = 50_000;

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request, { params }: RouteContext<"/api/generate/[requestId]/resume">) {
  const { requestId } = await params;
  if (!VALID_REQUEST_ID.test(requestId)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const session = await auth();
  const limited = await guardResume(request, session?.user?.id);
  if (limited) return limited;

  const identity = session?.user?.id ? `user:${session.user.id}` : `guest:${clientIp(request)}`;

  const lastEventIdHeader = request.headers.get("Last-Event-ID");
  const parsedLastEventId = lastEventIdHeader === null ? NaN : Number(lastEventIdHeader);
  const afterId = Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0;

  // A requestId alone is not a capability (docs/adr/0043) — a missing buffer
  // and one that belongs to someone else are deliberately indistinguishable,
  // same posture as ADR 0009/0011's ownership checks: 404 either way, never a
  // 403 that would confirm the id exists.
  const record = await readResumeBuffer(requestId, identity);
  if (!record) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let clientGone = false;
  let sentUpToId = afterId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A cancel() can land between the clientGone check at the top of the
      // loop and any individual enqueue below — every write is guarded the
      // same defensive way route.ts's own emit() is, rather than trusting the
      // outer checks alone.
      function sendBufferedFrom(rec: NonNullable<typeof record>): void {
        for (const { id, event } of rec.events) {
          if (id <= sentUpToId) continue;
          if (clientGone) return;
          try {
            controller.enqueue(encoder.encode(encodeStreamEvent(id, event)));
          } catch {
            clientGone = true;
            return;
          }
          sentUpToId = id;
        }
      }
      function closeIfPresent(): void {
        if (clientGone) return;
        try {
          controller.close();
        } catch {
          // Already gone — nothing to close.
        }
      }

      sendBufferedFrom(record);
      if (record.complete) {
        closeIfPresent();
        return;
      }

      const deadline = Date.now() + MAX_WAIT_MS;
      let lastHeartbeatAt = Date.now();
      while (!clientGone && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        if (clientGone) break;

        const latest = await readResumeBuffer(requestId, identity);
        if (!latest) break; // expired mid-poll — nothing more to send
        sendBufferedFrom(latest);
        if (latest.complete) {
          closeIfPresent();
          return;
        }

        if (!clientGone && Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
          try {
            controller.enqueue(encoder.encode(encodeHeartbeat()));
          } catch {
            clientGone = true;
          }
          lastHeartbeatAt = Date.now();
        }
      }

      closeIfPresent();
    },
    cancel() {
      clientGone = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
  });
}
