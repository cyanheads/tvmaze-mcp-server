/**
 * @fileoverview Typed accessor for the dual-surface error envelope
 * `runToolContract` builds on failure. `CallToolResult['structuredContent']`
 * is typed as an opaque unknown-ish shape upstream, so every error-path
 * assertion needs a narrowing cast — centralized here instead of repeated
 * per test file.
 * @module tests/helpers/error-envelope
 */

/** The `structuredContent.error` shape `classifyAndBuildToolErrorResult` builds. */
export interface ToolErrorEnvelope {
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

/** Narrows a `CallToolResult`'s `structuredContent` to the error envelope shape. */
export function errorEnvelope(structuredContent: unknown): ToolErrorEnvelope {
  return (structuredContent ?? {}) as ToolErrorEnvelope;
}
