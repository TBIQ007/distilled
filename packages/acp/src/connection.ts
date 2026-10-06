/**
 * Layers that open an ACP connection and provide {@link AcpConnection}.
 *
 * An ACP agent is a subprocess (`opencode acp`, `gemini --experimental-acp`,
 * `claude-code-acp`, …) speaking newline-delimited JSON-RPC on its stdio.
 * {@link layerChildProcess} spawns it in the layer's scope — closing the
 * scope ends the connection and the process. Inbound methods (the agent
 * calling the client: permission prompts, file system, terminals,
 * elicitation) are answered by the typed `handlers` you pass; a request with
 * no handler is answered `MethodNotFound`, so advertise in `initialize`'s
 * `clientCapabilities` only what you implement.
 */
import * as JsonRpc from "@distilled.cloud/core/jsonrpc";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { AcpConnection } from "./protocol.ts";
import { handlers as bindHandlers, type InboundHandlers } from "./services/acp.ts";

export interface ChildProcessOptions<R = never> {
  /** The agent executable, e.g. `"opencode"`. */
  readonly command: string;
  /** Arguments that put it in ACP mode, e.g. `["acp"]`. */
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Extra environment; merged over the parent's unless `extendEnv: false`. */
  readonly env?: Record<string, string | undefined>;
  /** Inherit the parent's environment (default true). */
  readonly extendEnv?: boolean;
  /** Typed implementations of the methods the agent calls on the client. */
  readonly handlers?: InboundHandlers<R>;
}

const peerOptions = <R>(handlers: InboundHandlers<R> | undefined) =>
  handlers ? bindHandlers(handlers) : Effect.succeed<JsonRpc.PeerHandlers>({});

/**
 * Spawn an ACP agent and connect to it over its stdio. Requires a
 * `ChildProcessSpawner` (e.g. `NodeServices.layer` from
 * `@effect/platform-node`).
 *
 * @example
 * ```ts
 * const Agent = Acp.layerChildProcess({
 *   command: "opencode",
 *   args: ["acp"],
 *   handlers: {
 *     sessionRequestPermission: ({ options }) =>
 *       Effect.succeed({ outcome: { outcome: "selected", optionId: options[0]!.optionId } }),
 *   },
 * }).pipe(Layer.provide(NodeServices.layer));
 * ```
 */
export const layerChildProcess = <R = never>(
  options: ChildProcessOptions<R>,
): Layer.Layer<AcpConnection, JsonRpc.JsonRpcTransportError, ChildProcessSpawner | R> =>
  JsonRpc.layer(
    AcpConnection,
    JsonRpc.childProcess({
      command: options.command,
      ...(options.args ? { args: options.args } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.extendEnv !== undefined ? { extendEnv: options.extendEnv } : {}),
    }),
    peerOptions(options.handlers),
  );

/**
 * Connect over an already-open transport — e.g. one end of
 * `JsonRpc.memoryPair` in tests, or a custom socket transport.
 */
export const layerTransport = <R = never>(
  transport: JsonRpc.Transport,
  handlers?: InboundHandlers<R>,
): Layer.Layer<AcpConnection, never, R> =>
  JsonRpc.layer(AcpConnection, Effect.succeed(transport), peerOptions(handlers));
