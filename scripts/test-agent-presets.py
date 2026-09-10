#!/usr/bin/env python3
"""Check the plugin with an isolated OpenCode server and terminal."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def request(binary, env, path, body=None):
    arguments = [binary, "api", "get" if body is None else "post", path]
    if body is not None:
        arguments.extend(["--data", json.dumps(body)])
    result = subprocess.run(arguments, env=env, capture_output=True, text=True, timeout=40, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def location_query(directory):
    return "?" + urllib.parse.urlencode({"location[directory]": str(directory)})


def rpc(api, directory, method, value):
    result = api(f"/api/rpc/agent-presets/{method}" + location_query(directory), {"input": value})
    assert "output" in result, result
    return result["output"]


def model_server():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            messages = payload.get("messages", [])
            user_text = json.dumps([message.get("content") for message in messages if message.get("role") == "user"])
            child = "PRESET_CHILD_CHECK" in user_text
            calls.append({"model": payload.get("model"), "variant": payload.get("preset_test_variant"), "child": child})
            assert len(calls) < 20, "The test model received too many requests."
            delta = {"role": "assistant", "content": "Ready."}
            finish = "stop"
            functions = [tool["function"]["name"] for tool in payload.get("tools", []) if tool.get("type") == "function"]
            if "PRESET_SUBAGENT_CHECK" in user_text and not child and "subagent" in functions and not any(message.get("role") == "tool" for message in messages):
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_preset_test", "type": "function", "function": {
                    "name": "subagent", "arguments": json.dumps({"agent": "explore", "description": "Check subagent model selection", "prompt": "PRESET_CHILD_CHECK"}),
                }}]}
                finish = "tool_calls"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for chunk in [{"delta": delta, "finish_reason": None}, {"delta": {}, "finish_reason": finish}]:
                data = {"id": "completion-test", "object": "chat.completion.chunk", "created": 0, "model": payload.get("model"), "choices": [{"index": 0, **chunk}]}
                self.wfile.write(("data: " + json.dumps(data) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, calls


class Terminal:
    def __init__(self, binary, directory, env, artifacts, columns=120, rows=36):
        import pexpect
        import pyte

        self.screen = pyte.Screen(columns, rows)
        self.stream = pyte.Stream(self.screen)
        self.process = pexpect.spawn(binary, [str(directory)], env=env,
                                     encoding="utf-8", codec_errors="replace", dimensions=(rows, columns), timeout=30)
        self.artifacts = artifacts

    def send(self, text):
        self.process.send(text)

    def wait(self, text, timeout=30, present=True):
        import pexpect

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (text in "\n".join(self.screen.display)) == present:
                return
            try:
                chunk = self.process.read_nonblocking(65536, timeout=0.2)
            except pexpect.TIMEOUT:
                continue
            self.stream.feed(chunk)
            if "\x1b[6n" in chunk:
                self.send("\x1b[1;1R")
        self.capture("failure")
        if text == "Switch preset" and "plugin failed" in "\n".join(self.screen.display):
            self.send("\x1b")
            self.wait("Commands", present=False)
            self.send("/plugins")
            self.wait("Plugins")
            self.send("\r")
            self.wait("enter view error")
            self.send("\r")
            self.wait("TUI plugin error")
            self.capture("plugin-error")
        raise AssertionError(f"The terminal did not show: {text}")

    def capture(self, name):
        from PIL import Image, ImageDraw, ImageFont

        (self.artifacts / f"{name}.txt").write_text("\n".join(self.screen.display))
        font = ImageFont.truetype("DejaVuSansMono.ttf", 16)
        image = Image.new("RGB", (self.screen.columns * 10, self.screen.lines * 21), "#161616")
        draw = ImageDraw.Draw(image)
        colors = {"default": "#d8d8d8", "black": "#161616", "red": "#e88388", "green": "#a8cc8c",
                  "brown": "#dbaa70", "blue": "#8fb3db", "magenta": "#c2a2df", "cyan": "#8bd5ca", "white": "#d8d8d8"}
        for row, cells in self.screen.buffer.items():
            for column, cell in cells.items():
                foreground = colors.get(cell.fg, "#" + cell.fg if len(cell.fg) == 6 else "#d8d8d8")
                background = "#161616" if cell.bg == "default" else colors.get(cell.bg, "#" + cell.bg if len(cell.bg) == 6 else "#161616")
                if cell.reverse:
                    foreground, background = background, foreground
                draw.rectangle((column * 10, row * 21, (column + 1) * 10, (row + 1) * 21), fill=background)
                draw.text((column * 10, row * 21), cell.data, font=font, fill=foreground)
        image.save(self.artifacts / f"{name}.png")

    def close(self):
        import pexpect

        self.send("\x03\x03")
        try:
            self.process.expect(pexpect.EOF, timeout=5)
        except pexpect.TIMEOUT:
            self.process.terminate(force=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tui", action="store_true", help="Check terminal commands and capture terminal screens.")
    parser.add_argument("--plugin", type=Path, help="Check an installed plugin directory.")
    args = parser.parse_args()
    binary = shutil.which("opencode2")
    if not binary:
        raise SystemExit("Install OpenCode beta-19242 before this check.")
    root = Path(__file__).resolve().parents[1]
    temporary_parent = Path("/tmp/opencode")
    if not temporary_parent.is_dir():
        temporary_parent = Path(tempfile.gettempdir())
    sandbox = Path(tempfile.mkdtemp(prefix="agent-presets-", dir=temporary_parent))
    artifacts = sandbox / "artifacts"
    artifacts.mkdir()
    print(f"Check artifacts: {artifacts}", flush=True)
    first, second = sandbox / "project-a", sandbox / "project-b"
    first.mkdir()
    second.mkdir()
    config = sandbox / "config" / "opencode"
    config.mkdir(parents=True)
    plugin = args.plugin or root / ".opencode" / "plugins" / "agent-presets"
    provider, calls = model_server()
    configuration = {
        "$schema": "https://opencode.ai/config.json",
        "plugins": ["*", str(plugin), "-opencode.provider.ollama", "-opencode.provider.lmstudio", "-opencode.provider.vllm"],
        "model": "preset-test/standard",
        "providers": {"preset-test": {
            "name": "Preset test", "package": "@opencode-ai/ai/providers/openai-compatible",
            "settings": {"baseURL": f"http://127.0.0.1:{provider.server_port}/v1"},
            "models": {
                "standard": {"name": "Standard", "variants": [{"id": "medium"}]},
                "reasoner": {"name": "Reasoner", "variants": [
                    {"id": "high", "body": {"preset_test_variant": "high"}},
                    {"id": "low", "body": {"preset_test_variant": "low"}},
                ]},
                "quick": {"name": "Quick"},
            },
        }},
        "agents": {
            "build": {"model": "preset-test/standard#medium", "steps": 4},
            "explore": {"model": "preset-test/quick", "steps": 2},
            "custom-reviewer": {"mode": "subagent", "description": "Check the preset test.", "model": "preset-test/quick"},
        },
    }
    (config / "opencode.json").write_text(json.dumps(configuration))
    env = {"PATH": os.environ["PATH"], "HOME": str(sandbox / "home"), "SHELL": "/bin/sh", "LANG": "C.UTF-8",
           "TERM": "xterm-256color", "COLORTERM": "truecolor", "XDG_CONFIG_HOME": str(sandbox / "config"),
           "XDG_DATA_HOME": str(sandbox / "data"), "XDG_STATE_HOME": str(sandbox / "state"),
           "XDG_CACHE_HOME": str(sandbox / "cache"), "OPENCODE_DISABLE_AUTOUPDATE": "true"}
    Path(env["HOME"]).mkdir()
    port = unused_port()
    log = (artifacts / "server.log").open("w")
    process = None
    terminals = []

    def api(path, body=None):
        return request(binary, env, path, body)

    def start():
        offset = log.tell()
        server = subprocess.Popen([binary, "serve", "--service", "--hostname", "127.0.0.1", "--port", str(port)],
                                  cwd=first, env=env, stdout=log, stderr=log)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise AssertionError("The isolated server stopped during startup.")
            if "server listening" in (artifacts / "server.log").read_text()[offset:]:
                api("/api/health")
                return server
            time.sleep(0.1)
        server.terminate()
        raise AssertionError("The isolated server did not start.")

    try:
        process = start()
        api("/api/plugin/await-activation" + location_query(first), {})
        agents = api("/api/agent" + location_query(first))["data"]
        assert any(agent["id"] == "custom-reviewer" for agent in agents), [agent["id"] for agent in agents]
        models = api("/api/model" + location_query(first))["data"]
        assert any(model["providerID"] == "preset-test" and model["enabled"] for model in models)
        session = api("/api/session", {"location": {"directory": str(first)}, "agent": "build",
                                                 "model": {"providerID": "preset-test", "id": "standard", "variant": "medium"}})["data"]
        preset = {"name": "Focused", "mappings": [
            {"agentID": "build", "model": {"providerID": "preset-test", "id": "reasoner", "variant": "high"}},
            {"agentID": "explore", "model": {"providerID": "preset-test", "id": "reasoner", "variant": "low"}},
            {"agentID": "custom-reviewer", "model": {"providerID": "preset-test", "id": "reasoner", "variant": "high"}},
            {"agentID": "absent-agent", "model": {"providerID": "missing-provider", "id": "missing-model"}},
        ]}
        invalid = {"name": "Invalid", "mappings": [preset["mappings"][0], preset["mappings"][0]]}
        rejected = api("/api/rpc/agent-presets/apply" + location_query(first), {"input": {"preset": invalid}})
        assert rejected["type"] == "rpc.invalid_input", rejected
        result = rpc(api, first, "apply", {"preset": preset, "sessionID": session["id"]})
        assert result["sessionUpdated"]
        assert result["skipped"] == ["absent-agent"]
        saved_session = api(f"/api/session/{session['id']}")["data"]
        assert saved_session["model"] == {"providerID": "preset-test", "id": "reasoner", "variant": "high"}
        mapped_response = api("/api/agent" + location_query(first))
        assert mapped_response["location"]["directory"] == str(first)
        mapped = {agent["id"]: agent for agent in mapped_response["data"]}
        assert "absent-agent" not in mapped
        assert mapped["explore"]["model"] == {"providerID": "preset-test", "id": "reasoner", "variant": "low"}, mapped["explore"]["model"]
        assert mapped["custom-reviewer"]["model"] == {"providerID": "preset-test", "id": "reasoner", "variant": "high"}
        api(f"/api/session/{session['id']}/prompt", {"text": "PRESET_SUBAGENT_CHECK"})
        api(f"/api/session/{session['id']}/wait", {})
        assert {"model": "reasoner", "variant": "low", "child": True} in calls, calls
        assert rpc(api, second, "status", {})["preset"] is None
        process.terminate()
        process.wait(timeout=15)
        process = start()
        api("/api/plugin/await-activation" + location_query(first), {})
        resumed = {agent["id"]: agent for agent in api("/api/agent" + location_query(first))["data"]}
        assert resumed["explore"]["model"] == {"providerID": "preset-test", "id": "reasoner", "variant": "low"}
        assert rpc(api, first, "status", {})["preset"]["name"] == "Focused"
        rpc(api, first, "apply", {"preset": None, "sessionID": session["id"]})
        restored = api(f"/api/session/{session['id']}")["data"]
        assert restored["model"] == {"providerID": "preset-test", "id": "standard", "variant": "medium"}
        print("PASS: RPC validation, subagent execution, session model, location isolation, restart, and reset.", flush=True)

        if args.tui:
            terminal = Terminal(binary, first, env, artifacts)
            terminals.append(terminal)
            terminal.wait("Ask")
            terminal.send("\x10")
            terminal.wait("Commands")
            terminal.send("Presets")
            terminal.wait("Switch preset")
            terminal.capture("palette-desktop")
            terminal.send("\x1b")
            terminal.wait("Commands", present=False)
            terminal.send("/preset save Shared")
            terminal.wait("/preset save Shared")
            terminal.send("\r")
            terminal.wait("Preset saved")
            terminal.send("/preset edit Shared")
            terminal.wait("/preset edit Shared")
            terminal.send("\r")
            terminal.wait("Save changes")
            terminal.capture("editor-desktop")
            terminal.send("Explore")
            terminal.wait("Save changes", present=False)
            terminal.send("\r")
            terminal.wait("Select a model")
            terminal.send("Reasoner")
            terminal.wait("Use configured default", present=False)
            terminal.capture("model-desktop")
            terminal.send("\r")
            terminal.wait("Select a variant")
            terminal.send("high")
            terminal.wait("No explicit variant", present=False)
            terminal.capture("variant-desktop")
            terminal.send("\r")
            terminal.wait("Save changes")
            terminal.send("\r")
            terminal.wait("Save changes", present=False)
            terminal.send("/preset view Shared")
            terminal.wait("/preset view Shared")
            terminal.send("\r")
            terminal.wait("Preset: Shared")
            terminal.wait("custom-reviewer")
            terminal.wait("provider")
            terminal.wait("reasoner")
            terminal.capture("view-desktop")
            terminal.send("\x1b")
            terminal.wait("Preset: Shared", present=False)
            other = Terminal(binary, second, env, artifacts, columns=60, rows=24)
            terminals.append(other)
            other.wait("Ask")
            other.send("/presets")
            other.wait("/presets")
            other.send("\r")
            other.wait("Shared")
            other.capture("picker-narrow")
            other.send("\r")
            other.wait("Preset applied")
            assert rpc(api, second, "status", {})["preset"]["name"] == "Shared"
            shared_agents = {agent["id"]: agent for agent in api("/api/agent" + location_query(second))["data"]}
            assert shared_agents["explore"]["model"] == {"providerID": "preset-test", "id": "reasoner", "variant": "high"}

            terminal.send("\x10")
            terminal.wait("Commands")
            terminal.send("Save current mappings")
            terminal.wait("Switch preset", present=False)
            terminal.send("\r")
            terminal.wait("Preset name")
            terminal.send("Palette")
            terminal.wait("Palette")
            terminal.send("\r")
            terminal.wait("Preset saved: Palette")
            other.send("/presets")
            other.wait("/presets")
            other.send("\r")
            other.wait("Palette")
            other.capture("picker-live-sync-narrow")
            other.send("\x1b")
            other.wait("Search", present=False)

            terminal.close()
            terminals.remove(terminal)
            restarted = Terminal(binary, first, env, artifacts)
            terminals.append(restarted)
            restarted.wait("Ask")
            restarted.send("/presets")
            restarted.wait("/presets")
            restarted.send("\r")
            restarted.wait("Shared")
            restarted.wait("Palette")
            restarted.capture("picker-restarted")
            print("PASS: Ctrl+P, slash commands, shared presets, and narrow terminal selection.", flush=True)
    finally:
        for terminal in terminals:
            terminal.close()
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=15)
        log.close()
        provider.shutdown()
        provider.server_close()
        log_path = artifacts / "server.log"
        log_path.write_text(re.sub(r"server password \S+", "server password [redacted]", log_path.read_text()))


if __name__ == "__main__":
    main()
