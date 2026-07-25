import {
    IMAGE_BASKET_BOUNDS,
    IMAGE_CONCURRENCY,
    MAX_PRODUCT_ARTICLES,
    MAX_REQUEST_TIMEOUT_MS,
    MAX_RETURNED_PRODUCTS,
    MIN_REQUEST_TIMEOUT_MS,
} from './config.mjs';

const ALLOWED_WB_HOSTS = new Set(['wildberries.ru', 'www.wildberries.ru']);
const ALLOWED_WB_PATH = /^\/__internal\/(card|u-card|search|u-search|recom|u-recom|recommendations)\//;

export const isAllowedWbUrl = (value) => {
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        return url.protocol === 'https:' && ALLOWED_WB_HOSTS.has(hostname) && ALLOWED_WB_PATH.test(url.pathname);
    } catch {
        return false;
    }
};

export const productDetailUrl = (nmId) =>
    `https://www.wildberries.ru/__internal/card/cards/v4/detail?appType=32&curr=rub&dest=-1257786&spp=30&hide_dtype=11&ab_testing=false&lang=ru&nm=${encodeURIComponent(
        nmId
    )}`;

export const buildSearchUrls = (query, page) => {
    const params = new URLSearchParams({
        ab_testing: 'false',
        appType: '1',
        curr: 'rub',
        dest: '-1257786',
        hide_dtype: '15',
        hide_vflags: '4294967296',
        inheritFilters: 'true',
        lang: 'ru',
        locale: 'ru',
        query,
        resultset: 'catalog',
        sort: 'popular',
        spp: '30',
        suppressSpellcheck: 'false',
    });
    if (page > 1) {
        params.set('page', String(page));
    }
    const suffix = `exactmatch/ru/common/v18/search?${params}`;
    return [
        `https://www.wildberries.ru/__internal/u-search/${suffix}`,
        `https://www.wildberries.ru/__internal/search/${suffix}`,
    ];
};
export const buildRecommendationUrls = (nmId, page) => {
    const params = new URLSearchParams({
        ab_testing: 'false',
        appType: '1',
        curr: 'rub',
        dest: '-1257786',
        hide_dtype: '15',
        hide_vflags: '4294967296',
        lang: 'ru',
        locale: 'ru',
        query: String(nmId),
        resultset: 'catalog',
        sort: 'popular',
        spp: '30',
        uclusters: '3',
        page: String(page),
    });
    const suffix = `recom/ru/male/v8/search?${params}`;
    return [
        `https://www.wildberries.ru/__internal/u-recom/${suffix}`,
        `https://www.wildberries.ru/__internal/recom/${suffix}`,
    ];
};

export const responseProducts = (response) => (Array.isArray(response?.data?.body?.products) ? response.data.body.products : []);

export const isSuccessfulWbResponse = (response) =>
    !response?.error &&
    response?.data?.ok !== false &&
    typeof response?.data?.status === 'number' &&
    response.data.status >= 200 &&
    response.data.status < 300;

export const requestWbFetchWithFallback = async (requestWbFetch, urls, timeout) => {
    let lastResponse;
    for (const url of urls) {
        lastResponse = await requestWbFetch(url, timeout);
        if (isSuccessfulWbResponse(lastResponse)) {
            return { url, response: lastResponse };
        }
    }
    return { url: urls.at(-1), response: lastResponse };
};

export const numberOrUndefined = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const toRub = (value) => (numberOrUndefined(value) === undefined ? undefined : Math.round(value) / 100);

const summarizeListingProduct = (product, position, globalPosition) => {
    const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
    const price = sizes.find((size) => size?.price)?.price || product?.price;
    const row = {
        nmId: numberOrUndefined(product?.id) || 0,
        name: typeof product?.name === 'string' ? product.name : undefined,
        brand: typeof product?.brand === 'string' ? product.brand : undefined,
        supplierId: numberOrUndefined(product?.supplierId),
        priceRub: price ? { basic: toRub(price.basic), product: toRub(price.product) } : undefined,
        rating: numberOrUndefined(product?.reviewRating),
        feedbacks: numberOrUndefined(product?.feedbacks),
        pics: numberOrUndefined(product?.pics),
        position,
        globalPosition,
    };
    if (numberOrUndefined(product?.log?.cpm) !== undefined) {
        row.promoted = true;
    }
    return row;
};

export const projectPageProducts = (products, globalOffset, productNmIds, remainingLimit) => {
    const filter = productNmIds ? new Set(productNmIds) : null;
    const rows = products.map((product, index) => summarizeListingProduct(product, index + 1, globalOffset + index + 1));
    const selected = filter ? rows.filter((row) => filter.has(row.nmId)) : rows.slice(0, remainingLimit);
    return selected;
};

export const normalizeStatus = (succeeded, total) => (succeeded === total ? 'done' : succeeded === 0 ? 'failed' : 'partial');

export const validTimeout = (timeout) =>
    typeof timeout === 'number' &&
    Number.isFinite(timeout) &&
    timeout >= MIN_REQUEST_TIMEOUT_MS &&
    timeout <= MAX_REQUEST_TIMEOUT_MS;

