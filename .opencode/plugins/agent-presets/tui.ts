import { setupI18n } from "@lingui/core";
import type { AgentInfo, LocationRef, ModelInfo } from "@opencode-ai/client";
import { Plugin } from "@opencode-ai/plugin/tui";
import type {
  Context,
  DialogSelectOption,
  KeymapCommand,
} from "@opencode-ai/plugin/tui/context";
import { Effect, Schema } from "effect";
import {
  attempt,
  Library,
  modelLabel,
  Preset,
  PresetError,
  PresetName,
} from "./data.ts";
import type { Mapping, ModelSelection } from "./data.ts";
import { PresetsRpc } from "./rpc.ts";

const i18n = setupI18n({
  locale: "en",
  messages: {
    en: {
      presets: "Presets",
      switch: "Presets: Switch preset",
      save: "Presets: Save current mappings",
      edit: "Presets: Edit preset",
      delete: "Presets: Delete preset",
      reset: "Presets: Restore configured defaults",
      empty:
        "No presets exist. Use /preset save <name> to save the current mappings.",
      name: "Preset name",
      active: "active",
      mappings: "agent mappings",
      saved: "Preset saved",
      applied: "Preset applied",
      removed: "Preset deleted",
      restored: "Configured defaults restored",
      unavailable: "Unavailable agents",
      primary: "Primary agents",
      subagent: "Subagents",
      all: "Primary agents and subagents",
      hidden: "Hidden agents",
      agent: "Select an agent",
      model: "Select a model",
      variant: "Select a variant",
      defaultModel: "Use configured default",
      defaultVariant: "No explicit variant",
      finish: "Save changes",
      cancel: "Cancel",
      overwrite: "Replace saved preset?",
      replace: "Replace",
      remove: "Delete",
      confirmDelete: "Delete saved preset?",
      failed: "The preset action failed. Check the OpenCode log.",
      help: "Use /preset save, edit, use, delete, or reset. Add a preset name after save, edit, use, or delete.",
    },
  },
});

type Action = "use" | "save" | "edit" | "delete" | "reset";
type Target = { location: LocationRef; sessionID?: string };
export type PresetUiContext = Pick<Context, "storage" | "location"> & {
  ui: Pick<Context["ui"], "dialog" | "toast" | "router">;
  client: Pick<Context["client"], "rpc" | "agent" | "model" | "session">;
  data: Pick<Context["data"], "location" | "session">;
};

const queryLocation = (location: LocationRef) => ({
  directory: location.directory,
  workspace: location.workspaceID,
});
const RpcFailure = Schema.Struct({
  type: Schema.Literal("preset"),
  message: Schema.String,
});

function category(agent: AgentInfo): string {
  return i18n._(agent.hidden ? "hidden" : agent.mode);
}

