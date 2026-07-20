---
name: wb-product-card
id: wb-product-card
title: Карточка товара WB
description: "Собирает живые данные карточки товара Wildberries через браузер пользователя: цену, рейтинг и остатки по складам и размерам. Используйте, когда пользователь спрашивает про остаток или сток артикула ВБ, цену, рейтинг или карточку товара по nm_id / SKU."
skill_schema_version: 1
introduced_in: "2026.7.0"
updated_in: "2026.7.6"
status: experimental
---

# Карточка товара WB

## Workflow

1. Вызовите локальный MCP tool `wb_product_card` один раз с `nmIds` — массивом из 1–20 уникальных положительных артикулов.
2. Используйте компактный массив `products` из ответа tool. Полные ответы WB уже сохранены локально в NDJSON по `resultPath`; не читайте их без отдельной необходимости.
3. Не открывайте вкладки, не управляйте DOM/CDP и не вызывайте `browser_job`.

Локальный MCP сам общается с расширением e-Comet по localhost. Данные WB не проходят через backend e-Comet.

Если tool сообщает, что расширение не подключено, один раз вызовите `local_bridge_status` и попросите пользователя открыть Chrome с установленным и обновлённым расширением e-Comet и хотя бы одной авторизованной вкладкой `wildberries.ru`. Не придумывайте другой транспорт.

## Поля результата

У товара доступны best-effort поля: `nmId`, `name`, `brand`, `supplier`, `supplierId`, `rating`, `feedbacks`, `pics`, `priceRub.basic`, `priceRub.product`, `quantity.total`, `quantity.byWarehouse`, `quantity.bySize`, `status`, `ok`, `error`.

## Ответ пользователю

- Цена — `priceRub.product`, старая/базовая цена — `priceRub.basic`.
- Общий остаток — `quantity.total`, по складам — `quantity.byWarehouse`, по размерам — `quantity.bySize`. Это моментальный снимок на время запроса.
- Для частичного результата верните успешные товары и явно перечислите ошибки по остальным.
- Не утверждайте, что товар отсутствует на WB, если запрос завершился сетевой ошибкой.
