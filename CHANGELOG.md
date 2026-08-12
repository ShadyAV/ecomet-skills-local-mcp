# Changelog

## [2026.8.7] - 2026-08-12

### Изменено
- `local_bridge_status` различает запуск моста, ожидание расширения, отсутствие вкладки Wildberries и готовность к браузерным заданиям, а также подсказывает следующее действие.

### Исправлено
- Расширение быстрее переподключается к локальному мосту, когда пользователь открывает или обновляет вкладку Wildberries.
- Локальный мост больше не готовит общее хранилище при запуске: одному запущенному агенту оно не нужно вовсе, поэтому ошибка доступа к нему больше не может скрыть локальные инструменты.

## Unreleased

### Added
- Added `wb_seller_reviews` for mixed, entity-bound Wildberries seller-review exports with per-report partial results
  and private local XLSX resource links.
- Added bounded artifact streaming and storage with 100 MiB per-file, 500 MiB per-job, and 24-hour retention limits.

### Changed
- Extended the trusted one-use browser authorization handoff to the seller-review export tool while keeping the plugin
  MCP-only.

## [2026.8.2] - 2026-08-07

Initial public release of the e-Comet skill pack.

### Added
- Marketplace plugin for Claude Cowork and Codex Desktop that installs the remote e-Comet MCP for seller analytics
  together with a bundled local MCP for live Wildberries data.
- Typed local tools for Wildberries product cards, search results, recommendation shelves, and product images,
  executed through the user's e-Comet browser extension.
- Authorization handoff that keeps the signed browser-job token out of the model's context.
- Full Wildberries responses stay on the user's computer; tool results carry compact summaries and local result paths.
