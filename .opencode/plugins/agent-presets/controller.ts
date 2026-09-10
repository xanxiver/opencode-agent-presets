import { Model, type Plugin } from "@opencode-ai/plugin/effect";
import { Session } from "@opencode-ai/schema/session";
import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode-ai/client";
import type { Registration } from "@opencode-ai/plugin/effect/registration";
import { Cause, Effect, Exit, Schema, Scope, Semaphore } from "effect";
import {
  Active,
  modelLabel,
  ModelSelection,
  OperationError,
  PresetError,
} from "./data.ts";
import type { Preset } from "./data.ts";
import type { ApplyInput } from "./rpc.ts";

export type PresetContext = {
  location: Pick<Plugin.Context["location"], "directory" | "workspaceID">;
  storage: Pick<Plugin.Context["storage"], "get" | "set">;
  agent: Pick<Plugin.Context["agent"], "list" | "transform" | "reload">;
  catalog: {
    model: Pick<Plugin.Context["catalog"]["model"], "list" | "default">;
  };
  session: Pick<Plugin.Context["session"], "get" | "switchModel">;
};

type AvailableModel = Pick<ModelInfo, "providerID" | "id" | "enabled"> & {
  readonly variants: readonly { readonly id: string }[];
};
type AvailableAgent = Pick<AgentInfo, "id" | "model">;

const operation = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new OperationError({ operation: name, cause })),
  );

function validateMappings(
  preset: Preset | null,
  agents: readonly AvailableAgent[],
  models: readonly AvailableModel[],
) {
  return Effect.gen(function* () {
    const skipped: string[] = [];
    for (const mapping of preset?.mappings ?? []) {
      if (!agents.some((agent) => agent.id === mapping.agentID)) {
        skipped.push(mapping.agentID);
        continue;
      }
      const selected = mapping.model;
      const model = models.find(
        (item) =>
          item.providerID === selected.providerID && item.id === selected.id,
      );
      if (
        !model?.enabled ||
        (selected.variant &&
          !model.variants.some((variant) => variant.id === selected.variant))
      ) {
        return yield* new PresetError({
          code: "unavailable",
          message: `The model or variant is unavailable for ${mapping.agentID}: ${modelLabel(selected)}.`,
        });
      }
    }
    return skipped;
  });
}