export function createPresetActions(context: PresetUiContext) {
  const rpc = context.client.rpc(PresetsRpc);
  const [stored, update] = context.storage.store<{
    version: number;
    presets: Preset[];
  }>("library-v1", {
    initial: { version: 1, presets: [] },
  });
  const library = () =>
    Schema.decodeUnknownEffect(Library)(stored).pipe(
      Effect.mapError(
        () =>
          new PresetError({
            code: "storage",
            message:
              "The saved preset library is invalid. Restore its stored data before continuing.",
          }),
      ),
    );
  const toast = (message: string) =>
    context.ui.toast.show({
      title: i18n._("presets"),
      message,
      variant: "success",
    });

  const target = Effect.fn("presets.target")(function* () {
    const route = context.ui.router.current();
    if (route.type === "session") {
      const session = yield* attempt("read-current-session", (signal) =>
        context.client.session.get({ sessionID: route.sessionID }, { signal }),
      );
      return { location: session.location, sessionID: session.id };
    }
    return { location: context.location ?? context.data.location.default() };
  });

  const choose = Effect.fn("presets.choose")(function* (
    name: string | undefined,
    destination: Target,
  ) {
    const current = yield* library();
    if (name) {
      const preset = current.presets.find((item) => item.name === name);
      if (!preset)
        return yield* new PresetError({
          code: "missing",
          message: `The preset does not exist: ${name}.`,
        });
      return preset;
    }
    if (current.presets.length === 0) {
      yield* attempt("show-empty-presets", () =>
        context.ui.dialog.alert({
          title: i18n._("presets"),
          message: i18n._("empty"),
        }),
      );
      return;
    }
    const status = yield* attempt("read-active-preset", (signal) =>
      rpc.status({}, { location: queryLocation(destination.location), signal }),
    );
    const selected = yield* attempt("select-preset", () =>
      context.ui.dialog.select({
        title: i18n._("presets"),
        current: status.preset?.name,
        options: [...current.presets]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((preset) => ({
            title:
              preset.name === status.preset?.name
                ? `${preset.name} (${i18n._("active")})`
                : preset.name,
            value: preset.name,
            description: `${preset.mappings.length} ${i18n._("mappings")}`,
          })),
      }),
    );
    return current.presets.find((preset) => preset.name === selected);
  });

  const write = Effect.fn("presets.write")(function* (
    preset: Preset | null,
    expected: Preset | undefined,
  ) {
    if (!preset && !expected) return;
    yield* attempt("write-preset-library", () =>
      update((draft) => {
        const current = Schema.decodeUnknownSync(Library)(draft);
        const name = preset?.name ?? expected?.name;
        const found = current.presets.find((item) => item.name === name);
        if (JSON.stringify(found) !== JSON.stringify(expected)) {
          throw new PresetError({
            code: "conflict",
            message:
              "Another terminal changed this preset. Open the preset again before saving.",
          });
        }
        draft.presets = current.presets.filter((item) => item.name !== name);
        if (preset) draft.presets.push(preset);
      }),
    );
  });

  const save = Effect.fn("presets.save")(function* (
    name: string | undefined,
    destination: Target,
  ) {
    const entered =
      name ??
      (yield* attempt("enter-preset-name", () =>
        context.ui.dialog.prompt({ title: i18n._("name") }),
      ));
    if (entered === undefined) return;
    const checkedName = yield* Schema.decodeUnknownEffect(PresetName)(
      entered.trim(),
    ).pipe(
      Effect.mapError(
        () =>
          new PresetError({
            code: "name",
            message:
              "Use a preset name with 1 to 80 characters and no control characters.",
          }),
      ),
    );
    const current = yield* library();
    const existing = current.presets.find((item) => item.name === checkedName);
    if (existing) {
      const confirmed = yield* attempt("confirm-preset-replacement", () =>
        context.ui.dialog.confirm({
          title: i18n._("overwrite"),
          message: checkedName,
          label: { confirm: i18n._("replace"), cancel: i18n._("cancel") },
        }),
      );
      if (!confirmed) return;
    }
    const agents = yield* attempt("read-agent-mappings", (signal) =>
      context.client.agent.list(
        { location: queryLocation(destination.location) },
        { signal },
      ),
    );
    let mappings: Mapping[] = agents.data.flatMap((agent) =>
      agent.model ? [{ agentID: agent.id, model: agent.model }] : [],
    );
    const sessionID = destination.sessionID;
    if (sessionID) {
      const session = yield* attempt("read-session-mapping", (signal) =>
        context.client.session.get({ sessionID }, { signal }),
      );
      if (session.agent && session.model) {
        mappings = mappings.filter(
          (mapping) => mapping.agentID !== session.agent,
        );
        mappings.push({ agentID: session.agent, model: session.model });
      }
    }
    const preset = yield* Schema.decodeUnknownEffect(Preset)({
      name: checkedName,
      mappings,
    });
    yield* write(preset, existing);
    toast(`${i18n._("saved")}: ${preset.name}`);
  });

  const selectModel = Effect.fn("presets.select-model")(function* (
    models: readonly ModelInfo[],
    current?: ModelSelection,
  ) {
    const options: DialogSelectOption<ModelInfo | null>[] = [
      { title: i18n._("defaultModel"), value: null },
      ...models
        .filter((model) => model.enabled)
        .map((model) => ({
          title: model.name,
          value: model,
          description: `${model.providerID}/${model.id}`,
          category: model.providerID,
        })),
    ];
    const model = yield* attempt("select-model", () =>
      context.ui.dialog.select({ title: i18n._("model"), options }),
    );
    if (model === undefined || model === null) return model;
    const result: ModelSelection = {
      providerID: model.providerID,
      id: model.id,
    };
    if (model.variants.length === 0) return result;
    const variants: DialogSelectOption<string | null>[] = [
      { title: i18n._("defaultVariant"), value: null },
      ...model.variants.map((variant) => ({
        title: variant.id,
        value: variant.id,
      })),
    ];
    const variant = yield* attempt("select-variant", () =>
      context.ui.dialog.select({
        title: i18n._("variant"),
        options: variants,
        current:
          current?.providerID === model.providerID && current.id === model.id
            ? (current.variant ?? null)
            : null,
      }),
    );
    if (variant === undefined) return;
    return variant === null ? result : { ...result, variant };
  });

  const edit = Effect.fn("presets.edit")(function* (
    name: string | undefined,
    destination: Target,
  ) {
    const preset = yield* choose(name, destination);
    if (!preset) return;
    const location = queryLocation(destination.location);
    const [agents, models] = yield* Effect.all(
      [
        attempt("list-agents", (signal) =>
          context.client.agent.list({ location }, { signal }),
        ),
        attempt("list-models", (signal) =>
          context.client.model.list({ location }, { signal }),
        ),
      ],
      { concurrency: 2 },
    );
    let mappings = [...preset.mappings];
    while (true) {
      const options: DialogSelectOption<string | null>[] = [
        { title: i18n._("finish"), value: null },
        ...agents.data.map((agent) => {
          const mapping = mappings.find((item) => item.agentID === agent.id);
          return {
            title: agent.name,
            value: agent.id,
            category: category(agent),
            description: mapping
              ? modelLabel(mapping.model)
              : i18n._("defaultModel"),
          };
        }),
        ...mappings
          .filter(
            (mapping) =>
              !agents.data.some((agent) => agent.id === mapping.agentID),
          )
          .map((mapping) => ({
            title: mapping.agentID,
            value: mapping.agentID,
            category: i18n._("unavailable"),
            description: modelLabel(mapping.model),
          })),
      ];
      const agentID = yield* attempt("select-agent", () =>
        context.ui.dialog.select({
          title: `${i18n._("edit")}: ${preset.name}`,
          options,
        }),
      );
      if (agentID === undefined) return;
      if (agentID === null) break;
      const current = mappings.find((mapping) => mapping.agentID === agentID);
      const model = yield* selectModel(models.data, current?.model);
      if (model === undefined) continue;
      mappings = mappings.filter((mapping) => mapping.agentID !== agentID);
      if (model) mappings.push({ agentID, model });
    }
    const checked = yield* Schema.decodeUnknownEffect(Preset)({
      name: preset.name,
      mappings,
    });
    yield* write(checked, preset);
    toast(`${i18n._("saved")}: ${preset.name}`);
  });

  const remove = Effect.fn("presets.delete")(function* (
    name: string | undefined,
    destination: Target,
  ) {
    const preset = yield* choose(name, destination);
    if (!preset) return;
    const confirmed = yield* attempt("confirm-preset-deletion", () =>
      context.ui.dialog.confirm({
        title: i18n._("confirmDelete"),
        message: preset.name,
        label: { confirm: i18n._("remove"), cancel: i18n._("cancel") },
      }),
    );
    if (!confirmed) return;
    yield* write(null, preset);
    toast(`${i18n._("removed")}: ${preset.name}`);
  });

  const apply = Effect.fn("presets.activate")(function* (
    preset: Preset | null,
    destination: Target,
  ) {
    const result = yield* attempt("apply-preset", (signal) =>
      rpc.apply(
        { preset, sessionID: destination.sessionID },
        {
          location: queryLocation(destination.location),
          signal,
        },
      ),
    );
    context.data.location.agent.invalidate(destination.location);
    if (destination.sessionID)
      context.data.session.invalidate(destination.sessionID);
    const message = result.preset
      ? `${i18n._("applied")}: ${result.preset.name}`
      : i18n._("restored");
    if (result.skipped.length > 0) {
      context.ui.toast.show({
        title: message,
        message: `${i18n._("unavailable")}: ${result.skipped.join(", ")}`,
        variant: "warning",
      });
    } else toast(message);
  });

  return Effect.fn("presets.command")(function* (
    action: Action,
    name?: string,
  ) {
    const destination = yield* target();
    switch (action) {
      case "save":
        return yield* save(name, destination);
      case "edit":
        return yield* edit(name, destination);
      case "delete":
        return yield* remove(name, destination);
      case "reset":
        return yield* apply(null, destination);
      case "use": {
        const preset = yield* choose(name, destination);
        if (preset) yield* apply(preset, destination);
      }
    }
  });
}

