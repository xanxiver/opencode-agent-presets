# opencode-agent-presets

Save and switch model presets for OpenCode agents and subagents.

A preset maps an agent to a provider, a model, and an optional variant.
The plugin targets OpenCode V2 beta-19242.
Other releases can fail to load the plugin.

## Install

1. Clone this repository.

2. Install the plugin dependencies.

   ```sh
   bun install --cwd .opencode
   ```

3. Add the plugin directory to the `plugins` array in
   `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugins": [
       "/absolute/path/to/opencode-agent-presets/.opencode/plugins/agent-presets"
     ]
   }
   ```

4. Restart the OpenCode service.

   ```sh
   opencode2 service restart
   ```

For a project installation, copy the plugin directory to
`.opencode/plugins/agent-presets` in your project.

## Commands

Press `Ctrl+P` and search for `Presets`.

| Palette action | Slash command |
| --- | --- |
| Presets: Switch preset | `/presets` or `/preset use <name>` |
| Presets: Save current mappings | `/preset save <name>` |
| Presets: Edit preset | `/preset edit <name>` |
| Presets: Delete preset | `/preset delete <name>` |
| Presets: Restore configured defaults | `/preset reset` |

Add a preset name to `save`, `edit`, `use`, or `delete`.
Omit the name to open a selector or a prompt.

## Behavior

- The plugin saves the shared preset library on the local machine.
- Each project location has one active preset.
- Activation applies the agent mappings.
- Activation updates the current session model.
- The plugin skips an absent agent and reports it.
- An unavailable model or variant stops activation.
- An omitted mapping keeps the configured agent preference.
- An omitted variant removes the explicit variant.

## Storage

- Preset library:
  `~/.local/state/opencode/<channel>/tui/plugin.agent-presets.library-v1.json`
- Active preset: the `kv` table in `~/.local/share/opencode/opencode.db`

## Checks

```sh
bun install --cwd .opencode
bun run --cwd .opencode check
bun run --cwd .opencode test
python3 scripts/test-agent-presets.py
```

The integration check needs Python 3.
It starts an isolated OpenCode server and uses temporary data.
For the terminal check, install the packages in
`scripts/preset-test-requirements.txt` and run
`python3 scripts/test-agent-presets.py --tui`.
