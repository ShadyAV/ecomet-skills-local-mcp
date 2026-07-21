# e-Comet Skills + Local MCP

Public test marketplace for installing the e-Comet Wildberries skills and their bundled local MCP server in one step.

## Install in Codex

```powershell
codex plugin marketplace add ShadyAV/ecomet-skills-local-mcp --ref main
codex plugin add e-comet-skills@e-comet-local-mcp-test
```

Restart Codex Desktop and open a new task after installation.

## Install in Claude Code

Run inside Claude Code:

```text
/plugin marketplace add ShadyAV/ecomet-skills-local-mcp
/plugin install e-comet-skills@e-comet-skills
```

Restart Claude Code and open a new session after installation.

## User flow

1. Codex installs this repository's `e-comet-skills` plugin.
2. The plugin provides four typed Wildberries skills and registers its bundled STDIO MCP through the host-specific plugin manifests.
3. On MCP start, `launch-windows.cmd` runs the bundled Windows x64 SEA executable directly.
4. The MCP connects only to `127.0.0.1:17361`; the e-Comet Chrome extension performs WB requests in the user's browser session.
5. Full WB responses remain on the user's computer under `%LOCALAPPDATA%\e-comet\local-agent`.

The user does not need Node.js, Python, a `hosts` modification, a separate MCP download, or an e-Comet backend relay.

## Requirements

- Windows x64;
- Codex Desktop with plugin support;
- Chrome with the compatible e-Comet extension;
- an authorized `wildberries.ru` tab for authenticated WB requests.

This is an MVP test build. It has no pairing flow.
