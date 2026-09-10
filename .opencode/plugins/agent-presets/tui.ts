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

type Action = "use" | "save" | "edit" | "delete" | "reset" | "view";
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
  if (agent.hidden) return "Hidden agents";
  if (agent.mode === "subagent") return "Subagents";
  if (agent.mode === "primary") return "Primary agents";
  return "Primary agents and subagents";
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
      title: "Presets",
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
          title: "Presets",
          message:
            "No presets exist. Use /preset save <name> to save the current mappings.",
        }),
      );
      return;
    }
    const status = yield* attempt("read-active-preset", (signal) =>
      rpc.status({}, { location: queryLocation(destination.location), signal }),
    );
    const selected = yield* attempt("select-preset", () =>
      context.ui.dialog.select({
        title: "Presets",
        current: status.preset?.name,
        options: [...current.presets]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((preset) => ({
            title:
              preset.name === status.preset?.name
                ? `${preset.name} (active)`
                : preset.name,
            value: preset.name,
            description: `${preset.mappings.length} agent mappings`,
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
        context.ui.dialog.prompt({ title: "Preset name" }),
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
          title: "Replace saved preset?",
          message: checkedName,
          label: { confirm: "Replace", cancel: "Cancel" },
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
    toast(`Preset saved: ${preset.name}`);
  });

  const selectModel = Effect.fn("presets.select-model")(function* (
    models: readonly ModelInfo[],
    current?: ModelSelection,
  ) {
    const options: DialogSelectOption<ModelInfo | null>[] = [
      { title: "Use configured default", value: null },
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
      context.ui.dialog.select({ title: "Select a model", options }),
    );
    if (model === undefined || model === null) return model;
    const result: ModelSelection = {
      providerID: model.providerID,
      id: model.id,
    };
    if (model.variants.length === 0) return result;
    const variants: DialogSelectOption<string | null>[] = [
      { title: "No explicit variant", value: null },
      ...model.variants.map((variant) => ({
        title: variant.id,
        value: variant.id,
      })),
    ];
    const variant = yield* attempt("select-variant", () =>
      context.ui.dialog.select({
        title: "Select a variant",
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
        { title: "Save changes", value: null },
        ...agents.data.map((agent) => {
          const mapping = mappings.find((item) => item.agentID === agent.id);
          return {
            title: agent.name,
            value: agent.id,
            category: category(agent),
            description: mapping
              ? modelLabel(mapping.model)
              : "Use configured default",
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
            category: "Unavailable agents",
            description: modelLabel(mapping.model),
          })),
      ];
      const agentID = yield* attempt("select-agent", () =>
        context.ui.dialog.select({
          title: `Edit preset: ${preset.name}`,
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
    toast(`Preset saved: ${preset.name}`);
  });

  const remove = Effect.fn("presets.delete")(function* (
    name: string | undefined,
    destination: Target,
  ) {
    const preset = yield* choose(name, destination);
    if (!preset) return;
    const confirmed = yield* attempt("confirm-preset-deletion", () =>
      context.ui.dialog.confirm({
        title: "Delete saved preset?",
        message: preset.name,
        label: { confirm: "Delete", cancel: "Cancel" },
      }),
    );
    if (!confirmed) return;
    yield* write(null, preset);
    toast(`Preset deleted: ${preset.name}`);
  });

  const view = Effect.fn("presets.view")(function* (
    name: string | undefined,
    destination: Target,
  ) {
    const preset = yield* choose(name, destination);
    if (!preset) return;
    const rows = preset.mappings.map((mapping) => ({
      agent: mapping.agentID,
      model: `${mapping.model.providerID}/${mapping.model.id}`,
      variant: mapping.model.variant ?? "",
    }));
    const agentWidth = Math.max(5, ...rows.map((row) => row.agent.length));
    const modelWidth = Math.max(5, ...rows.map((row) => row.model.length));
    const details =
      rows.length === 0
        ? "This preset has no mappings."
        : [
            `${"agent".padEnd(agentWidth)}  ${"model".padEnd(modelWidth)}  variant`,
            ...rows.map(
              (row) =>
                `${row.agent.padEnd(agentWidth)}  ${row.model.padEnd(modelWidth)}  ${row.variant}`,
            ),
          ].join("\n");
    yield* attempt("view-preset", () =>
      context.ui.dialog.alert({
        title: `Preset: ${preset.name}`,
        message: details,
      }),
    );
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
      ? `Preset applied: ${result.preset.name}`
      : "Configured defaults restored";
    if (result.skipped.length > 0) {
      context.ui.toast.show({
        title: message,
        message: `Unavailable agents: ${result.skipped.join(", ")}`,
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
      case "view":
        return yield* view(name, destination);
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
            new PresetError({
              code: "operation",
              message: "The preset action failed. Check the OpenCode log.",
            }),
          );
        }),
        Effect.catchTag("PresetError", (error) =>
          Effect.sync(() =>
            context.ui.toast.show({
              title: "Presets",
              message: error.message,
              variant: "error",
            }),
          ),
        ),
        Effect.catchCause(() =>
          Effect.sync(() =>
            context.ui.toast.show({
              title: "Presets",
              message: "The preset action failed. Check the OpenCode log.",
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
    const match = /^(use|save|edit|delete|reset|view)(?:\s+(.+))?$/u.exec(text);
    if (!match || (match[1] === "reset" && match[2])) {
      context.ui.toast.show({
        title: "Presets",
        message:
          "Use /preset view, save, edit, use, delete, or reset. Add a preset name after view, save, edit, use, or delete.",
        variant: "error",
      });
      return Promise.resolve();
    }
    return Schema.decodeUnknownEffect(
      Schema.Literals(["use", "save", "edit", "delete", "reset", "view"]),
    )(match[1]).pipe(
      Effect.flatMap((action) =>
        Effect.promise(() => run(action, match[2]?.trim())),
      ),
      Effect.runPromise,
    );
  };

  const palette = [
    { action: "view", title: "View preset" },
    { action: "save", title: "Save current mappings" },
    { action: "edit", title: "Edit preset" },
    { action: "delete", title: "Delete preset" },
    { action: "reset", title: "Restore configured defaults" },
  ] as const;
  return [
    {
      id: "agent-presets.switch",
      title: "Switch preset",
      group: "Presets",
      palette: true,
      slash: { name: "presets" },
      enabled: () => !state.busy,
      run: () => run("use"),
    },
    {
      id: "agent-presets.command",
      slash: { name: "preset", arguments: true },
      title: "Presets",
      enabled: () => !state.busy,
      run: dispatch,
    },
    ...palette.map(
      ({ action, title }): KeymapCommand => ({
        id: `agent-presets.${action}`,
        title,
        group: "Presets",
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
