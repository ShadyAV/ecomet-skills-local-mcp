---
name: wb-product-images
id: wb-product-images
title: Фото товаров WB
description: "Находит доступные URL фото товаров Wildberries по артикулам WB. Используйте, когда пользователь просит картинки WB, фото артикула, URL фото по nm_id или пакетную выгрузку ссылок."
skill_schema_version: 1
introduced_in: "2026.6.0"
updated_in: "2026.7.6"
status: stable
---

# Фото товаров WB

## Workflow

1. Вызовите локальный MCP tool `wb_product_images` один раз с `nmIds` — массивом из 1–20 артикулов.
2. При необходимости задайте:
   - `maxPhotos` — от 1 до 30, по умолчанию 15;
   - `size` — `big` или `tm`, по умолчанию `big`;
   - `maxBasket` — глубина fallback-поиска CDN, по умолчанию 60.
3. Верните `products[].imageUrls`. Полный компактный результат также сохранён локально по `resultPath`.

Tool обращается прямо к публичному image-CDN Wildberries. Для него не требуется подключение расширения, Python или backend e-Comet.

## Ответ пользователю

- Укажите количество найденных фото по каждому артикулу.
- При `status: "not_found"` говорите: «фото не найдены текущей проверкой image-CDN».
- Не утверждайте, что товар не существует на WB только из-за отсутствия фото.
