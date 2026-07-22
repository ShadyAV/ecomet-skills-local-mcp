# e-Comet local MCP

Codex launches `src/server.mjs` directly over STDIO with the user's `node` command. The server has no npm runtime
dependencies; all required source modules are included in this directory. Node.js 22 or newer is required.

Claude installs the same source separately as `e-comet-local-mcp.mcpb` and uses Claude Desktop's bundled Node.js
runtime. The MCPB must remain a release asset rather than a file inside this plugin because it is itself a ZIP archive.

The canonical source and tests live in the separate `ecomet-local-mcp` repository. This plugin contains a release
snapshot of its `src/` directory.

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
