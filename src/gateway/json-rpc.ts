/**
 * JSON-RPC 2.0 types and utilities for the Gateway server.
 * @see https://www.jsonrpc.org/specification
 */

// ── Request / Response / Notification ──────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result: any;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

// ── Standard Error Codes ───────────────────────────────────

export const StandardErrors = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ── Custom Error Codes (-32000 to -32099) ──────────────────

export const CustomErrors = {
  SESSION_NOT_FOUND: -32001,
  MODEL_NOT_FOUND: -32002,
  AGENT_NOT_FOUND: -32003,
  PROCESSING_ERROR: -32004,
  QUESTION_NOT_FOUND: -32005,
  SKILL_NOT_FOUND: -32006,
  KERNEL_NOT_READY: -32007,
} as const;

// ── Helpers ────────────────────────────────────────────────

export function makeSuccessResponse(
  id: string | number | null,
  result: any
): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: any
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function makeNotification(
  method: string,
  params?: Record<string, any>
): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}
