# @distilled.cloud/codex

Effect-native SDK for the [OpenAI Codex](https://github.com/openai/codex) app-server
protocol — JSON-RPC over stdio (`codex app-server`), generated from the JSON Schemas
Codex publishes under
[`codex-rs/app-server-protocol/schema/json`](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/json).

- **105 requests** you send (`Codex.initialize`, `Codex.threadStart`, `Codex.turnStart`, …)
- **84 server notifications** as decoded streams (`Codex.itemAgentMessageDelta`, `Codex.turnCompleted`, …)
- **10 server→client requests** (approvals, user input, dynamic tool calls) answered by typed handlers

## Installation

```bash
npm install @distilled.cloud/codex effect @effect/platform-node
```

The app-server is the `codex` CLI (`npm install -g @openai/codex`).

## Quick start

```ts
import * as Codex from "@distilled.cloud/codex";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Stream } from "effect";

const program = Effect.gen(function* () {
  yield* Codex.initialize({ clientInfo: { name: "my-app", version: "1.0.0" } });
  yield* Codex.initialized();

  // Follow the agent's reply (until the turn completes) before starting the turn.
  const reply = yield* Codex.itemAgentMessageDelta.pipe(
    Stream.map((event) => event.delta),
    Stream.interruptWhen(Codex.turnCompleted.pipe(Stream.runHead)),
    Stream.mkString,
    Effect.forkChild({ startImmediately: true }),
  );

  const { thread } = yield* Codex.threadStart({ cwd: process.cwd() });
  yield* Codex.turnStart({
    threadId: thread.id,
    input: [{ type: "text", text: "Summarize this repository in one sentence." }],
  });
  return yield* Fiber.join(reply);
});

// Spawn `codex app-server` and answer its approval requests.
const Live = Codex.layerChildProcess({
  handlers: Codex.handlers({
    itemCommandExecutionRequestApproval: (request) =>
      Effect.succeed({ decision: request.command?.startsWith("git ") ? "accept" : "decline" }),
    itemFileChangeRequestApproval: () => Effect.succeed({ decision: "decline" }),
  }),
}).pipe(Layer.provide(NodeServices.layer));

program.pipe(Effect.provide(Live), Effect.scoped, Effect.runPromise).then(console.log);
```

## Connections

| Layer | Use |
| --- | --- |
| `Codex.layerChildProcess({ command?, args?, cwd?, env?, handlers? })` | Spawns `codex app-server` (defaults: `command: "codex"`, `args: ["app-server"]`) and talks NDJSON over its stdio. Needs a `ChildProcessSpawner` (`NodeServices.layer`). |
| `Codex.layerTransport(transport, handlers?)` | Any `JsonRpc.Transport` — e.g. one end of `JsonRpc.memoryPair` for a fake app-server in tests. |

Codex omits the `"jsonrpc": "2.0"` member, so both layers run the peer with
`omitVersion: true`. Server→client requests with no handler are answered
`MethodNotFound`. Methods without params (`Codex.initialized()`,
`Codex.accountLogout()`, …) take no argument and send no `params` member.

## Errors

Every request fails with `CodexOpError`:

| Error | When |
| --- | --- |
| `CodexServerOverloaded` | `-32001` — the app-server's queue is full; retry with backoff |
| `CodexInvalidRequest` | `-32600` — e.g. "Not initialized", "Already initialized", server draining |
| `CodexMethodNotFound` | `-32601` — the installed `codex` does not know the method |
| `CodexInvalidParams` | `-32602` — params rejected by the app-server |
| `CodexInternalError` | `-32603` |
| `UnknownCodexError` | any other error code (`method`, `code`, `message`, `data`) |
| `CodexParseError` | a result failed its schema (only under `ResponseValidation.strict`) |
| `JsonRpcTransportError` | the app-server exited or the stream closed |

## Regenerating

```sh
pnpm specs:local codex                       # until spec-mirror-codex exists
DISTILLED_SPECS_LOCAL=1 pnpm generate codex
```

`scripts/convert.ts` merges the `definitions` of the four method unions
(`ClientRequest`, `ClientNotification`, `ServerRequest`, `ServerNotification`) and every
`*Response.json`, failing on conflicting duplicates, and resolves each request's result
type (`FooParams` → `FooResponse`, else `<Method>Response`, plus an override table).

### Known gaps

`scripts/generate.ts` post-processes two shapes the generic JSON-RPC emitter does not
yet handle: methods without params get a `void` input (instead of an empty struct that
would send `"params": {}`), and union-typed params (`account/login/start`) are sent as
the union itself instead of under a synthetic `body` key.

## Credits

The request → result mapping (convention + overrides) is ported from T3 Code's
[`effect-codex-app-server`](https://github.com/pingdotgg/t3code) generator
(MIT, © T3 Tools Inc.).
