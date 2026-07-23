# e-Comet local MCP

Codex and Claude launch `src/server.mjs` directly over STDIO with the `node` command. The server has no npm runtime
dependencies; all required source modules are included in this directory. Node.js 22+ is required.

The canonical source and tests live under `e-comet-local-mcp/` in the private skills repository. This plugin contains a
release snapshot of its `src/` directory.

The MCP listens only on `127.0.0.1:17361`, and the extension connects automatically while local access is enabled.
There is no pairing flow in the MVP. Full WB responses are stored in the platform-standard user data directory; MCP
tool results contain only compact summaries and local paths.

Full responses use the platform-standard user data directory: `%LOCALAPPDATA%\e-comet\local-agent` on Windows,
`~/Library/Application Support/e-comet/local-agent` on macOS, and
`${XDG_DATA_HOME:-~/.local/share}/e-comet/local-agent` on Linux. `ECOMET_LOCAL_AGENT_RESULT_DIR` overrides this path.

Local tools:

- `execute_browser_job` — executes the short-lived signed `trigger_url` returned by the remote e-Comet `browser_job`;
- `local_bridge_status` — reports whether the extension is connected;
- `wb_product_images` — public WB image-CDN lookup; this tool does not require the extension.

For card, search, and recommendation skills the agent first sends only the small task descriptor to remote `browser_job`,
then passes its opaque JWT to `execute_browser_job`. The extension verifies the RS256 signature, expiry, account UUID,
job type, and exact derived WB URLs. It rejects direct `wb_fetch` calls without that authorization. WB response bodies
remain on the user's computer and do not pass through e-Comet backend services.

Multiple Codex tasks can use the fixed bridge port at the same time in MVP mode. The first MCP process owns the
extension WebSocket; later bundled MCP processes connect to it over the loopback-only `/mcp-peer` channel and proxy
their bounded WB fetches through that primary process. If the primary task closes, a remaining process retries the port
and takes ownership.

Processes also exchange a control-protocol version, bridge generation, build version, and instance ID. A newer
generation waits for active WB requests to finish, receives an explicit takeover grant, claims the same port, and becomes
the primary. The old primary and all other conversations reconnect as peers, while the extension reconnects
automatically. Releases must increment `BRIDGE_GENERATION` whenever the active primary needs replacement.
