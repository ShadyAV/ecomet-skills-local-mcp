import {
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    MAX_IMAGE_ARTICLES,
    MAX_IMAGE_BASKET,
    MAX_IMAGE_PHOTOS,
    MAX_PRODUCT_ARTICLES,
    MAX_RECOMMENDATION_ARTICLES,
    MAX_RECOMMENDATION_PAGES,
    MAX_REQUEST_TIMEOUT_MS,
    MAX_RETURNED_PRODUCTS,
    MAX_SEARCH_PAGES,
    MAX_SEARCH_QUERIES,
    MIN_REQUEST_TIMEOUT_MS,
} from './config.mjs';

export const tools = [
    {
        name: 'local_bridge_status',
        description: 'Check whether the local e-Comet Chrome extension is connected to this MCP server.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
        name: 'local_wb_fetch',
        description:
            'Diagnostic tool: run one Wildberries HTTPS GET through the local e-Comet Chrome extension. Prefer a typed WB tool. The full response stays on disk.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'An HTTPS URL on wildberries.ru, wb.ru, or one of their subdomains.' },
                timeout: { type: 'number', minimum: 1000, maximum: 120000 },
            },
            required: ['url'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
        name: 'wb_product_card',
        description:
            'Read live Wildberries product-card data for 1-20 article IDs through the local e-Comet extension. Full WB responses are saved locally as NDJSON; the tool returns only a compact summary.',
        inputSchema: {
            type: 'object',
            properties: {
                nmIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_PRODUCT_ARTICLES,
                    uniqueItems: true,
                    items: { type: 'integer', minimum: 1 },
                },
                timeout: { type: 'number', minimum: MIN_REQUEST_TIMEOUT_MS, maximum: MAX_REQUEST_TIMEOUT_MS },
            },
            required: ['nmIds'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
        name: 'wb_search_by_query',
        description:
            'Read live Wildberries search results through the local e-Comet extension. Fetches at most 50 pages, saves full responses locally, and returns compact products or matches.',
        inputSchema: {
            type: 'object',
            properties: {
                queries: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_SEARCH_QUERIES,
                    items: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', minLength: 1, maxLength: 300 },
                            pages: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_PAGES },
                        },
                        required: ['query', 'pages'],
                        additionalProperties: false,
                    },
                },
                productLimitTotal: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_RETURNED_PRODUCTS,
                    default: DEFAULT_RETURNED_PRODUCTS,
                },
                productNmIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_PRODUCT_ARTICLES,
                    uniqueItems: true,
                    items: { type: 'integer', minimum: 1 },
                },
                timeout: { type: 'number', minimum: MIN_REQUEST_TIMEOUT_MS, maximum: MAX_REQUEST_TIMEOUT_MS },
            },
            required: ['queries'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
        name: 'wb_recommendations_by_product',
        description:
            'Read live Wildberries recommendation shelves through the local e-Comet extension. Omit pages to fetch the full discovered shelf; full responses stay in local NDJSON.',
        inputSchema: {
            type: 'object',
            properties: {
                articles: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_RECOMMENDATION_ARTICLES,
                    items: {
                        type: 'object',
                        properties: {
                            nmId: { type: 'integer', minimum: 1 },
                            pages: { type: 'integer', minimum: 1, maximum: MAX_RECOMMENDATION_PAGES },
                        },
                        required: ['nmId'],
                        additionalProperties: false,
                    },
                },
                productLimitTotal: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_RETURNED_PRODUCTS,
                    default: DEFAULT_RETURNED_PRODUCTS,
                },
                productNmIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_PRODUCT_ARTICLES,
                    uniqueItems: true,
                    items: { type: 'integer', minimum: 1 },
                },
                timeout: { type: 'number', minimum: MIN_REQUEST_TIMEOUT_MS, maximum: MAX_REQUEST_TIMEOUT_MS },
            },
            required: ['articles'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
        name: 'wb_product_images',
        description:
            'Resolve public Wildberries product image URLs locally without sending WB data through e-Comet servers or the Chrome extension.',
        inputSchema: {
            type: 'object',
            properties: {
                nmIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_IMAGE_ARTICLES,
                    uniqueItems: true,
                    items: { type: 'integer', minimum: 10000, maximum: 9999999999 },
                },
                maxPhotos: { type: 'integer', minimum: 1, maximum: MAX_IMAGE_PHOTOS, default: DEFAULT_IMAGE_PHOTOS },
                maxBasket: { type: 'integer', minimum: 1, maximum: MAX_IMAGE_BASKET, default: MAX_IMAGE_BASKET },
                size: { type: 'string', enum: ['big', 'tm'], default: 'big' },
                timeout: { type: 'number', minimum: 1000, maximum: 30000, default: 5000 },
            },
            required: ['nmIds'],
            additionalProperties: false,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
];
