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

## Use

Press `Ctrl+P` and search for `Presets`.

| Palette action | Slash command |
| --- | --- |
| Switch preset | `/presets` or `/preset use <name>` |
| Save current mappings | `/preset save <name>` |
| Edit preset | `/preset edit <name>` |
| Delete preset | `/preset delete <name>` |
| Restore configured defaults | `/preset reset` |

Add a preset name to `save`, `edit`, `use`, or `delete`.
Omit the name to open a selector or a prompt.

Saving captures the current agent model mappings.
Activation applies the mappings and updates the current session model.
An absent agent is skipped and reported.
An unavailable model or variant stops activation.
