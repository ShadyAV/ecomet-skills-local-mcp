import {
    DEFAULT_RETURNED_PRODUCTS,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    MAX_PRODUCT_CARD_ARTICLES,
    MAX_PRODUCT_CARD_REQUEST_UNITS,
    MAX_RECOMMENDATION_ARTICLES,
    MAX_RECOMMENDATION_PAGES,
    MAX_RETURNED_PRODUCTS,
    MAX_SEARCH_PAGES,
    MAX_SEARCH_QUERIES,
    PRODUCT_CARD_CONCURRENCY,
    RECOMMENDATION_CONCURRENCY,
    REQUEST_TIMEOUT_MS,
    SEARCH_CONCURRENCY,
} from './config.mjs';
import {
    isSuccessfulWbResponse,
    normalizeStatus,
    numberOrUndefined,
    projectPageProducts,
    recommendationTotalPages,
    responseProducts,
    runWithConcurrency,
    summarizeProduct,
    validTimeout,
} from './wb-domain.mjs';

const validJobTimeout = (job) => job.timeout === undefined || validTimeout(job.timeout);

export const validateAuthorizedJobLimits = (authorization) => {
    const job = authorization?.job;
    if (!job || typeof job !== 'object' || Array.isArray(job) || !validJobTimeout(job)) {
        throw new Error('Browser job descriptor or timeout is invalid');
    }

    if (authorization.jobType === 'search_by_query') {
        const queries = job.queries;
        const validQueries =
            job.type === 'wb-search-by-query' &&
            Array.isArray(queries) &&
            queries.length >= 1 &&
            queries.length <= MAX_SEARCH_QUERIES &&
            queries.every(
                (item) =>
                    Array.isArray(item) &&
                    item.length === 2 &&
                    typeof item[0] === 'string' &&
                    item[0].trim().length > 0 &&
                    Number.isInteger(item[1]) &&
                    item[1] >= 1 &&
                    item[1] <= MAX_SEARCH_PAGES
            ) &&
            queries.reduce((total, [, pages]) => total + pages, 0) <= MAX_SEARCH_PAGES;
        if (!validQueries) {
            throw new Error(
                `Browser search job exceeds the local limit of ${MAX_SEARCH_QUERIES} queries or ${MAX_SEARCH_PAGES} total pages`
            );
        }
        return;
    }

    if (authorization.jobType === 'product_card') {
        const articles = job.articles;
        const endpoints = job.endpoints;
        const validProductCard =
            job.type === 'wb-product-card' &&
            Array.isArray(articles) &&
            articles.length >= 1 &&
            articles.length <= MAX_PRODUCT_CARD_ARTICLES &&
            articles.every((article) => Number.isSafeInteger(article?.nm) && article.nm > 0) &&
            Array.isArray(endpoints) &&
            endpoints.length >= 1 &&
            endpoints.every(
                (endpoint) =>
                    typeof endpoint?.key === 'string' &&
                    endpoint.key.length > 0 &&
                    typeof endpoint?.url === 'string' &&
                    endpoint.url.length > 0
            ) &&
            articles.length * endpoints.length <= MAX_PRODUCT_CARD_REQUEST_UNITS;
        if (!validProductCard) {
            throw new Error(
                `Browser product-card job exceeds the local limit of ${MAX_PRODUCT_CARD_ARTICLES} articles or ${MAX_PRODUCT_CARD_REQUEST_UNITS} requests`
            );
        }
        return;
    }

    if (authorization.jobType === 'recommendations_by_product') {
        const articles = job.articles;
        const validRecommendations =
            job.type === 'wb-recommendations-by-product' &&
            Array.isArray(articles) &&
            articles.length >= 1 &&
            articles.length <= MAX_RECOMMENDATION_ARTICLES &&
            articles.every(
                (item) =>
                    Array.isArray(item) &&
                    (item.length === 1 || item.length === 2) &&
                    Number.isSafeInteger(item[0]) &&
                    item[0] > 0 &&
                    (item.length === 1 || (Number.isInteger(item[1]) && item[1] >= 1 && item[1] <= MAX_RECOMMENDATION_PAGES))
            );
        if (!validRecommendations) {
            throw new Error(
                `Browser recommendations job exceeds the local limit of ${MAX_RECOMMENDATION_ARTICLES} articles or ${MAX_RECOMMENDATION_PAGES} pages per article`
            );
        }
        return;
    }

    throw new Error(`Unsupported browser_job type: ${authorization.jobType}`);
};