export function presetCommands(
  context: PresetUiContext,
  signal: AbortSignal,
): KeymapCommand[] {
  const execute = createPresetActions(context);
  const [state, update] = context.storage.memory("command", {
    initial: { busy: false },
  });
  const run = (action: Action, name?: string): Promise<void> => {
    if (state.busy) return Promise.resolve();
    update((draft) => {
      draft.busy = true;
    });
    return Effect.runPromise(
      execute(action, name).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Preset command failed.", cause),
        ),
        Effect.catchTag("OperationError", (error) => {
          if (error.cause instanceof PresetError)
            return Effect.fail(error.cause);
          if (Schema.is(RpcFailure)(error.cause))
            return Effect.fail(
              new PresetError({ code: "server", message: error.cause.message }),
            );
          return Effect.fail(
            new PresetError({ code: "operation", message: i18n._("failed") }),
          );
        }),
        Effect.catchTag("PresetError", (error) =>
          Effect.sync(() =>
            context.ui.toast.show({
              title: i18n._("presets"),
              message: error.message,
              variant: "error",
            }),
          ),
        ),
        Effect.catchCause(() =>
          Effect.sync(() =>
            context.ui.toast.show({
              title: i18n._("presets"),
              message: i18n._("failed"),
              variant: "error",
            }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() =>
            update((draft) => {
              draft.busy = false;
            }),
          ),
        ),
      ),
      { signal },
    );
  };

  const dispatch = (input?: string): Promise<void> => {
    const text = (input ?? "")
      .trim()
      .replace(/^\/(?:preset|presets)(?:\s+|$)/u, "");
    if (!text) return run("use");
    const match = /^(use|save|edit|delete|reset)(?:\s+(.+))?$/u.exec(text);
    if (!match || (match[1] === "reset" && match[2])) {
      context.ui.toast.show({
        title: i18n._("presets"),
        message: i18n._("help"),
        variant: "error",
      });
      return Promise.resolve();
    }
    return Schema.decodeUnknownEffect(
      Schema.Literals(["use", "save", "edit", "delete", "reset"]),
    )(match[1]).pipe(
      Effect.flatMap((action) =>
        Effect.promise(() => run(action, match[2]?.trim())),
      ),
      Effect.runPromise,
    );
  };

  return [
    {
      id: "agent-presets.switch",
      title: i18n._("switch"),
      group: i18n._("presets"),
      palette: true,
      slash: { name: "presets" },
      enabled: () => !state.busy,
      run: () => run("use"),
    },
    {
      id: "agent-presets.command",
      slash: { name: "preset", arguments: true },
      title: i18n._("presets"),
      enabled: () => !state.busy,
      run: dispatch,
    },
    ...(["save", "edit", "delete", "reset"] satisfies Action[]).map(
      (action): KeymapCommand => ({
        id: `agent-presets.${action}`,
        title: i18n._(action),
        group: i18n._("presets"),
        palette: true,
        enabled: () => !state.busy,
        run: () => run(action),
      }),
    ),
  ];
}

export default Plugin.define({
  id: "agent-presets",
  setup(context) {
    const controller = new AbortController();
    const commands = presetCommands(context, controller.signal);
    const remove = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({ mode: "global", commands }));
        return null;
      },
    });
    return () => {
      controller.abort();
      remove();
    };
  },
});
