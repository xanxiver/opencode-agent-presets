import { Effect, Schema } from "effect";

const Identifier = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);

export const PresetName = Identifier.check(Schema.isMaxLength(80));
export const ModelSelection = Schema.Struct({
  providerID: Identifier,
  id: Identifier,
  variant: Schema.optionalKey(Identifier),
});
export type ModelSelection = typeof ModelSelection.Type;

export const Mapping = Schema.Struct({
  agentID: Identifier,
  model: ModelSelection,
});
export type Mapping = typeof Mapping.Type;

export const Preset = Schema.Struct({
  name: PresetName,
  mappings: Schema.Array(Mapping).check(
    Schema.isMaxLength(256),
    Schema.makeFilter(
      (mappings) =>
        new Set(mappings.map((item) => item.agentID)).size === mappings.length,
      { expected: "Each agent has one mapping." },
    ),
  ),
});
export type Preset = typeof Preset.Type;

export const Library = Schema.Struct({
  version: Schema.Literal(1),
  presets: Schema.Array(Preset).check(
    Schema.makeFilter(
      (presets) =>
        new Set(presets.map((item) => item.name)).size === presets.length,
      { expected: "Each preset has a unique name." },
    ),
  ),
});

export const Active = Schema.Struct({
  version: Schema.Literal(1),
  preset: Schema.NullOr(Preset),
});

export class PresetError extends Schema.TaggedError<PresetError>()(
  "PresetError",
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

export class OperationError extends Schema.TaggedError<OperationError>()(
  "OperationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The operation failed: ${this.operation}.`;
  }
}

export const attempt = <A>(
  operation: string,
  run: (signal: AbortSignal) => PromiseLike<A>,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OperationError({ operation, cause }),
  });

export function modelLabel(model: ModelSelection): string {
  const base = `${model.providerID}/${model.id}`;
  return model.variant ? `${base} [${model.variant}]` : base;
}