export const createPresetController = Effect.fn("presets.create")(function* (
  context: PresetContext,
) {
  const mutex = yield* Semaphore.make(1);
  const scope = yield* Scope.Scope;
  const storageKey = `active/v1/${encodeURIComponent(context.location.workspaceID ?? "")}/${encodeURIComponent(context.location.directory)}`;
  const stored = yield* operation(
    "read-active-preset",
    context.storage.get(storageKey),
  );
  let active: Preset | null = null;
  if (stored !== undefined) {
    const decoded = yield* Schema.decodeUnknownEffect(Active)(stored).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(
              "Ignoring an invalid stored active preset.",
              cause,
            ).pipe(Effect.map(() => ({ preset: null }))),
      ),
    );
    active = decoded.preset;
  }

  const defaults = new Map<string, ModelSelection>();
  let registration: Registration | undefined;
  const register = () =>
    operation(
      "register-agent-mappings",
      context.agent
        .transform((editor) => {
          defaults.clear();
          for (const agent of editor.list()) {
            if (agent.model) defaults.set(agent.id, { ...agent.model });
          }
          for (const mapping of active?.mappings ?? []) {
            if (!editor.get(mapping.agentID)) continue;
            editor.update(mapping.agentID, (agent) => {
              agent.model = Schema.decodeUnknownSync(Model.Ref)(mapping.model);
            });
          }
        })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );

  const refresh = Effect.gen(function* () {
    // OpenCode loads agent configuration after package plugins. Register after that configuration to apply preset preferences.
    const previous = registration;
    registration = undefined;
    if (previous) yield* previous.dispose;
    registration = yield* register();
  });

  const persist = (preset: Preset | null) =>
    operation(
      "save-active-preset",
      context.storage.set(storageKey, { version: 1, preset }),
    );
  const reload = () =>
    operation("reload-agent-mappings", context.agent.reload());

  const sessionModels = Effect.fn("presets.session-models")(function* (
    session: Pick<SessionInfo, "agent" | "model">,
    preset: Preset | null,
    agents: readonly AvailableAgent[],
  ) {
    const agentID = session.agent;
    if (!agentID) return;
    let next =
      preset?.mappings.find((mapping) => mapping.agentID === agentID)?.model ??
      defaults.get(agentID);
    let previous =
      session.model ?? agents.find((agent) => agent.id === agentID)?.model;
    if (!next || !previous) {
      const fallback = yield* operation(
        "read-default-model",
        context.catalog.model.default(),
      );
      if (fallback.data) {
        const model = {
          providerID: fallback.data.providerID,
          id: fallback.data.id,
        };
        next ??= model;
        previous ??= model;
      }
    }
    if (!next || !previous) {
      return yield* new PresetError({
        code: "unavailable",
        message: "The current agent has no available default model.",
      });
    }
    return { next, previous, agentID };
  });

  const apply = Effect.fn("presets.apply")(
    function* (input: ApplyInput) {
      if (!registration) yield* refresh;
      const previous = active;
      const agents = yield* operation("list-agents", context.agent.list());
      const models = yield* operation(
        "list-models",
        context.catalog.model.list(),
      );
      const skipped = yield* validateMappings(
        input.preset,
        agents.data,
        models.data,
      );
      const sessionID = input.sessionID;
      const session = sessionID
        ? yield* operation(
            "read-session",
            context.session.get({
              sessionID: Schema.decodeUnknownSync(Session.ID)(sessionID),
            }),
          )
        : undefined;
      if (
        session &&
        (session.location.directory !== context.location.directory ||
          session.location.workspaceID !== context.location.workspaceID)
      ) {
        return yield* new PresetError({
          code: "location",
          message: "The session belongs to another location.",
        });
      }

      const selection = session
        ? yield* sessionModels(session, input.preset, agents.data)
        : undefined;
      if (selection) {
        yield* validateMappings(
          {
            name: "current",
            mappings: [{ agentID: selection.agentID, model: selection.next }],
          },
          agents.data,
          models.data,
        );
      }

      let sessionTouched = false;
      const commit = Effect.gen(function* () {
        active = input.preset;
        yield* reload();
        if (session && selection) {
          sessionTouched = true;
          yield* operation(
            "switch-session-model",
            context.session.switchModel({
              sessionID: session.id,
              model: Schema.decodeUnknownSync(Model.Ref)(selection.next),
            }),
          );
        }
        yield* persist(active);
        return { preset: active, skipped, sessionUpdated: sessionTouched };
      });

      return yield* commit.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("Preset activation failed.", cause);
            active = previous;
            const restore = [reload(), persist(previous)];
            if (session && sessionTouched && selection) {
              restore.push(
                operation(
                  "restore-session-model",
                  context.session.switchModel({
                    sessionID: session.id,
                    model: Schema.decodeUnknownSync(Model.Ref)(
                      selection.previous,
                    ),
                  }),
                ),
              );
            }
            const results = yield* Effect.forEach(restore, Effect.exit);
            const failures = results.filter(Exit.isFailure);
            for (const failure of failures)
              yield* Effect.logError(
                "Preset restoration failed.",
                failure.cause,
              );
            return yield* new PresetError(
              failures.length > 0
                ? {
                    code: "partial",
                    message:
                      "Preset activation failed. Restoration also failed. Check agent and session models before continuing.",
                  }
                : {
                    code: "apply",
                    message:
                      "Preset activation failed. The plugin restored the previous mappings.",
                  },
            );
          }),
        ),
      );
    },
    Effect.uninterruptible,
    mutex.withPermit,
  );

  return {
    apply,
    refresh: mutex.withPermit(refresh),
    status: () =>
      mutex.withPermit(
        Effect.suspend(() =>
          registration
            ? Effect.succeed({ preset: active })
            : refresh.pipe(Effect.map(() => ({ preset: active }))),
        ),
      ),
    dispose: () => Effect.suspend(() => registration?.dispose ?? Effect.void),
  };
});
