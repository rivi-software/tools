// Workers AI's Chat Completions on Cloudflare's AI REST API
// (`/accounts/<id>/ai/v1/chat/completions`), with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_API_TOKEN.
// With AI_GATEWAY, the calls go through that AI Gateway (`cf-aig-gateway-id`), with its own token
// when CLOUDFLARE_AI_GATEWAY_TOKEN is set, and the gateway logs each call's metadata but never its
// text: a pull request may hold what its repository keeps private. Node built-ins only.

import { setTimeout as sleep } from "node:timers/promises";

import type { Env, Fetch } from "./common.ts";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ModelMessage {
  content?: string | null;
  tool_calls?: ToolCall[];
}

/** A tool the model may call, as Chat Completions takes it. */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

/** A Chat Completions request to Workers AI; `workersAiMessage` adds `stream`. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  tool_choice?: string;
  tools?: ToolDefinition[];
}

/** Where a Chat Completions request goes, and its headers. */
export interface AiRequest {
  url: string;
  headers: Record<string, string>;
}

/** The headers that send a call through the AI Gateway `AI_GATEWAY`; none without one. */
const gatewayHeaders = (env: Env): [string, string][] => {
  if (!env.AI_GATEWAY) {
    return [];
  }

  // The gateway's logs tell the calls apart by repository, pull request, workflow and run (five
  // keys at most).
  const metadata = {
    app: "rivi-bot",
    issue: env.ISSUE_NUMBER,
    repo: env.GITHUB_REPOSITORY,
    run: env.GITHUB_RUN_ID,
    workflow: env.GITHUB_WORKFLOW,
  };

  return Object.entries({
    // An authenticated gateway takes its own token; without one, the API token serves both headers.
    "cf-aig-authorization": `Bearer ${env.CLOUDFLARE_AI_GATEWAY_TOKEN || env.CLOUDFLARE_AI_API_TOKEN}`,
    "cf-aig-collect-log-payload": "false",
    "cf-aig-gateway-id": env.AI_GATEWAY,
    "cf-aig-metadata": JSON.stringify(
      Object.fromEntries(Object.entries(metadata).filter(([, value]) => value))
    ),
    "cf-aig-skip-cache": "true",
  });
};

/** Workers AI's Chat Completions URL and headers, through the AI Gateway `AI_GATEWAY` when one is named. */
export const workersAiRequest = (env: Env): AiRequest => ({
  headers: Object.fromEntries([
    ["authorization", `Bearer ${env.CLOUDFLARE_AI_API_TOKEN}`],
    ["content-type", "application/json"],
    ...gatewayHeaders(env),
  ]),
  url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
});

// A model can think for longer than the five minutes Node's fetch waits for a response's headers,
// so answers stream: thinking keeps the stream going, and a call fails only when it goes quiet or
// runs past `answerMs`. The review shares one time budget across its rounds, and gives each call
// what is left of it, at most `answerMs`.
export const AI_LIMITS = { answerMs: 12 * 60_000, quietMs: 120_000 };

export type AiLimits = typeof AI_LIMITS;

/** A piece of a streamed tool call: its id and name come in its first chunk, its arguments in pieces after. */
interface ToolCallDelta {
  index: number;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null };
}

interface Choice {
  message?: ModelMessage;
  delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
  finish_reason?: string | null;
}

/** A Chat Completions answer: the model's message and why it stopped. */
interface ModelAnswer {
  message: ModelMessage;
  finish?: string;
}

/** A streamed answer as it adds up. */
interface StreamedAnswer {
  content: string;
  finish?: string;
  calls: ToolCall[];
}

const SSE_DATA = /^data:\s*(?<data>.+)$/u;

const minutes = (ms: number) => `${Math.round(ms / 6000) / 10} minutes`;

/** An answer that does not stream, from its one JSON body. */
const readJsonAnswer = async (response: Response): Promise<ModelAnswer> => {
  // SAFETY: Workers AI's Chat Completions endpoint answers with a chat completion object, and
  // every field of `Choice` is optional, so a missing one reads as no text and no reason.
  const completion = (await response.json()) as { choices?: Choice[] };
  const choice = completion.choices?.[0];

  return {
    finish: choice?.finish_reason ?? undefined,
    message: choice?.message ?? {},
  };
};

