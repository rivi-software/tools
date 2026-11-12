import { describe, expect, it } from "vitest";

import type { Env } from "./common.ts";
import { workersAiMessage, workersAiRequest } from "./workers-ai.ts";

const ENV: Env = {
  CLOUDFLARE_ACCOUNT_ID: "acc",
  CLOUDFLARE_AI_API_TOKEN: "cf",
};

const REQUEST = {
  messages: [{ content: "Review this.", role: "user" as const }],
  model: "@cf/x/y",
};

const LIMITS = { answerMs: 5000, quietMs: 5000 };

/** A streamed answer: each chunk as one `data:` event, split across reads where it is cut. */
const stream = (parts: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(new TextEncoder().encode(part));
        }

        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );

/** A streamed chunk's delta, as Chat Completions sends one. */
interface Delta {
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    function: { name?: string; arguments: string };
  }[];
}

const chunk = (delta: Delta, finish?: string) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`;

/** An answer to one call, with no wait before a retry. */
const answering = (response: () => Response) =>
  workersAiMessage(ENV, () => Promise.resolve(response()), REQUEST, LIMITS, 0);

// A stream that sends nothing, and ends in an error when its request is aborted, as fetch's does.
const silent: typeof fetch = (_url, init) =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason)
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    )
  );

describe("a Workers AI request", () => {
  it("goes to the account's Chat Completions with the API token, and no gateway without one", () => {
    expect(workersAiRequest(ENV)).toStrictEqual({
      headers: {
        authorization: "Bearer cf",
        "content-type": "application/json",
      },
      url: "https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions",
    });
  });

  it("goes through the AI Gateway it names, with the gateway's own token when there is one", () => {
    const { headers } = workersAiRequest({
      ...ENV,
      AI_GATEWAY: "github-o-r",
      CLOUDFLARE_AI_GATEWAY_TOKEN: "gw",
      GITHUB_WORKFLOW: "review",
    });

    expect(headers).toStrictEqual({
      authorization: "Bearer cf",
      "cf-aig-authorization": "Bearer gw",
      "cf-aig-collect-log-payload": "false",
      "cf-aig-gateway-id": "github-o-r",
      "cf-aig-metadata": '{"app":"rivi-bot","workflow":"review"}',
      "cf-aig-skip-cache": "true",
      "content-type": "application/json",
    });
  });
});

describe("a Workers AI answer", () => {
  it("adds up a streamed answer's text and tool calls, whatever the reads cut", async () => {
    const events = [
      chunk({ content: "Reading " }),
      chunk({ content: "first." }),
      chunk({
        tool_calls: [
          {
            function: { arguments: '{"pa', name: "read_file" },
            id: "c1",
            index: 0,
          },
        ],
      }),
      chunk({
        tool_calls: [{ function: { arguments: 'th":"a.ts"}' }, index: 0 }],
      }),
      chunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ].join("");

    const message = await workersAiMessage(
      ENV,
      () => Promise.resolve(stream([events.slice(0, 50), events.slice(50)])),
      REQUEST,
      LIMITS
    );

    expect(message).toStrictEqual({
      content: "Reading first.",
      tool_calls: [
        {
          function: { arguments: '{"path":"a.ts"}', name: "read_file" },
          id: "c1",
          type: "function",
        },
      ],
    });
  });

  it("asks for a stream, and asks a busy Workers AI twice more", async () => {
    const statuses = [429, 503];
    const bodies: string[] = [];

    const message = await workersAiMessage(
      ENV,
      (_url, init) => {
        bodies.push(String(init?.body));
        const status = statuses.shift();

        return Promise.resolve(
          status
            ? new Response("busy", { status })
            : stream([chunk({ content: "Done." }, "stop")])
        );
      },
      REQUEST,
      LIMITS,
      0
    );

    expect(message.content).toBe("Done.");
    expect(bodies).toHaveLength(3);
    expect(JSON.parse(bodies[0] ?? "{}")).toStrictEqual({
      ...REQUEST,
      stream: true,
    });
  });

  it("fails with the model's name and what went wrong", async () => {
    await expect(
      answering(() => new Response("no such model", { status: 400 }))
    ).rejects.toThrow("Workers AI @cf/x/y returned HTTP 400: no such model");
    await expect(
      answering(() => stream([chunk({}, "length")]))
    ).rejects.toThrow(/used up max_tokens before it answered/u);
    await expect(
      answering(() =>
        stream([
          chunk({
            tool_calls: [
              {
                function: { arguments: '{"path":"src/', name: "read_file" },
                id: "c1",
                index: 0,
              },
            ],
          }),
          chunk({}, "length"),
        ])
      )
    ).rejects.toThrow(/used up max_tokens partway through its answer/u);
    await expect(
      answering(() =>
        stream([`data: ${JSON.stringify({ error: "overloaded" })}\n\n`])
      )
    ).rejects.toThrow('Workers AI @cf/x/y failed mid-answer: "overloaded"');
  });

  it("gives up on an answer that goes quiet, or runs past its time", async () => {
    await expect(
      workersAiMessage(ENV, silent, REQUEST, { answerMs: 5000, quietMs: 20 })
    ).rejects.toThrow("Workers AI @cf/x/y sent nothing for 0 minutes");
    await expect(
      workersAiMessage(ENV, silent, REQUEST, { answerMs: 20, quietMs: 5000 })
    ).rejects.toThrow("Workers AI @cf/x/y gave no answer within 0 minutes");
  });
});
