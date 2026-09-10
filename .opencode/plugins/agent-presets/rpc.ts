import { Rpc } from "@opencode-ai/plugin/rpc";
import { Schema } from "effect";
import { Preset } from "./data.ts";

function portable<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  // The Promise plugin boundary requires a portable validator, without Effect schema metadata.
  return { "~standard": Schema.toStandardSchemaV1(schema)["~standard"] };
}

const Status = Schema.Struct({ preset: Schema.NullOr(Preset) });
const Applied = Schema.Struct({
  preset: Schema.NullOr(Preset),
  skipped: Schema.Array(Schema.String),
  sessionUpdated: Schema.Boolean,
});
const Apply = Schema.Struct({
  preset: Schema.NullOr(Preset),
  sessionID: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^ses/))),
});
const errors = {
  preset: portable(Schema.Struct({ code: Schema.String })),
};

export const PresetsRpc = Rpc.define({
  id: "agent-presets",
  methods: {
    status: {
      input: portable(Schema.Struct({})),
      output: portable(Status),
      errors,
    },
    apply: {
      input: portable(Apply),
      output: portable(Applied),
      errors,
    },
  },
  events: {},
});

export type ApplyInput = typeof Apply.Type;
