import {
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
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
            'Execute one signed browser_job JWT through the local e-Comet extension over WebSocket. Call the remote e-Comet browser_job tool first, then pass its exact trigger_url here. WB responses stay local.',
        inputSchema: {
            type: 'object',
            properties: {
                triggerUrl: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 131072,
                    description: 'The exact trigger_url or raw JWT returned by the remote e-Comet browser_job tool.',
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
            required: ['triggerUrl'],
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