export const extractBrowserJobToken = (value) => {
    if (typeof value !== 'string') {
        throw new Error('triggerUrl must be a browser_job trigger URL or JWT string');
    }
    const input = value.trim();
    if (!input || Buffer.byteLength(input, 'utf8') > MAX_BROWSER_JOB_TOKEN_BYTES) {
        throw new Error('triggerUrl must be a browser_job trigger URL or JWT string');
    }
    if (!input.includes('__agent_job')) {
        if (input.split('.').length !== 3) throw new Error('Invalid browser_job JWT');
        return input;
    }
    const hashIndex = input.indexOf('#');
    const hash = hashIndex >= 0 ? input.slice(hashIndex + 1) : input.replace(/^#/, '');
    const token = new URLSearchParams(hash).get('__agent_job');
    if (!token || token.split('.').length !== 3) {
        throw new Error('Invalid browser_job trigger URL');
    }
    return token;
};

const buildDescriptorUrl = (endpoint, params, query, page) => {
    const url = new URL(endpoint);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    return url.toString();
};

const fillTemplate = (template, article) =>
    template.replace(/\{(\w+)\}/g, (_match, key) => (article[key] === undefined ? '' : String(article[key])));

const compactCardBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    return {
        imtId: numberOrUndefined(body.imt_id),
        nmId: numberOrUndefined(body.nm_id),
        vendorCode: typeof body.vendor_code === 'string' ? body.vendor_code : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        subjectId: numberOrUndefined(body.subj_id) ?? numberOrUndefined(body.subject_id),
        subject: typeof body.subj_name === 'string' ? body.subj_name : typeof body.subject_name === 'string' ? body.subject_name : undefined,
        rootSubject:
            typeof body.subj_root_name === 'string'
                ? body.subj_root_name
                : typeof body.root_subject_name === 'string'
                  ? body.root_subject_name
                  : undefined,
        options: Array.isArray(body.options) ? body.options : undefined,
        colors: Array.isArray(body.colors) ? body.colors.filter((value) => Number.isSafeInteger(value) && value > 0) : undefined,
    };
};

const executeSearchJob = async ({ authorizationId, job, requestWbFetch, writer, projection }) => {
    const units = job.queries.flatMap(([query, pages], queryIndex) =>
        Array.from({ length: pages }, (_, index) => ({
            queryIndex,
            query,
            page: index + 1,
            url: buildDescriptorUrl(job.endpoint, job.params, query, index + 1),
        }))
    );
    const fetched = await runWithConcurrency(units, SEARCH_CONCURRENCY, async (unit) => {
        try {
            const response = await requestWbFetch(unit.url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, response });
            return {
                ...unit,
                response,
                ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
            };
        } catch (error) {
            await writer.append({
                jobId: job.jobId,
                ...unit,
                error: error.message,
            });
            return { ...unit, ok: false, error: error.message };
        }
    });

    const queries = job.queries.map(([query, pagesRequested], queryIndex) => {
        let globalOffset = 0;
        let returnedProducts = 0;
        const pages = fetched
            .filter((unit) => unit.queryIndex === queryIndex)
            .sort((left, right) => left.page - right.page)
            .map((unit) => {
                const products = responseProducts(unit.response);
                const remaining = Math.max(0, projection.productLimitTotal - returnedProducts);
                const selected = unit.ok
                    ? projectPageProducts(
                          products,
                          globalOffset,
                          projection.productNmIds,
                          projection.productNmIds ? MAX_RETURNED_PRODUCTS : remaining
                      )
                    : [];
                returnedProducts += selected.length;
                const page = {
                    page: unit.page,
                    ok: unit.ok,
                    httpStatus: unit.response?.data?.status,
                    total: products.length,
                    overallTotal: numberOrUndefined(unit.response?.data?.body?.total),
                    products: selected,
                };
                if (!unit.ok) {
                    page.error = unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB search request failed';
                }
                globalOffset += products.length;
                return page;
            });
        return {
            query,
            pagesRequested,
            pagesSucceeded: pages.filter((page) => page.ok).length,
            productsSeen: pages.reduce((total, page) => total + page.total, 0),
            productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
            pages,
        };
    });
    const succeeded = fetched.filter((unit) => unit.ok).length;
    return {
        ok: succeeded > 0,
        status: normalizeStatus(succeeded, fetched.length),
        pagesRequested: fetched.length,
        pagesSucceeded: succeeded,
        pagesFailed: fetched.length - succeeded,
        productFilterApplied: Boolean(projection.productNmIds),
        productLimitTotal: projection.productNmIds ? undefined : projection.productLimitTotal,
        queries,
    };
};

