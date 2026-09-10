import { Plugin } from "@opencode-ai/plugin/effect";
import { Cause, Effect, Stream } from "effect";
import { PresetsRpc } from "./rpc.ts";
import { createPresetController } from "./controller.ts";

export default Plugin.define({
  id: "agent-presets",
  effect: (context) =>
    Effect.gen(function* () {
      const controller = yield* createPresetController(context);
      yield* context.event.subscribe().pipe(
        Stream.filter(
          (event) =>
            event.type === "plugin.updated" &&
            event.location?.directory === context.location.directory &&
            event.location.workspaceID === context.location.workspaceID,
        ),
        Stream.runForEach(() =>
          controller.refresh.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.logError("Preset refresh failed.", cause),
            ),
          ),
        ),
        Effect.tapCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logError("Preset event stream failed.", cause),
        ),
        Effect.orDie,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* context.rpc.register(PresetsRpc, {
        status: (_input, call) =>
          controller.status().pipe(
            Effect.tapCause((cause) =>
              Effect.logError("Preset status failed.", cause),
            ),
            Effect.catchTag("OperationError", () =>
              Effect.fail(
                call.error(
                  "preset",
                  "The plugin could not read the preset status.",
                  { code: "operation" },
                ),
              ),
            ),
          ),
        apply: (input, call) =>
          controller.apply(input).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("Preset request failed.", cause);
                return yield* Effect.failCause(cause);
              }),
            ),
            Effect.catchTag("PresetError", (error) =>
              Effect.fail(
                call.error("preset", error.message, { code: error.code }),
              ),
            ),
            Effect.catchTag("OperationError", () =>
              Effect.fail(
                call.error(
                  "preset",
                  "The plugin could not apply the preset. Check the OpenCode log.",
                  { code: "operation" },
                ),
              ),
            ),
          ),
      });
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("Preset plugin setup failed.", cause),
      ),
      Effect.orDie,
    ),
});
