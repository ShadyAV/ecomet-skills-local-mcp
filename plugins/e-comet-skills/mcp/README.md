# e-Comet local MCP

Windows Codex launches `launch-windows.cmd` from the plugin cache. The launcher starts the bundled
`bin/win32-x64/ecomet-mcp.exe` SEA executable directly over STDIO.

The user does not need Node.js. Server source, tests, and the SEA build pipeline live in the separate
`ecomet-local-mcp` repository. This plugin contains only the distribution boundary: launcher and executable.

The MCP listens only on `127.0.0.1:17361`, and the extension connects automatically while local access is enabled.
There is no pairing flow in the MVP. Full WB responses are stored in `%LOCALAPPDATA%\e-comet\local-agent`; MCP tool
results contain only compact summaries and local paths.

Typed local tools:

- `wb_product_card` — card price, rating, and stock for 1–20 articles;
- `wb_search_by_query` — up to 50 search pages with compact top or article-position filtering;
- `wb_recommendations_by_product` — bounded or fully discovered recommendation shelves;
- `wb_product_images` — public WB image-CDN lookup; this tool does not require the extension.

The first three tools send WB requests only through the user's local extension session. WB response bodies do not pass
through e-Comet backend services.

Multiple Codex tasks can use the fixed bridge port at the same time in MVP mode. The first MCP process owns the
extension WebSocket; later bundled MCP processes connect to it over the loopback-only `/mcp-peer` channel and proxy
their bounded WB fetches through that primary process. If the primary task closes, a remaining process retries the port
and takes ownership.