const executeProductCardJob = async ({ authorizationId, job, requestWbFetch, writer }) => {
    const units = job.articles.flatMap((article) =>
        job.endpoints.map((endpoint) => ({
            nmId: article.nm,
            key: endpoint.key,
            url: fillTemplate(endpoint.url, article),
        }))
    );
    const fetched = await runWithConcurrency(units, PRODUCT_CARD_CONCURRENCY, async (unit) => {
        try {
            const response = await requestWbFetch(unit.url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, response });
            return { ...unit, response, ok: isSuccessfulWbResponse(response) };
        } catch (error) {
            await writer.append({
                jobId: job.jobId,
                ...unit,
                error: error.message,
            });
            return { ...unit, ok: false, error: error.message };
        }
    });

    const products = job.articles.map((article) => {
        const articleUnits = fetched.filter((unit) => unit.nmId === article.nm);
        const detailUnit =
            articleUnits.find((unit) => unit.key === 'detail') || articleUnits.find((unit) => responseProducts(unit.response).length);
        const cardUnit = articleUnits.find((unit) => unit.key === 'card');
        const detail = detailUnit ? summarizeProduct(article.nm, detailUnit.response) : { nmId: article.nm, ok: false };
        const content = compactCardBody(cardUnit?.response?.data?.body);
        return {
            ...detail,
            ...content,
            content,
            units: articleUnits.map((unit) => ({
                key: unit.key,
                ok: unit.ok,
                httpStatus: unit.response?.data?.status,
                error: unit.error || unit.response?.error || unit.response?.data?.statusText,
            })),
        };
    });
    const succeeded = products.filter((product) => product.ok).length;
    return {
        ok: succeeded > 0,
        status: normalizeStatus(succeeded, products.length),
        total: products.length,
        succeeded,
        failed: products.length - succeeded,
        products,
    };
};

const normalizeRecommendationArticles = (articles) => {
    const byArticle = new Map();
    for (const [nmId, pages] of articles) {
        const current = byArticle.get(nmId);
        if (!current) {
            byArticle.set(nmId, { nmId, pages });
        } else if (current.pages === undefined || pages === undefined) {
            byArticle.set(nmId, { nmId, pages: undefined });
        } else {
            byArticle.set(nmId, { nmId, pages: Math.max(current.pages, pages) });
        }
    }
    return [...byArticle.values()];
};

