import {
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    MAX_IMAGE_ARTICLES,
    MAX_IMAGE_BASKET,
    MAX_IMAGE_PHOTOS,
    MAX_PRODUCT_ARTICLES,
    MAX_RETURNED_PRODUCTS,
} from './config.mjs';

const triggerUrlProperty = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
    description:
        'Passed programmatically by the Codex atomic exec or injected by the trusted Claude hook. Never reproduce it as model-authored text.',
};

const projectionProperties = {
    productLimitTotal: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RETURNED_PRODUCTS,
        default: DEFAULT_RETURNED_PRODUCTS,
        description: 'Maximum number of compact products returned for each query or source article.',
    },
    productNmIds: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PRODUCT_ARTICLES,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1 },
        description: 'Return only these WB article IDs instead of the default top-product projection.',
    },
};

const liveToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

const liveInputSchema = (includeProjection = false) => ({
    type: 'object',
    properties: {
        triggerUrl: triggerUrlProperty,
        ...(includeProjection ? projectionProperties : {}),
    },
    required: [],
    additionalProperties: false,
});

const liveOutputSchema = (collectionName) => ({
    type: 'object',
    properties: {
        ok: { type: 'boolean' },
        status: { type: 'string', enum: ['ok', 'partial', 'failed'] },
        jobType: { type: 'string' },
        jobId: { type: 'string' },
        resultPath: { type: 'string' },
        [collectionName]: { type: 'array' },
    },
    required: ['ok'],
    additionalProperties: true,
});

export const tools = [
    {
        name: 'local_bridge_status',
        description: 'Check whether the local e-Comet Chrome extension is connected to this MCP server.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: 'wb_product_card',
        description:
            'Get live Wildberries product-card data by article ID: price, rating, stock by named warehouse and size, description, characteristics, and merged articles. This typed local tool owns the workflow: select it based on user intent, then obtain its authorization prerequisite by calling the remote e-Comet browser_job exactly once with job {type:"product_card",articles:[integer,...]}, and immediately invoke this tool. In Codex, keep both calls in one atomic exec and pass structuredContent.trigger_url only through a local variable. In Claude, invoke this tool without triggerUrl so the trusted hook injects it. Never decode, print, edit, or manually copy the JWT. Do not infer authorization failure from client status: attempt the actual remote call, retry tool discovery up to three times if necessary, and report only its confirmed error in user-friendly language. The result is a current WB-session snapshot; use products and report partial item errors without claiming a missing product after a network failure. resultPath is only a fallback for the current call when the compact result is insufficient, not a cache.',
        inputSchema: liveInputSchema(false),
        outputSchema: liveOutputSchema('products'),
        annotations: liveToolAnnotations,
    },
    {
        name: 'wb_search_by_query',
        description:
            'Get live Wildberries search results, top products, and global positions for one or more phrases. This typed local tool owns the workflow: select it based on user intent, then obtain its authorization prerequisite by calling the remote e-Comet browser_job exactly once with job {type:"search_by_query",queries:[{query:string,pages:integer},...]}, and immediately invoke this tool. Use at most 10 queries and 50 pages total; start with 1 page for a top list or 2-3 pages when depth is unspecified. In Codex, keep both calls in one atomic exec and pass structuredContent.trigger_url only through a local variable. In Claude, invoke this tool without triggerUrl so the trusted hook injects it. Never decode, print, edit, or manually copy the JWT. Do not infer authorization failure from client status: attempt the actual remote call, retry tool discovery up to three times if necessary, and report only its confirmed error in user-friendly language. Read queries[].pages[].products and use globalPosition rather than page-local position. The result is a current WB-session snapshot; expose partial-page failures. resultPath is only a fallback for the current call when the compact result is insufficient, not a cache.',
        inputSchema: liveInputSchema(true),
        outputSchema: liveOutputSchema('queries'),
        annotations: liveToolAnnotations,
    },
    {
        name: 'wb_recommendations_by_product',
        description:
            'Get live Wildberries recommendation shelves for source article IDs and check whether specific products occur in them. This typed local tool owns the workflow: select it based on user intent, then obtain its authorization prerequisite by calling the remote e-Comet browser_job exactly once with job {type:"recommendations_by_product",articles:[{nm:integer,pages?:integer},...]}, and immediately invoke this tool. Use at most 20 articles and 60 pages per article; omit pages to request the discovered shelf up to the local cap. In Codex, keep both calls in one atomic exec and pass structuredContent.trigger_url only through a local variable. In Claude, invoke this tool without triggerUrl so the trusted hook injects it. Never decode, print, edit, or manually copy the JWT. Do not infer authorization failure from client status: attempt the actual remote call, retry tool discovery up to three times if necessary, and report only its confirmed error in user-friendly language. Read articles[].pages[].products, group by sourceNmId, use globalPosition, and disclose partial or truncatedByLocalLimit results. resultPath is only a fallback for the current call when the compact result is insufficient, not a cache.',
        inputSchema: liveInputSchema(true),
        outputSchema: liveOutputSchema('articles'),
        annotations: liveToolAnnotations,
    },
    {
        name: 'wb_product_images',
        description:
            'Find public Wildberries product image URLs by article ID. Select this tool when the user asks for WB photos, image URLs, a gallery, or batch image export. Call it directly; it needs neither remote browser_job nor the Chrome extension. Send at most 20 IDs per call and preserve input order across multiple batches. Use products[].imageUrls rather than guessing CDN URLs. status "not_found" means only that the current image-CDN probe found no photos, not that the product does not exist.',
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
                maxPhotos: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_IMAGE_PHOTOS,
                    default: DEFAULT_IMAGE_PHOTOS,
                },
                maxBasket: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_IMAGE_BASKET,
                    default: MAX_IMAGE_BASKET,
                },
                size: { type: 'string', enum: ['big', 'tm'], default: 'big' },
                timeout: {
                    type: 'number',
                    minimum: 1000,
                    maximum: 30000,
                    default: 5000,
                },
            },
            required: ['nmIds'],
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
];

const valueMatchesSchema = (value, schema) => {
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if ((schema.required || []).some((name) => !(name in value))) return false;
        if (schema.additionalProperties === false && Object.keys(value).some((name) => !(name in (schema.properties || {})))) return false;
        return Object.entries(value).every(([name, propertyValue]) => {
            const propertySchema = schema.properties?.[name];
            return !propertySchema || valueMatchesSchema(propertyValue, propertySchema);
        });
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
        if (schema.uniqueItems && new Set(value).size !== value.length) return false;
        return value.every((item) => valueMatchesSchema(item, schema.items));
    }
    if (schema.type === 'string') {
        return (
            typeof value === 'string' &&
            value.length >= (schema.minLength ?? 0) &&
            value.length <= (schema.maxLength ?? Infinity) &&
            (!schema.enum || schema.enum.includes(value))
        );
    }
    if (schema.type === 'integer') {
        return (
            Number.isSafeInteger(value) &&
            value >= (schema.minimum ?? -Infinity) &&
            value <= (schema.maximum ?? Infinity)
        );
    }
    if (schema.type === 'number') {
        return (
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= (schema.minimum ?? -Infinity) &&
            value <= (schema.maximum ?? Infinity)
        );
    }
    return true;
};

export const validateToolArguments = (name, args) => {
    const tool = tools.find((candidate) => candidate.name === name);
    return Boolean(tool && valueMatchesSchema(args, tool.inputSchema));
};
