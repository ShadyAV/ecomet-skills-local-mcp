import { randomUUID } from 'node:crypto';

import {
    BRIDGE_VERSION,
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    IMAGE_CONCURRENCY,
    LATEST_MCP_PROTOCOL_VERSION,
    MAX_IMAGE_BASKET,
    SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from './config.mjs';
import { executeAuthorizedBrowserJob, extractBrowserJobToken, validateAuthorizedJobLimits } from './browser-job.mjs';
import { mcpError, mcpResult, textResult } from './mcp-protocol.mjs';
import { createJobWriter } from './result-store.mjs';
import { serverInstructions, tools, validateToolArguments } from './tool-catalog.mjs';
import { ToolExecutionError, toolFailure } from './tool-errors.mjs';
import { discoverImageBasket, imageExists, normalizeStatus, runWithConcurrency } from './wb-domain.mjs';

export const createMcpMessageHandler = ({
    getBridgeStatus,
    isExtensionReady,
    requestBrowserJobAuthorization,
    requestWbFetch,
    sendError = mcpError,
    sendResult = mcpResult,
}) => {
    const handleBrowserJob = async (id, toolName, expectedJobType, args = {}) => {
        const triggerUrl = args.triggerUrl;
        const productLimitTotal = args.productLimitTotal ?? DEFAULT_RETURNED_PRODUCTS;
        const productNmIds = args.productNmIds;
        if (!validateToolArguments(toolName, args)) {
            sendResult(
                id,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'INVALID_TOOL_ARGUMENTS',
                            `Invalid ${toolName} arguments.`,
                            'arguments',
                            false
                        )
                    ),
                    true
                )
            );
            return;
        }
        if (typeof triggerUrl !== 'string' || !triggerUrl) {
            sendResult(
                id,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'BROWSER_JOB_HANDOFF_REQUIRED',
                            'Browser authorization handoff is required.',
                            'handoff',
                            true
                        )
                    ),
                    true
                )
            );
            return;
        }
        let writer;
        try {
            if (!isExtensionReady()) {
                throw new Error('The e-Comet Chrome extension is not connected');
            }
            const token = extractBrowserJobToken(triggerUrl);
            const authorization = await requestBrowserJobAuthorization(token);
            if (
                !authorization ||
                typeof authorization.authorizationId !== 'string' ||
                typeof authorization.jobType !== 'string' ||
                !authorization.job ||
                typeof authorization.job !== 'object'
            ) {
                throw new Error('Extension returned an invalid browser job authorization');
            }
            if (authorization.jobType !== expectedJobType) {
                throw new ToolExecutionError(
                    'BROWSER_JOB_TYPE_MISMATCH',
                    `Signed ${authorization.jobType} job cannot be executed as ${toolName}.`,
                    'authorization',
                    false
                );
            }
            validateAuthorizedJobLimits(authorization);
            try {
                writer = await createJobWriter(authorization.job.jobId);
            } catch (error) {
                throw new ToolExecutionError(
                    'LOCAL_STORAGE_FAILED',
                    'The local result file could not be created.',
                    'storage',
                    true,
                    { cause: error }
                );
            }
            const result = await executeAuthorizedBrowserJob({
                authorization,
                requestWbFetch,
                writer,
                productLimitTotal,
                productNmIds,
            });
            const writeErrors = await writer.close();
            sendResult(
                id,
                textResult(
                    {
                        ...result,
                        resultPath: writer.resultPath,
                        ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
                    },
                    !result.ok
                )
            );
        } catch (error) {
            if (writer) {
                await writer.close().catch(() => undefined);
            }
            sendResult(id, textResult(toolFailure(error, {
                code: 'BROWSER_JOB_EXECUTION_FAILED',
                message: 'The authorized Wildberries job could not be completed.',
                stage: 'execution',
                retryable: false,
            }), true));
        }
    };

    const handleProductImages = async (id, args = {}) => {
        const nmIds = args.nmIds;
        const maxPhotos = args.maxPhotos ?? DEFAULT_IMAGE_PHOTOS;
        const maxBasket = args.maxBasket ?? MAX_IMAGE_BASKET;
        const size = args.size ?? 'big';
        const timeout = args.timeout ?? 5000;
        if (!validateToolArguments('wb_product_images', args)) {
            sendResult(
                id,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'INVALID_TOOL_ARGUMENTS',
                            'Invalid wb_product_images arguments.',
                            'arguments',
                            false
                        )
                    ),
                    true
                )
            );
            return;
        }

        const jobId = randomUUID();
        try {
            const writer = await createJobWriter(jobId);
            let activeImageProbes = 0;
            const queuedImageProbes = [];
            const limitedImageExists = async (url, probeTimeout) => {
                if (activeImageProbes >= IMAGE_CONCURRENCY) {
                    await new Promise((resolve) => queuedImageProbes.push(resolve));
                }
                activeImageProbes += 1;
                try {
                    return await imageExists(url, probeTimeout);
                } finally {
                    activeImageProbes -= 1;
                    queuedImageProbes.shift()?.();
                }
            };
            const products = await runWithConcurrency(nmIds, IMAGE_CONCURRENCY, async (nmId) => {
                const discovered = await discoverImageBasket(nmId, maxBasket, size, timeout, limitedImageExists);
                if (!discovered) {
                    const result = { nmId, status: 'not_found', imageUrls: [] };
                    await writer.append(result);
                    return result;
                }
                const imageUrls = (
                    await runWithConcurrency(
                        Array.from({ length: maxPhotos }, (_, index) => index + 1),
                        IMAGE_CONCURRENCY,
                        async (photo) => {
                            const url = `${discovered.baseUrl}/${size}/${photo}.webp`;
                            return (await limitedImageExists(url, timeout)) ? url : null;
                        }
                    )
                ).filter(Boolean);
                const result = {
                    nmId,
                    status: imageUrls.length > 0 ? 'ok' : 'not_found',
                    basket: discovered.basket,
                    baseUrl: discovered.baseUrl,
                    imageUrls,
                };
                await writer.append(result);
                return result;
            });
            const writeErrors = await writer.close();
            const succeeded = products.filter((product) => product.status === 'ok').length;
            sendResult(
                id,
                textResult({
                    ok: succeeded > 0,
                    status: normalizeStatus(succeeded, products.length),
                    jobId,
                    total: products.length,
                    succeeded,
                    failed: products.length - succeeded,
                    size,
                    products,
                    resultPath: writer.resultPath,
                    ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
                })
            );
        } catch (error) {
            sendResult(
                id,
                textResult(
                    toolFailure(error, {
                        code: 'IMAGE_LOOKUP_FAILED',
                        message: 'The Wildberries image lookup could not be completed.',
                        stage: 'images',
                        retryable: true,
                    }),
                    true
                )
            );
        }
    };

    const toolHandlers = new Map([
        ['local_bridge_status', async (id) => sendResult(id, textResult({ ok: true, ...getBridgeStatus() }))],
        ['wb_product_card', (id, args) => handleBrowserJob(id, 'wb_product_card', 'product_card', args)],
        ['wb_search_by_query', (id, args) => handleBrowserJob(id, 'wb_search_by_query', 'search_by_query', args)],
        [
            'wb_recommendations_by_product',
            (id, args) => handleBrowserJob(id, 'wb_recommendations_by_product', 'recommendations_by_product', args),
        ],
        ['wb_product_images', (id, args) => handleProductImages(id, args)],
    ]);

    return async (message) => {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            if (message?.id !== undefined) sendError(message.id, -32600, 'Invalid Request');
            return;
        }

        const { id, method, params } = message;
        if (method === 'notifications/initialized' || id === undefined) return;
        if (method === 'initialize') {
            const requestedProtocolVersion = params?.protocolVersion;
            sendResult(id, {
                protocolVersion: SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedProtocolVersion)
                    ? requestedProtocolVersion
                    : LATEST_MCP_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'e-comet-local-bridge', version: BRIDGE_VERSION },
                instructions: serverInstructions,
            });
            return;
        }
        if (method === 'ping') {
            sendResult(id, {});
            return;
        }
        if (method === 'tools/list') {
            sendResult(id, { tools });
            return;
        }
        if (method !== 'tools/call') {
            sendError(id, -32601, `Method not found: ${method}`);
            return;
        }

        const handler = toolHandlers.get(params?.name);
        if (!handler) {
            sendError(id, -32602, `Unknown tool: ${params?.name}`);
            return;
        }
        await handler(id, params?.arguments);
    };
};
