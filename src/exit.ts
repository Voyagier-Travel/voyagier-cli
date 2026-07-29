import { flushTelemetry } from "./telemetry.js";

/**
 * Terminate the process cleanly (VOY-1765).
 *
 * Drains in-flight telemetry sends (capped at 250ms) before calling
 * process.exit, so we never hard-exit while a libuv async handle from a
 * fire-and-forget telemetry fetch is still live — that teardown race trips an
 * assertion on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`,
 * src\win\async.c:76).
 *
 * Exit-code semantics and control flow are preserved: this still terminates
 * the process with `code`, so it is a drop-in for call sites that use
 * process.exit as control flow (unlike `process.exitCode =`, which would let
 * execution continue).
 */
export async function gracefulExit(code: number): Promise<never> {
  // Set exitCode up-front: if the event loop drains during the flush await
  // (unref'd cap timer; a pending send that holds no live handles), Node exits
  // naturally — this keeps the exit code deterministic in that edge case.
  process.exitCode = code;
  await flushTelemetry(250);
  process.exit(code);
}
