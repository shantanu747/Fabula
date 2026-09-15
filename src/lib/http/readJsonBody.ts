/**
 * Body-size bounding, shared by every mutating route (docs/adr/0048). Reading
 * the whole body as text first, then measuring it, is deliberate rather than
 * trusting `Content-Length` (a header the caller controls and this app must
 * not rely on) or streaming a manual byte-counted reader (real complexity
 * this app's actual exposure doesn't warrant — the platform's own request
 * body ceiling is the backstop against a truly unbounded stream; this exists
 * to reject a merely-oversized JSON payload with a clean 413 well before it,
 * not to defend against an attacker who ignores Content-Length entirely).
 */

/** Small-body routes: auth forms, story metadata, share/target-length
 *  toggles — every one of these is already bounded to a few hundred bytes by
 *  its own field-level caps, so this is generous headroom, not a real limit
 *  a legitimate request could ever approach. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

/** The two routes that carry a story's full `storySoFar` array
 *  (/api/generate, /api/stories/[id]/paragraphs) need room for
 *  MAX_STORY_PARAGRAPHS paragraphs at MAX_PARAGRAPH_TEXT_LENGTH each
 *  (src/lib/story/constants.ts) plus JSON overhead — comfortably over that
 *  product, not a tight fit around it. */
export const STORY_BODY_MAX_BYTES = 2 * 1024 * 1024;

export type ReadJsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: Response };

export async function readJsonBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES
): Promise<ReadJsonBodyResult> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid request body" }, { status: 400 }) };
  }

  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, response: Response.json({ error: "Request body too large." }, { status: 413 }) };
  }

  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: Response.json({ error: "Invalid JSON body" }, { status: 400 }) };
  }
}
