# @distilled.cloud/acp

Effect-native client SDK for the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP), generated from ACP's published JSON Schema (`schema.json` + `meta.json`
from the latest stable `schema-v1.*` release of
[agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)).

ACP is JSON-RPC 2.0 over newline-delimited JSON on a coding agent's stdio
(`opencode acp`, Gemini CLI, Claude Code via `claude-code-acp`, …). This SDK
is the **client** side: it spawns the agent, calls it, and answers its
callbacks.

## Installation

```bash
npm install @distilled.cloud/acp effect @effect/platform-node
```

## Quick start

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Stream } from "effect";
import * as Acp from "@distilled.cloud/acp";

const program = Effect.gen(function* () {
  yield* Acp.initialize({
    protocolVersion: Acp.ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const { sessionId } = yield* Acp.sessionNew({ cwd: process.cwd(), mcpServers: [] });

  // Print the agent's reply as it streams in.
  yield* Acp.sessionUpdates.pipe(
    Stream.filter((n) => n.sessionId === sessionId),
    Stream.runForEach(({ update }) =>
      Effect.sync(() => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          process.stdout.write(update.content.text);
        }
      }),
    ),
    Effect.forkScoped,
  );

  const { stopReason } = yield* Acp.sessionPrompt({
    sessionId,
    prompt: [{ type: "text", text: "Summarize this repository in one sentence." }],
  });
  return stopReason;
});

const Agent = Acp.layerChildProcess({
  command: "opencode",
  args: ["acp"],
  handlers: {
    // The agent asks before running a tool; pick the first "allow" option.
    sessionRequestPermission: ({ options }) =>
      Effect.succeed({
        outcome: {
          outcome: "selected",
          optionId: (options.find((o) => o.kind === "allow_once") ?? options[0]!).optionId,
        },
      }),
  },
}).pipe(Layer.provide(NodeServices.layer));

program.pipe(Effect.scoped, Effect.provide(Agent), Effect.runPromise);
```

## How it maps

| ACP | SDK |
| --- | --- |
| Client → agent requests (`initialize`, `session/new`, `session/prompt`, …) | `Acp.initialize`, `Acp.sessionNew`, `Acp.sessionPrompt`, … |
| Client → agent notifications (`session/cancel`, `$/cancel_request`) | `Acp.sessionCancel`, `Acp.cancelRequest` |
| Agent → client notifications (`session/update`, …) | `Acp.sessionUpdates` stream (also a handler key) |
| Agent → client requests (`session/request_permission`, `fs/*`, `terminal/*`, `elicitation/create`) | typed `handlers` on the connection layer |

- `Acp.layerChildProcess({ command, args, cwd, env, handlers })` spawns the
  agent in the layer's scope; `Acp.layerTransport(transport, handlers)`
  connects over any `JsonRpc.Transport` (tests use `JsonRpc.memoryPair`).
- An agent request with no handler is answered `MethodNotFound` — advertise
  in `clientCapabilities` only what you implement.
- `Acp.sessionUpdates` delivers notifications from subscription onward; fork
  it before `sessionPrompt`, or pass a `sessionUpdates` handler, which never
  misses one.

## Errors

ACP defines its error codes protocol-wide, so every request can fail with:
`AcpAuthRequired` (-32000), `AcpResourceNotFound` (-32002),
`AcpRequestCancelled` (-32800), `AcpInvalidParams` (-32602),
`AcpMethodNotFound` (-32601), `AcpInternalError` (-32603), `UnknownAcpError`
(any other code), `AcpParseError` (strict response validation), and
`JsonRpcTransportError` (agent exited or stdio closed).

```ts
const newSession = Acp.sessionNew({ cwd, mcpServers: [] });

newSession.pipe(
  Effect.catchTag("AcpAuthRequired", () =>
    Acp.authenticate({ methodId: authMethods[0]!.id }).pipe(Effect.andThen(newSession)),
  ),
);
```

## Scope

ACP v1 only (the stable schema). The `schema-v2.*` releases are alpha and
not generated; neither are the `*.unstable.json` methods.

## Acknowledgements

Protocol semantics were cross-checked against T3 Tools Inc.'s `effect-acp`
(MIT).
