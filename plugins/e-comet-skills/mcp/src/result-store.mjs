import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    RESULT_DIR,
    RESULT_MAX_FILE_BYTES,
    RESULT_MAX_FILES,
    RESULT_MAX_TOTAL_BYTES,
    RESULT_RETENTION_MS,
} from './config.mjs';

const safeFilePart = (value) => value.replace(/[^a-zA-Z0-9_-]/g, '_');

export const summarizeBody = (body) => {
    if (Array.isArray(body)) return { type: 'array', length: body.length };
    if (body && typeof body === 'object') return { type: 'object', keys: Object.keys(body).slice(0, 30) };
    const preview = typeof body === 'string' ? body.slice(0, 300) : body;
    return { type: body === null ? 'null' : typeof body, preview };
};

const normalizeError = (error) => (error instanceof Error ? error : new Error(String(error)));

export const pruneResults = async ({
    resultDir = RESULT_DIR,
    now = Date.now(),
    retentionMs = RESULT_RETENTION_MS,
    maxTotalBytes = RESULT_MAX_TOTAL_BYTES,
    maxFiles = RESULT_MAX_FILES,
    excludePaths = [],
} = {}) => {
    const errors = [];
    const excluded = new Set(excludePaths);
    await mkdir(resultDir, { recursive: true });
    let entries;
    try {
        entries = await readdir(resultDir, { withFileTypes: true });
    } catch (error) {
        return [normalizeError(error)];
    }

    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue;
        const path = join(resultDir, entry.name);
        try {
            const metadata = await stat(path);
            if (!excluded.has(path) && now - metadata.mtimeMs > retentionMs) {
                await rm(path, { force: true });
            } else {
                files.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs });
            }
        } catch (error) {
            errors.push(normalizeError(error));
        }
    }

    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let totalBytes = files.reduce((total, file) => total + file.size, 0);
    let totalFiles = files.length;
    for (const file of files) {
        if (totalBytes <= maxTotalBytes && totalFiles <= maxFiles) break;
        if (excluded.has(file.path)) continue;
        try {
            await rm(file.path, { force: true });
            totalBytes -= file.size;
            totalFiles -= 1;
        } catch (error) {
            errors.push(normalizeError(error));
        }
    }
    return errors;
};

export const saveResult = async (requestId, response) => {
    const serialized = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(serialized) > RESULT_MAX_FILE_BYTES) {
        throw new Error(`Result exceeds the ${RESULT_MAX_FILE_BYTES}-byte per-file limit`);
    }
    await pruneResults();
    const resultPath = join(RESULT_DIR, `${safeFilePart(requestId)}.ndjson`);
    await writeFile(resultPath, serialized, 'utf8');
    await pruneResults({ excludePaths: [resultPath] });
    return resultPath;
};

export const createJobWriter = async (
    jobId,
    {
        resultDir = RESULT_DIR,
        append = appendFile,
        maxFileBytes = RESULT_MAX_FILE_BYTES,
        retentionMs = RESULT_RETENTION_MS,
        maxTotalBytes = RESULT_MAX_TOTAL_BYTES,
        maxFiles = RESULT_MAX_FILES,
    } = {}
) => {
    await mkdir(resultDir, { recursive: true });
    const retentionOptions = { resultDir, retentionMs, maxTotalBytes, maxFiles };
    const writeErrors = await pruneResults(retentionOptions);
    const resultPath = join(resultDir, `${safeFilePart(jobId)}.ndjson`);
    await writeFile(resultPath, '', 'utf8');
    let writeChain = Promise.resolve();
    let persistedBytes = 0;
    let fileLimitReached = false;
    return {
        resultPath,
        append(record) {
            writeChain = writeChain.then(async () => {
                try {
                    const serialized = `${JSON.stringify(record)}\n`;
                    const nextBytes = Buffer.byteLength(serialized);
                    if (persistedBytes + nextBytes > maxFileBytes) {
                        if (!fileLimitReached) {
                            fileLimitReached = true;
                            writeErrors.push(new Error(`Result exceeds the ${maxFileBytes}-byte per-file limit`));
                        }
                        return;
                    }
                    await append(resultPath, serialized, 'utf8');
                    persistedBytes += nextBytes;
                } catch (error) {
                    writeErrors.push(normalizeError(error));
                }
            });
            return writeChain;
        },
        async close() {
            await writeChain;
            writeErrors.push(...(await pruneResults({ ...retentionOptions, excludePaths: [resultPath] })));
            return [...writeErrors];
        },
    };
};