/** Adds a chunk's piece of a tool call to the call it belongs to, made on its first piece. */
const addToolCallDelta = (calls: ToolCall[], part: ToolCallDelta): void => {
  const call = calls[part.index] ?? {
    function: { arguments: "", name: "" },
    id: "",
    type: "function",
  };

  calls[part.index] = call;
  call.id = part.id ?? call.id;
  call.function.name = part.function?.name ?? call.function.name;
  call.function.arguments += part.function?.arguments ?? "";
};

/** Adds one line of the event stream to the answer so far; only `data:` lines carry a chunk. */
const addEventLine = (answer: StreamedAnswer, line: string): void => {
  const data = SSE_DATA.exec(line.trim())?.groups?.data;

  if (!data || data === "[DONE]") {
    return;
  }

  // SAFETY: every `data:` line but `[DONE]` is one chat completion chunk or an error, as JSON,
  // and every field read from it is optional.
  const event = JSON.parse(data) as { choices?: Choice[]; error?: unknown };

  if (event.error) {
    throw new Error(`failed mid-answer: ${JSON.stringify(event.error)}`);
  }

  const choice = event.choices?.[0];
  answer.finish = choice?.finish_reason ?? answer.finish;
  answer.content += choice?.delta?.content ?? "";

  for (const part of choice?.delta?.tool_calls ?? []) {
    addToolCallDelta(answer.calls, part);
  }
};

/** A streamed answer, added up from its server-sent events, calling `heard` on every chunk. */
const readStreamedAnswer = async (
  body: NonNullable<Response["body"]>,
  heard: () => void
): Promise<ModelAnswer> => {
  const answer: StreamedAnswer = { calls: [], content: "" };
  let rest = "";

  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    heard();
    const lines = (rest + text).split("\n");
    rest = lines.pop() ?? "";

    for (const line of lines) {
      addEventLine(answer, line);
    }
  }

  addEventLine(answer, rest);

  return {
    finish: answer.finish,
    message: {
      content: answer.content,
      tool_calls: answer.calls.length ? answer.calls : undefined,
    },
  };
};

/**
 * A Chat Completions answer's message and finish reason: added up from its server-sent events,
 * calling `heard` on every chunk, or read from one JSON body when the answer does not stream.
 */
const readAnswer = (
  response: Response,
  heard: () => void
): Promise<ModelAnswer> => {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return readJsonAnswer(response);
  }

  if (!response.body) {
    throw new Error("streamed an answer without a body");
  }

  return readStreamedAnswer(response.body, heard);
};

/** The model's message (text or tool calls) from Workers AI's Chat Completions endpoint. */
export const workersAiMessage = async (
  env: Env,
  fetchImpl: Fetch,
  body: ChatRequest,
  { quietMs, answerMs }: AiLimits = AI_LIMITS,
  retryMs = 5000
): Promise<ModelMessage> => {
  const { url, headers } = workersAiRequest(env);
  const controller = new AbortController();
  const stop = (why: string) => controller.abort(new Error(why));

  const deadline = setTimeout(
    () => stop(`gave no answer within ${minutes(answerMs)}`),
    answerMs
  );

  let quiet: ReturnType<typeof setTimeout> | undefined;

  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(
      () => stop(`sent nothing for ${minutes(quietMs)}`),
      quietMs
    );
  };

  // A busy (429) or failing (5xx) Workers AI is asked twice more, `retryMs` and then twice that later.
  const post = async (attempt: number): Promise<Response> => {
    heard();

    const response = await fetchImpl(url, {
      body: JSON.stringify({ ...body, stream: true }),
      headers,
      method: "POST",
      signal: controller.signal,
    });

    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await response.body?.cancel();
      await sleep(retryMs * (attempt + 1), undefined, {
        signal: controller.signal,
      });

      return post(attempt + 1);
    }

    return response;
  };

  try {
    const response = await post(0);

    if (!response.ok) {
      const text = await response.text();

      throw new Error(
        `returned HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }

    const { message, finish } = await readAnswer(response, heard);

    if (!message.content && !message.tool_calls?.length) {
      throw new Error(
        finish === "length"
          ? "used up max_tokens before it answered (finish_reason length)"
          : `returned no text (finish_reason ${finish ?? "none"})`
      );
    }

    return message;
  } catch (error) {
    // An aborted fetch or stream may reject with its own AbortError instead of the reason.
    const why = controller.signal.aborted ? controller.signal.reason : error;

    throw new Error(
      `Workers AI ${body.model} ${why instanceof Error ? why.message : String(why)}`,
      { cause: error }
    );
  } finally {
    clearTimeout(deadline);
    clearTimeout(quiet);
  }
};
