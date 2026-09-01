import type { ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export function sendAnthropicMessage(
  res: ServerResponse,
  content: string = "Hello world",
  model: string = "claude-3-5-sonnet",
): void {
  sendJson(res, 200, {
    id: "msg_mock_001",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 20 },
  });
}

export function sendOpenAiCompletion(
  res: ServerResponse,
  content: string = "Hello world",
  model: string = "gpt-4o",
): void {
  sendJson(res, 200, {
    id: "chatcmpl-mock-001",
    object: "chat.completion",
    created: Date.now(),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

export function sendRateLimitError(
  res: ServerResponse,
  retryAfterSeconds: number = 60,
  message: string = "Rate limit exceeded",
): void {
  res.writeHead(429, {
    "Content-Type": "application/json",
    "Retry-After": `${retryAfterSeconds}`,
  });
  res.end(JSON.stringify({ error: { message, type: "rate_limit_error" } }));
}

export function sendSseEvent(
  res: ServerResponse,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
