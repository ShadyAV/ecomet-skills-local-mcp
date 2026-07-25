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
        name: 'execute_browser_job',
        description:
            'Execute the browser job prepared by the immediately preceding remote e-Comet browser_job call. In Codex, pass the authorization inside the same atomic exec; in Claude, the plugin hook injects it. WB responses stay local.',
        inputSchema: {
            type: 'object',
            properties: {
                triggerUrl: {
                    type: 'string',
                    minLength: 1,
                    maxLength: MAX_BROWSER_JOB_TOKEN_BYTES,
                    description:
                        'Passed programmatically by the Codex atomic exec or injected by the trusted Claude hook. Never reproduce it as model-authored text.',
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
            },
            required: [],
            additionalProperties: false,
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
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
