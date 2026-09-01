import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { anthropicStreamHead, anthropicStreamTail, anthropicTextDelta } from "./anthropic-sse";
import { openaiStreamTail, openaiTextDelta } from "./openai-sse";
import type {
  MockProvider,
  MockProviderOptions,
  MockResponse,
  MockScript,
  Vendor,
} from "./types";

/**
 * Plain node:http mock for the real provider SDKs. Routes only the two POST
 * paths the adapters use: `/v1/messages` (Anthropic) and `/v1/chat/completions`
 * (both OpenAI-shaped providers — the OpenAI SDK appends it to any base URL).
 * Listens on an ephemeral port by default so parallel suites never collide.
 *
 * The script function decides the response per request; swap it between
 * tests with setScript(). Until one is installed every call fails loudly —
 * a silent default paragraph would mask a forgotten setScript in a test that
 * meant to install its own fixture.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

function vendorFor(pathname: string): Vendor | undefined {
  if (pathname === "/v1/messages") return "anthropic";
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") return "openai";
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelOf(body: unknown): string {
  if (typeof body === "object" && body !== null && "model" in body) {
    const model = (body as { model: unknown }).model;
    if (typeof model === "string") return model;
  }
  return "mock-model";
}

function deltaFor(vendor: Vendor, text: string, model: string): string {
  return vendor === "anthropic" ? anthropicTextDelta(text) : openaiTextDelta(text, model);
}

async function writeResponse(vendor: Vendor, body: unknown, mockResponse: MockResponse, res: ServerResponse): Promise<void> {
  const model = modelOf(body);

  if (mockResponse.kind === "error") {
    const payload = mockResponse.body ?? { message: `mock-provider error ${mockResponse.status}` };
    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.writeHead(mockResponse.status, { "Content-Type": "application/json" });
    res.end(serialized);
    return;
  }

  if (mockResponse.kind === "hang") {
    // Deliberate: accept and never answer. The SDK's own timeout/abort has to
    // be what ends this; the server side stays silent. Sockets are tracked
    // and destroyed in stop(), so cleanup is not left hanging too.
    return;
  }

  if (mockResponse.kind === "truncate") {
    res.writeHead(200, SSE_HEADERS);
    res.write(vendor === "anthropic" ? anthropicStreamHead(model) : "");
    for (const chunk of mockResponse.chunks) {
      res.write(deltaFor(vendor, chunk, model));
    }
    // Abort the socket rather than ending the response cleanly: a clean FIN
    // would read to the SDK as a shortened-but-valid stream, and both Plans 2
    // and 4 want the actual mid-stream failure. The zero-length write gives
    // us a callback that fires after the preceding data has flushed.
    const socket = res.socket;
    if (socket) {
      socket.write("", () => socket.destroy());
    }
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  if (vendor === "anthropic") res.write(anthropicStreamHead(model));
  let total = 0;
  for (const chunk of mockResponse.chunks) {
    total += chunk.length;
    res.write(deltaFor(vendor, chunk, model));
    if (mockResponse.delayMs) await sleep(mockResponse.delayMs);
  }
  res.write(vendor === "anthropic" ? anthropicStreamTail(total) : openaiStreamTail(model));
  res.end();
}

export async function startMockProvider(options: MockProviderOptions = {}): Promise<MockProvider> {
  const sockets = new Set<Socket>();
  let script: MockScript = () => ({
    kind: "error",
    status: 501,
    body: { message: "mock-provider: no script installed — call setScript() first" },
  });

  const server = createServer();

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const vendor = vendorFor(req.url ?? "");
      if (req.method !== "POST" || !vendor) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `mock-provider: no route for ${req.method} ${req.url}` }));
        return;
      }
      const bodyText = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "mock-provider: request body is not JSON" }));
        return;
      }
      try {
        const mockResponse = script({ vendor, path: req.url ?? "", body });
        await writeResponse(vendor, body, mockResponse, res);
      } catch (err) {
        // A throwing script is a test bug; fail the request loudly rather
        // than leaving the SDK (and the test) to hang on an open socket.
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `mock-provider: script threw: ${String(err)}` }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock-provider: server has no address");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    setScript(next) {
      script = next;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
