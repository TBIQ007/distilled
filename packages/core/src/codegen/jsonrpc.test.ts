import { describe, expect, test } from "vitest";
import { generateService, type SdkSpec } from "./generator.ts";
import {
  convertJsonSchemaRpcToSmithy,
  JSONRPC_INBOUND_TRAIT,
  JSONRPC_METHOD_TRAIT,
  JSONRPC_NOTIFICATION_TRAIT,
  JSONRPC_SERVICE_TRAIT,
  jsonRpcEmission,
  methodToOperationName,
} from "./jsonrpc.ts";

const ns = "com.example.agent";

/** A miniature ACP: JSON Schema definitions using `#/$defs` refs. */
const definitions = {
  SessionId: { type: "string" },
  PromptRequest: {
    type: "object",
    required: ["sessionId", "prompt"],
    properties: {
      sessionId: { $ref: "#/$defs/SessionId" },
      prompt: { type: "array", items: { $ref: "#/$defs/ContentBlock" } },
    },
  },
  ContentBlock: {
    type: "object",
    required: ["type", "text"],
    properties: { type: { type: "string" }, text: { type: "string" } },
  },
  PromptResponse: {
    type: "object",
    required: ["stopReason"],
    properties: { stopReason: { type: "string", enum: ["end_turn", "cancelled"] } },
  },
  CancelNotification: {
    type: "object",
    required: ["sessionId"],
    properties: { sessionId: { $ref: "#/$defs/SessionId" } },
  },
  ReadTextFileRequest: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
  },
  ReadTextFileResponse: {
    type: "object",
    required: ["content"],
    properties: { content: { type: "string" } },
  },
  SessionNotification: {
    type: "object",
    required: ["sessionId", "update"],
    properties: { sessionId: { $ref: "#/$defs/SessionId" }, update: { type: "object" } },
  },
};

const model = () =>
  convertJsonSchemaRpcToSmithy({
    namespace: ns,
    serviceName: "Agent",
    definitions,
    methods: [
      {
        method: "session/prompt",
        direction: "outbound",
        kind: "request",
        params: "PromptRequest",
        result: "PromptResponse",
      },
      {
        method: "session/cancel",
        direction: "outbound",
        kind: "notification",
        params: "CancelNotification",
      },
      {
        method: "fs/read_text_file",
        direction: "inbound",
        kind: "request",
        params: "ReadTextFileRequest",
        result: "ReadTextFileResponse",
      },
      {
        method: "session/update",
        direction: "inbound",
        kind: "notification",
        params: "SessionNotification",
      },
    ],
  });

describe("json-schema-rpc dialect", () => {
  test("method names become PascalCase operation names", () => {
    expect(methodToOperationName("session/request_permission")).toBe("SessionRequestPermission");
    expect(methodToOperationName("$/cancel_request")).toBe("CancelRequest");
    expect(methodToOperationName("thread/start")).toBe("ThreadStart");
  });

  test("operations carry JSON-RPC traits instead of an HTTP binding", () => {
    const { shapes } = model();
    const prompt = shapes[`${ns}#SessionPrompt`];
    expect(prompt.traits[JSONRPC_METHOD_TRAIT]).toBe("session/prompt");
    expect(prompt.traits["smithy.api#http"]).toBeUndefined();
    expect(prompt.traits[JSONRPC_NOTIFICATION_TRAIT]).toBeUndefined();
    expect(shapes[`${ns}#SessionCancel`].traits[JSONRPC_NOTIFICATION_TRAIT]).toEqual({});
    expect(shapes[`${ns}#FsReadTextFile`].traits[JSONRPC_INBOUND_TRAIT]).toEqual({});
    expect(shapes[`${ns}#Agent`].traits[JSONRPC_SERVICE_TRAIT]).toEqual({ params: "named" });
  });

  test("params flatten into the input; results reuse named definitions", () => {
    const { shapes } = model();
    const prompt = shapes[`${ns}#SessionPrompt`];
    const input = shapes[prompt.input.target];
    expect(Object.keys(input.members).sort()).toEqual(["prompt", "sessionId"]);
    expect(prompt.output.target).toBe(`${ns}#PromptResponse`);
    expect(shapes[`${ns}#SessionCancel`].output.target).toBe("smithy.api#Unit");
  });

  test("unknown definitions and name collisions are rejected", () => {
    expect(() =>
      convertJsonSchemaRpcToSmithy({
        namespace: ns,
        serviceName: "Agent",
        definitions,
        methods: [{ method: "x/y", direction: "outbound", kind: "request", params: "Nope" }],
      }),
    ).toThrow(/unknown definition Nope/);
    expect(() =>
      convertJsonSchemaRpcToSmithy({
        namespace: ns,
        serviceName: "Agent",
        definitions,
        methods: [
          { method: "a/b", direction: "outbound", kind: "notification" },
          { method: "a_b", direction: "inbound", kind: "notification" },
        ],
      }),
    ).toThrow(/used by both a\/b and a_b/);
  });
});

describe("JSON-RPC emission", () => {
  const generate = () => {
    const spec: SdkSpec = {
      unionStyle: "opaque-cases",
      ...jsonRpcEmission({
        protocol: "AgentProtocol",
        connection: "AgentConnection",
        commonErrorType: "AgentOpError",
        commonErrorClasses: ["UnknownAgentError"],
      }),
    };
    return generateService(model(), spec).code;
  };

  test("outbound requests and notifications become JsonRpc callables", () => {
    const code = generate();
    expect(code).toMatch(
      /export const sessionPrompt: JsonRpc\.RequestMethod<\s*SessionPromptRequest,\s*PromptResponse,\s*SessionPromptError,\s*AgentConnection\s*> = \/\*@__PURE__\*\/ JsonRpc\.request\(|export const sessionPrompt: JsonRpc\.RequestMethod<SessionPromptRequest, PromptResponse, SessionPromptError, AgentConnection> = JsonRpc\.request\(/,
    );
    expect(code).toContain(`method: "session/prompt"`);
    expect(code).toContain(`errors: [UnknownAgentError]`);
    expect(code).toMatch(
      /export const sessionCancel: JsonRpc\.RequestMethod<SessionCancelRequest, void, JsonRpc\.JsonRpcTransportError, AgentConnection>/,
    );
  });

  test("inbound notifications become streams; inbound methods land in the handler table", () => {
    const code = generate();
    expect(code).toContain(
      `export const sessionUpdate: Stream.Stream<SessionUpdateRequest, never, AgentConnection> = JsonRpc.notifications(`,
    );
    expect(code).not.toMatch(/export const fsReadTextFile/);
    expect(code).toContain(
      `  fsReadTextFile: { method: "fs/read_text_file", kind: "request", params: FsReadTextFileRequest, result: ReadTextFileResponse },`,
    );
    expect(code).toContain(
      `  readonly fsReadTextFile?: (params: FsReadTextFileRequest) => Effect.Effect<ReadTextFileResponse, JsonRpc.HandlerError, R>;`,
    );
    expect(code).toContain(
      `  readonly sessionUpdate?: (params: SessionUpdateRequest) => Effect.Effect<void, never, R>;`,
    );
    expect(code).toContain(`export const handlers = <R = never>(impl: InboundHandlers<R>)`);
    expect(code).toContain(`import * as JsonRpc from "@distilled.cloud/core/jsonrpc";`);
  });
});
