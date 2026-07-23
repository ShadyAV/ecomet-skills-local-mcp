---
name: wb-product-card
id: wb-product-card
title: Карточка товара WB
description: "Собирает живые данные карточки товара Wildberries через браузер пользователя: цену, рейтинг и остатки по складам и размерам. Используйте, когда пользователь спрашивает про остаток или сток артикула ВБ, цену, рейтинг или карточку товара по nm_id / SKU."
skill_schema_version: 1
introduced_in: "2026.7.0"
updated_in: "2026.7.7"
status: experimental
---

# Карточка товара WB

## Workflow

1. Вызовите удалённый e-Comet tool `browser_job`:

   ```json
   { "job_type": "product_card", "articles": [791050753, 913357757] }
   ```

   Передавайте 1–50 уникальных положительных артикулов.
2. Сразу передайте неизменённый `trigger_url` из ответа в локальный tool:

   ```json
   { "triggerUrl": "<trigger_url>" }
   ```

   Имя tool — `execute_browser_job`. Не декодируйте и не исправляйте URL/JWT.
3. Используйте компактный массив `products` из ответа. Полные ответы WB сохранены локально в NDJSON по `resultPath`.

`browser_job` передаёт backend только описание разрешённого задания и возвращает короткоживущий подписанный JWT. Сами ответы WB идут локально: MCP → WebSocket → расширение → вкладка WB → обратно в локальный файл. Не открывайте вкладки и не управляйте DOM/CDP.

Если локальный tool сообщает, что расширение не подключено, один раз вызовите `local_bridge_status` и попросите пользователя открыть Chrome с установленным и обновлённым расширением e-Comet и хотя бы одной авторизованной вкладкой `wildberries.ru`.

## Поля результата

У товара доступны best-effort поля: `nmId`, `name`, `brand`, `supplier`, `supplierId`, `rating`, `feedbacks`, `pics`, `priceRub.basic`, `priceRub.product`, `quantity.total`, `quantity.byWarehouse`, `quantity.bySize`, `status`, `ok`, `error`.

## Ответ пользователю

- Цена — `priceRub.product`, старая/базовая цена — `priceRub.basic`.
- Общий остаток — `quantity.total`, по складам — `quantity.byWarehouse`, по размерам — `quantity.bySize`. Это моментальный снимок на время запроса.
- Для частичного результата верните успешные товары и явно перечислите ошибки по остальным.
- Не утверждайте, что товар отсутствует на WB, если запрос завершился сетевой ошибкой.
