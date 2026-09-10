import { describe, expect, test } from "bun:test";
import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode-ai/client";
import type { AgentEditor } from "@opencode-ai/plugin/effect/agent";
import { Agent, Model } from "@opencode-ai/plugin/effect";
import { Session } from "@opencode-ai/schema/session";
import { Location } from "@opencode-ai/schema/location";
import { Effect, Schema, type Scope } from "effect";
import { Library, Preset, PresetError } from "./plugins/agent-presets/data.ts";
import {
  createPresetController,
  type PresetContext,
} from "./plugins/agent-presets/controller.ts";

const focused: Preset = {
  name: "Focused",
  mappings: [
    {
      agentID: "build",
      model: { providerID: "local", id: "reasoner", variant: "high" },
    },
    {
      agentID: "explore",
      model: { providerID: "local", id: "reasoner", variant: "low" },
    },
  ],
};
const quick: Preset = {
  name: "Quick",
  mappings: [{ agentID: "build", model: { providerID: "local", id: "quick" } }],
};

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

function fixture(
  directory = "/project/a",
  storage = new Map<string, Schema.Json>(),
) {
  const location = Schema.decodeUnknownSync(Location.Info)({
    directory,
    project: { id: "project-test", directory, canonical: directory },
  });
  const configured: AgentInfo[] = [
    {
      id: "build",
      name: "Build",
      mode: "primary",
      hidden: false,
      request: { settings: {}, headers: {}, body: {} },
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
      system: "Keep the existing instructions.",
      model: { providerID: "local", id: "standard", variant: "medium" },
    },
    {
      id: "explore",
      name: "Explore",
      mode: "subagent",
      hidden: false,
      request: { settings: {}, headers: {}, body: {} },
      permissions: [],
      model: { providerID: "local", id: "quick" },
    },
    {
      id: "custom/reviewer",
      name: "Reviewer",
      mode: "subagent",
      hidden: false,
      request: { settings: {}, headers: {}, body: {} },
      permissions: [],
      model: { providerID: "local", id: "standard" },
    },
  ];
  const models: ModelInfo[] = ["standard", "reasoner", "quick"].map((id) => ({
    id,
    modelID: id,
    name: id,
    providerID: "local",
    enabled: true,
    status: "active",
    variants:
      id === "quick" ? [] : [{ id: "low" }, { id: "medium" }, { id: "high" }],
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    time: { released: 0 },
    limit: { context: 1000, output: 100 },
  }));
  let transform: ((editor: AgentEditor) => void) | undefined;
  let current = structuredClone(configured);
  let session: SessionInfo = {
    id: "ses-test",
    projectID: "project-test",
    agent: "build",
    location: { directory },
    model: { providerID: "local", id: "standard", variant: "medium" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  };
  const failures = { switch: 0, write: 0, reload: 0, transform: 0 };
  const switches: string[] = [];
  const reload = () =>
    Effect.sync(() => {
      if (failures.reload-- > 0) throw new Error("Agent reload failed.");
      const drafts: ReturnType<AgentEditor["list"]>[number][] = configured.map(
        (agent) => {
          const decoded = Schema.decodeUnknownSync(Agent.Info)(agent);
          return { ...decoded, permissions: [...decoded.permissions] };
        },
      );
      transform?.({
        list: () => drafts,
        get: (id) => drafts.find((agent) => String(agent.id) === id),
        update: (id, update) => {
          const agent = drafts.find((item) => String(item.id) === id);
          if (agent) update(agent);
        },
        default: () => {},
        remove: () => {},
      });
      current = Schema.decodeUnknownSync(
        Schema.Array(Schema.toEncoded(Agent.Info)),
      )(drafts).map((agent) => ({
        ...agent,
        permissions: [...agent.permissions],
      }));
    });
  const context: PresetContext = {
    location,
    storage: {
      get: (key) => Effect.sync(() => structuredClone(storage.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          storage.set(key, structuredClone(value));
          if (failures.write-- > 0) throw new Error("Storage write failed.");
        }),
    },
    agent: {
      list: () =>
        Effect.sync(() => ({
          location,
          data: current.map((agent) =>
            Schema.decodeUnknownSync(Agent.Info)(agent),
          ),
        })),
      reload,
      transform: (callback) =>
        Effect.gen(function* () {
          if (failures.transform-- > 0)
            throw new Error("Agent transform failed.");
          transform = callback;
          yield* reload();
          return {
            dispose: Effect.suspend(() => {
              if (transform === callback) transform = undefined;
              return reload();
            }),
          };
        }),
    },
    catalog: {
      model: {
        list: () =>
          Effect.sync(() => ({
            location,
            data: models.map((model) =>
              Schema.decodeUnknownSync(Model.Info)(model),
            ),
          })),
        default: () =>
          Effect.sync(() => ({
            location,
            data: Schema.decodeUnknownSync(Model.Info)(models[0]),
          })),
      },
    },
    session: {
      get: () =>
        Effect.sync(() => Schema.decodeUnknownSync(Session.Info)(session)),
      switchModel: (input) =>
        Effect.sync(() => {
          session = { ...session, model: input.model };
          switches.push(input.model.id);
          if (failures.switch-- > 0) throw new Error("Session switch failed.");
        }),
    },
  };
  return {
    context,
    storage,
    configured,
    models,
    failures,
    switches,
    agents: () => current,
    session: () => session,
  };
}

describe("Agent presets", () => {
  test("applies primary and custom subagent mappings and preserves agent instructions", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController(host.context);
        yield* controller.apply({
          preset: {
            ...focused,
            mappings: [
              ...focused.mappings,
              {
                agentID: "custom/reviewer",
                model: { providerID: "local", id: "reasoner", variant: "high" },
              },
            ],
          },
          sessionID: "ses-test",
        });
        expect(host.agents().map((agent) => [agent.id, agent.model])).toEqual([
          ["build", { providerID: "local", id: "reasoner", variant: "high" }],
          ["explore", { providerID: "local", id: "reasoner", variant: "low" }],
          [
            "custom/reviewer",
            { providerID: "local", id: "reasoner", variant: "high" },
          ],
        ]);
        expect(host.agents()[0].system).toBe("Keep the existing instructions.");
        expect(host.agents()[0].permissions).toEqual([
          { action: "read", resource: "*", effect: "allow" },
        ]);
        expect(host.session().agent).toBe("build");
        expect(host.session().model).toEqual({
          providerID: "local",
          id: "reasoner",
          variant: "high",
        });
      }),
    ));

  test("removes old mappings and variants when switching and restores configured defaults", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController(host.context);
        yield* controller.apply({ preset: focused, sessionID: "ses-test" });
        yield* controller.apply({ preset: quick, sessionID: "ses-test" });
        expect(host.session().model).toEqual({
          providerID: "local",
          id: "quick",
        });
        expect(host.agents()[1].model).toEqual({
          providerID: "local",
          id: "quick",
        });
        yield* controller.apply({ preset: null, sessionID: "ses-test" });
        expect(host.session().model).toEqual({
          providerID: "local",
          id: "standard",
          variant: "medium",
        });
        expect((yield* controller.status()).preset).toBeNull();
      }),
    ));

  test("restores the snapshot after reload and keeps locations independent", () =>
    run(
      Effect.gen(function* () {
        const shared = new Map<string, Schema.Json>();
        const first = fixture("/project/a", shared);
        const controller = yield* createPresetController(first.context);
        yield* controller.apply({ preset: focused });
        yield* controller.dispose();
        const restored = fixture("/project/a", shared);
        const other = fixture("/project/b", shared);
        const restart = yield* createPresetController(restored.context);
        yield* restart.refresh;
        const second = yield* createPresetController(other.context);
        expect(restored.agents()[1].model).toEqual({
          providerID: "local",
          id: "reasoner",
          variant: "low",
        });
        expect((yield* second.status()).preset).toBeNull();
        expect(other.agents()[0].model).toEqual({
          providerID: "local",
          id: "standard",
          variant: "medium",
        });
      }),
    ));

  test("retries registration after a transform failure", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController(host.context);
        yield* controller.apply({ preset: focused, sessionID: "ses-test" });
        host.failures.transform = 1;
        yield* Effect.exit(controller.refresh);
        yield* controller.apply({ preset: quick, sessionID: "ses-test" });
        expect(host.agents()[0].model).toEqual({
          providerID: "local",
          id: "quick",
        });
        expect((yield* controller.status()).preset?.name).toBe("Quick");
      }),
    ));

  test("ignores an invalid stored active preset", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const first = yield* createPresetController(host.context);
        yield* first.apply({ preset: focused });
        const key = [...host.storage.keys()][0];
        host.storage.set(key, { version: 2, preset: null });
        const recovered = yield* createPresetController(host.context);
        expect((yield* recovered.status()).preset).toBeNull();
      }),
    ));

  test("rejects unavailable variants before applying any mappings", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController(host.context);
        const failure = yield* Effect.flip(
          controller.apply({
            preset: {
              name: "Invalid",
              mappings: [
                {
                  agentID: "build",
                  model: { providerID: "local", id: "quick", variant: "high" },
                },
              ],
            },
            sessionID: "ses-test",
          }),
        );
        expect(failure).toBeInstanceOf(PresetError);
        expect(host.switches).toEqual([]);
        expect(host.storage.size).toBe(0);
        expect((yield* controller.status()).preset).toBeNull();
      }),
    ));

  test("reports absent agents while applying available mappings", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController(host.context);
        const result = yield* controller.apply({
          preset: {
            ...quick,
            mappings: [
              ...quick.mappings,
              {
                agentID: "other-project-agent",
                model: { providerID: "other", id: "missing" },
              },
            ],
          },
        });
        expect(result.skipped).toEqual(["other-project-agent"]);
        expect(host.agents()[0].model).toEqual({
          providerID: "local",
          id: "quick",
        });
      }),
    ));

  for (const boundary of [
    "switch",
    "write",
    "reload",
  ] satisfies (keyof ReturnType<typeof fixture>["failures"])[]) {
    test(`restores mappings after a ${boundary} failure`, () =>
      run(
        Effect.gen(function* () {
          const host = fixture();
          const controller = yield* createPresetController(host.context);
          yield* controller.apply({ preset: focused, sessionID: "ses-test" });
          host.failures[boundary] = 1;
          yield* Effect.flip(
            controller.apply({ preset: quick, sessionID: "ses-test" }),
          );
          expect((yield* controller.status()).preset?.name).toBe("Focused");
          expect(host.agents()[0].model).toEqual({
            providerID: "local",
            id: "reasoner",
            variant: "high",
          });
          expect(host.session().model).toEqual({
            providerID: "local",
            id: "reasoner",
            variant: "high",
          });
          const reloaded = fixture("/project/a", host.storage);
          const restart = yield* createPresetController(reloaded.context);
          yield* restart.refresh;
          expect(reloaded.agents()[0].model).toEqual({
            providerID: "local",
            id: "reasoner",
            variant: "high",
          });
        }),
      ));
  }

  test("reports incomplete restoration", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController(host.context);
        host.failures.write = 2;
        const error = yield* Effect.flip(
          controller.apply({ preset: focused, sessionID: "ses-test" }),
        );
        expect(error).toMatchObject({ _tag: "PresetError", code: "partial" });
      }),
    ));

  test("serializes concurrent preset activations", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController(host.context);
        yield* Effect.all(
          [
            controller.apply({ preset: focused, sessionID: "ses-test" }),
            controller.apply({ preset: quick, sessionID: "ses-test" }),
          ],
          { concurrency: 2 },
        );
        expect(host.switches).toEqual(["reasoner", "quick"]);
        expect((yield* controller.status()).preset?.name).toBe("Quick");
        expect(host.session().model).toEqual({
          providerID: "local",
          id: "quick",
        });
      }),
    ));

  test("rejects a session from another location", () =>
    run(
      Effect.gen(function* () {
        const host = fixture();
        const controller = yield* createPresetController({
          ...host.context,
          location: Schema.decodeUnknownSync(Location.Ref)({
            directory: "/project/b",
          }),
        });
        const error = yield* Effect.flip(
          controller.apply({ preset: focused, sessionID: "ses-test" }),
        );
        expect(error).toMatchObject({ _tag: "PresetError", code: "location" });
        expect(host.switches).toEqual([]);
      }),
    ));

  test("rejects duplicate mappings and unsupported library versions", () =>
    run(
      Effect.gen(function* () {
        expect(
          Schema.is(Preset)({
            name: "Duplicate",
            mappings: [quick.mappings[0], quick.mappings[0]],
          }),
        ).toBe(false);
        const error = yield* Effect.flip(
          Schema.decodeUnknownEffect(Library)({ version: 2, presets: [] }),
        );
        expect(error._tag).toBe("SchemaError");
      }),
    ));
});