export const validProductProjection = (productLimitTotal, productNmIds) =>
    Number.isInteger(productLimitTotal) &&
    productLimitTotal >= 1 &&
    productLimitTotal <= MAX_RETURNED_PRODUCTS &&
    (productNmIds === undefined ||
        (Array.isArray(productNmIds) &&
            productNmIds.length >= 1 &&
            productNmIds.length <= MAX_PRODUCT_ARTICLES &&
            productNmIds.every((nmId) => Number.isSafeInteger(nmId) && nmId > 0) &&
            new Set(productNmIds).size === productNmIds.length));

export const recommendationTotalPages = (total, firstPageCount) => {
    if (!Number.isInteger(total) || total < 0 || !Number.isInteger(firstPageCount) || firstPageCount <= 0) {
        return null;
    }
    return Math.max(1, Math.ceil(total / firstPageCount));
};

const basketNumberForVol = (vol) => {
    const index = IMAGE_BASKET_BOUNDS.findIndex((upperBound) => vol <= upperBound);
    return index < 0 ? null : index + 1;
};

export const imageBaseUrl = (nmId, basket) => {
    const testOrigin = process.env.NODE_ENV === 'test' ? process.env.ECOMET_LOCAL_BRIDGE_TEST_IMAGE_ORIGIN : undefined;
    const origin = testOrigin || `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru`;
    return `${origin}/vol${Math.floor(nmId / 100000)}/part${Math.floor(nmId / 1000)}/${nmId}/images`;
};

export const imageExists = async (url, timeout) => {
    const signal = AbortSignal.timeout(timeout);
    try {
        const response = await fetch(url, { method: 'HEAD', signal });
        if (response.ok) return true;
        if (response.status !== 403 && response.status !== 405) return false;
    } catch {
        // Some CDN edges do not support HEAD; retry with a one-byte GET.
    }
    try {
        const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(timeout) });
        return response.ok || response.status === 206;
    } catch {
        return false;
    }
};

export const discoverImageBasket = async (nmId, maxBasket, size, timeout) => {
    const vol = Math.floor(nmId / 100000);
    const predicted = basketNumberForVol(vol);
    const candidates = predicted
        ? [predicted, ...Array.from({ length: maxBasket }, (_, index) => index + 1).filter((basket) => basket !== predicted)]
        : Array.from({ length: maxBasket }, (_, index) => index + 1);
    for (let index = 0; index < candidates.length; index += IMAGE_CONCURRENCY) {
        const batch = candidates.slice(index, index + IMAGE_CONCURRENCY);
        const matches = await Promise.all(
            batch.map(async (basket) => {
                const baseUrl = imageBaseUrl(nmId, basket);
                return (await imageExists(`${baseUrl}/${size}/1.webp`, timeout)) ? { basket, baseUrl } : null;
            })
        );
        const match = matches.find(Boolean);
        if (match) {
            return match;
        }
    }
    return null;
};

export const summarizeProduct = (nmId, response) => {
    const product = Array.isArray(response?.data?.body?.products) ? response.data.body.products[0] : undefined;
    if (!product || typeof product !== 'object') {
        return {
            nmId,
            ok: false,
            status: response?.data?.status,
            error: response?.error || 'WB response did not contain a product',
        };
    }

    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    const byWarehouseMap = new Map();
    const bySize = [];
    let quantityTotal = 0;
    for (const size of sizes) {
        const stocks = Array.isArray(size?.stocks) ? size.stocks : [];
        const warehouses = new Set();
        let sizeQuantity = 0;
        for (const stock of stocks) {
            const wh = numberOrUndefined(stock?.wh);
            if (wh === undefined) continue;
            const qty = numberOrUndefined(stock?.qty) || 0;
            quantityTotal += qty;
            sizeQuantity += qty;
            warehouses.add(wh);
            const current = byWarehouseMap.get(wh) || { wh, qty: 0, rows: 0 };
            current.qty += qty;
            current.rows += 1;
            byWarehouseMap.set(wh, current);
        }
        bySize.push({
            size: typeof size?.origName === 'string' ? size.origName : typeof size?.name === 'string' ? size.name : '',
            qty: sizeQuantity,
            warehouses: warehouses.size,
        });
    }
    const price = product.sizes?.[0]?.price || product.price;

    return {
        nmId: numberOrUndefined(product.id) || nmId,
        ok: true,
        name: typeof product.name === 'string' ? product.name : undefined,
        brand: typeof product.brand === 'string' ? product.brand : undefined,
        supplier: typeof product.supplier === 'string' ? product.supplier : undefined,
        supplierId: numberOrUndefined(product.supplierId),
        rating: numberOrUndefined(product.reviewRating),
        feedbacks: numberOrUndefined(product.feedbacks),
        pics: numberOrUndefined(product.pics),
        priceRub: {
            basic: numberOrUndefined(price?.basic) === undefined ? undefined : price.basic / 100,
            product: numberOrUndefined(price?.product) === undefined ? undefined : price.product / 100,
            logistics: numberOrUndefined(price?.logistics) === undefined ? undefined : price.logistics / 100,
            return: numberOrUndefined(price?.return) === undefined ? undefined : price.return / 100,
            cashback: numberOrUndefined(price?.cashback) === undefined ? undefined : price.cashback / 100,
        },
        quantity: {
            total: quantityTotal,
            byWarehouse: [...byWarehouseMap.values()],
            bySize,
        },
        status: response?.data?.status,
    };
};

export const runWithConcurrency = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
};
