# Agent presets

This OpenCode V2 plugin saves model presets for primary agents and subagents.
Each mapping contains an agent ID, a provider ID, a model ID, and an optional variant.

The plugin supports OpenCode `0.0.0-beta-19242`.
This release uses the `@opencode-ai/plugin` package name.
Later V2 documentation uses `@opencode/plugin`.

## Load the plugin

OpenCode discovers this directory in the current repository.
The repository setup command installs its dependencies:

```sh
bun install --cwd .opencode --frozen-lockfile
```

To load this checkout in every project, add its directory to the global OpenCode configuration.
Use `~/.config/opencode/opencode.json(c)`, or the corresponding path under `XDG_CONFIG_HOME`.
Preserve the other entries in the configuration.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/absolute/path/to/agent-templates/.opencode/plugins/agent-presets",
  ],
}
```

The server plugin exposes its TUI entrypoint automatically.
OpenCode loads both entrypoints from this directory.

For a separate installation, copy this directory to `~/.config/opencode/plugins/agent-presets`.
Run `bun install` in the copied directory.

## Commands

Press `Ctrl+P` to open the command palette.
Search for `Presets`.

| Palette action                       | Slash command                      |
| ------------------------------------ | ---------------------------------- |
| Presets: Switch preset               | `/presets` or `/preset use <name>` |
| Presets: Save current mappings       | `/preset save <name>`              |
| Presets: Edit preset                 | `/preset edit <name>`              |
| Presets: Delete preset               | `/preset delete <name>`            |
| Presets: Restore configured defaults | `/preset reset`                    |

If you omit a preset name, the command opens a selector or name prompt.
Preset names are case-sensitive and can contain spaces.
Type names without quotation marks.

Saving captures agent model preferences from the current location.
If the current session has a selected agent and model, saving includes that session selection.
The editor lists primary agents, subagents, custom agents, and hidden agents.
Select an agent to change its model and variant.
Select **Save changes** to save the complete preset.
Press `Escape` in the agent selector to cancel the edit.

## Scope and activation

```text
Shared preset library
    |
    +--> Project A: Focused
    |       build   -> model-a [high]
    |       explore -> model-b
    |
    +--> Project B: Quick
            build   -> model-b
            explore -> model-b
```

- The TUI stores the preset library locally, across terminal instances and restarts.
- Each OpenCode location stores its own active preset snapshot on the connected server.
- Different directories and worktrees can use different presets.
- Activation updates the current session model when that session has a selected agent.
- Newly launched subagents use their agent model preferences.
- Existing subagent sessions keep their selected models until an explicit model switch.
- Editing or deleting a saved preset affects future activations. Active snapshots retain their saved mappings.
- An omitted mapping uses the agent's configured preference.
- An omitted variant removes the explicit variant selection.
- Reset restores configured agent preferences and the current agent's preferred or default model.

If an agent is absent from a location, activation skips its mapping and identifies the skipped agent.
If an available agent has an unavailable model or variant, activation fails before it applies the preset.
If activation fails during an update, the plugin attempts to restore the prior mappings and session model.
If restoration fails, the plugin reports that failure.

The plugin serializes activation requests within each location.
The TUI storage lock serializes library writes across terminal instances.
If another terminal changes a preset during an edit, the plugin rejects the stale edit.

The saved library is local to the terminal machine and OpenCode channel.
The plugin does not synchronize the library between machines.

## Runtime details

The server uses the native Effect plugin API and durable plugin storage.
The TUI uses OpenCode dialogs, command registration, and durable TUI storage.
The RPC contract uses portable Standard Schema validators backed by Effect schemas.
UI messages use Lingui.

OpenCode loads agent configuration after package plugins.
The plugin observes `plugin.updated` and registers its model transform after that configuration.
The transform updates existing agents only.
OpenCode owns the transform scope and removes it when the plugin unloads.

The TUI registers commands from the `app` slot, which supplies the required command context.

## Verification

Run these commands from the repository root:

```sh
bun run check
bun run test
bun run test:integration
```

The integration check starts an isolated OpenCode server with temporary configuration and storage.
It checks RPC validation, agent mappings, session selection, location isolation, restart persistence, and reset.

For the terminal check, install the Python test dependencies in a virtual environment:

```sh
python3 -m venv /tmp/opencode/preset-tests
/tmp/opencode/preset-tests/bin/python -m pip install -r scripts/preset-test-requirements.txt
PATH="/tmp/opencode/preset-tests/bin:$PATH" bun run test:tui
```

The terminal check exercises the real TUI at 120 and 60 columns.
It captures terminal screenshots and checks palette actions, slash commands, subagent editing, and shared presets.
The check prints its temporary artifact directory.

The TypeScript configuration skips dependency declaration checks because the bundled Bun and OpenTUI declarations conflict.
The compiler checks the plugin source with strict settings.
