/**
 * Codex app-server connection layers — hand-written.
 *
 * `codex app-server` speaks JSON-RPC over stdio as newline-delimited JSON,
 * WITHOUT the `"jsonrpc": "2.0"` member, so every connection here runs the
 * peer with `omitVersion: true`. Inbound requests (approvals, user input,
 * dynamic tool calls, …) are answered by the typed handlers passed in —
 * build them with `Codex.handlers({ ... })`; a request with no handler is
 * answered `MethodNotFound`.
 */
import * as JsonRpc from "@distilled.cloud/core/jsonrpc";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { CodexConnection } from "./protocol.ts";

/** Typed inbound handlers, as returned by `Codex.handlers({ ... })`. */
export type CodexHandlers<R = never> = Effect.Effect<JsonRpc.PeerHandlers, never, R>;

/** Peer options for a Codex connection: the bound handlers plus `omitVersion`. */
const peerOptions = <R>(
  handlers: CodexHandlers<R> | undefined,
): Effect.Effect<JsonRpc.PeerOptions, never, R> =>
  handlers === undefined
    ? Effect.succeed({ omitVersion: true })
    : Effect.map(handlers, (h): JsonRpc.PeerOptions => ({ ...h, omitVersion: true }));

export interface ChildProcessOptions<R = never> {
  /** The executable to spawn. @default "codex" */
  readonly command?: string;
  /** Arguments. @default ["app-server"] */
  readonly args?: ReadonlyArray<string>;
  /** Working directory of the app-server process. */
  readonly cwd?: string;
  /** Extra environment variables (merged over the parent's environment). */
  readonly env?: Record<string, string | undefined>;
  /** Typed inbound handlers (`Codex.handlers({ ... })`). */
  readonly handlers?: CodexHandlers<R>;
}

/**
 * Spawn `codex app-server` and connect to it over stdio. The process lives
 * as long as the layer's scope.
 *
 * @example
 * ```ts
 * const Live = Codex.layerChildProcess({
 *   handlers: Codex.handlers({
 *     itemCommandExecutionRequestApproval: () => Effect.succeed({ decision: "decline" }),
 *   }),
 * }).pipe(Layer.provide(NodeServices.layer));
 * ```
 */
export const layerChildProcess = <R = never>(
  options: ChildProcessOptions<R> = {},
): Layer.Layer<CodexConnection, JsonRpc.JsonRpcTransportError, ChildProcessSpawner | R> =>
  JsonRpc.layer(
    CodexConnection,
    JsonRpc.childProcess({
      command: options.command ?? "codex",
      args: options.args ?? ["app-server"],
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    }),
    peerOptions(options.handlers),
  );

/**
 * Connect over an existing transport — e.g. one end of
 * `JsonRpc.memoryPair` in tests, or a custom socket transport.
 */
export const layerTransport = <R = never>(
  transport: JsonRpc.Transport,
  handlers?: CodexHandlers<R>,
): Layer.Layer<CodexConnection, never, R> =>
  JsonRpc.layer(CodexConnection, Effect.succeed(transport), peerOptions(handlers));