const executeRecommendationsJob = async ({ authorizationId, job, requestWbFetch, writer, projection }) => {
    const articles = normalizeRecommendationArticles(job.articles);
    const fetchPage = async (unit) => {
        const url = buildDescriptorUrl(job.endpoint, job.params, String(unit.nmId), unit.page);
        try {
            const response = await requestWbFetch(url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, url, response });
            return {
                ...unit,
                url,
                response,
                ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
            };
        } catch (error) {
            await writer.append({
                jobId: job.jobId,
                ...unit,
                url,
                error: error.message,
            });
            return { ...unit, url, ok: false, error: error.message };
        }
    };

    const firstPages = await runWithConcurrency(
        articles.map((article) => ({ ...article, page: 1 })),
        RECOMMENDATION_CONCURRENCY,
        fetchPage
    );
    const remainingUnits = [];
    const autoDepthCapped = new Set();
    for (const firstPage of firstPages) {
        const discoveredPages = recommendationTotalPages(numberOrUndefined(firstPage.response?.data?.body?.total));
        const article = articles.find((item) => item.nmId === firstPage.nmId);
        if (article.pages === undefined && discoveredPages !== null && discoveredPages > MAX_RECOMMENDATION_PAGES) {
            autoDepthCapped.add(article.nmId);
        }
        const requestedPages =
            article.pages === undefined
                ? Math.min(discoveredPages || 1, MAX_RECOMMENDATION_PAGES)
                : Math.min(article.pages, discoveredPages || article.pages);
        for (let page = 2; page <= requestedPages; page += 1) {
            remainingUnits.push({ ...article, page });
        }
    }
    const remainingPages = await runWithConcurrency(remainingUnits, RECOMMENDATION_CONCURRENCY, fetchPage);
    const fetched = [...firstPages, ...remainingPages];

    const summaries = articles.map((article) => {
        let globalOffset = 0;
        let returnedProducts = 0;
        const articleUnits = fetched.filter((unit) => unit.nmId === article.nmId).sort((left, right) => left.page - right.page);
        const overallTotal = numberOrUndefined(articleUnits[0]?.response?.data?.body?.total);
        const discoveredPages = recommendationTotalPages(overallTotal);
        const pages = articleUnits.map((unit) => {
            const products = responseProducts(unit.response);
            const remaining = Math.max(0, projection.productLimitTotal - returnedProducts);
            const selected = unit.ok
                ? projectPageProducts(
                      products,
                      globalOffset,
                      projection.productNmIds,
                      projection.productNmIds ? MAX_RETURNED_PRODUCTS : remaining
                  )
                : [];
            returnedProducts += selected.length;
            const page = {
                page: unit.page,
                ok: unit.ok,
                httpStatus: unit.response?.data?.status,
                total: products.length,
                products: selected,
            };
            if (!unit.ok) {
                page.error = unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB recommendation request failed';
            }
            globalOffset += products.length;
            return page;
        });
        return {
            sourceNmId: article.nmId,
            pagesRequested: pages.length,
            pagesSucceeded: pages.filter((page) => page.ok).length,
            overallTotal,
            totalPages: discoveredPages,
            productsSeen: pages.reduce((total, page) => total + page.total, 0),
            productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
            truncatedByLocalLimit: autoDepthCapped.has(article.nmId),
            pages,
        };
    });
    const succeeded = fetched.filter((unit) => unit.ok).length;
    const truncatedByLocalLimit = autoDepthCapped.size > 0;
    return {
        ok: succeeded > 0,
        status: truncatedByLocalLimit && succeeded === fetched.length ? 'partial' : normalizeStatus(succeeded, fetched.length),
        complete: !truncatedByLocalLimit && succeeded === fetched.length,
        truncatedByLocalLimit,
        pagesRequested: fetched.length,
        pagesSucceeded: succeeded,
        pagesFailed: fetched.length - succeeded,
        productFilterApplied: Boolean(projection.productNmIds),
        productLimitTotal: projection.productNmIds ? undefined : projection.productLimitTotal,
        articles: summaries,
    };
};

export const executeAuthorizedBrowserJob = async ({
    authorization,
    requestWbFetch,
    writer,
    productLimitTotal = DEFAULT_RETURNED_PRODUCTS,
    productNmIds,
}) => {
    validateAuthorizedJobLimits(authorization);
    const projection = { productLimitTotal, productNmIds };
    let result;
    if (authorization.jobType === 'search_by_query') {
        result = await executeSearchJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
            projection,
        });
    } else if (authorization.jobType === 'product_card') {
        result = await executeProductCardJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
        });
    } else if (authorization.jobType === 'recommendations_by_product') {
        result = await executeRecommendationsJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
            projection,
        });
    } else {
        throw new Error(`Unsupported browser_job type: ${authorization.jobType}`);
    }
    return {
        ...result,
        jobType: authorization.jobType,
        jobId: authorization.job.jobId,
        authorizationId: authorization.authorizationId,
        expiresAt: authorization.expiresAt,
    };
};
