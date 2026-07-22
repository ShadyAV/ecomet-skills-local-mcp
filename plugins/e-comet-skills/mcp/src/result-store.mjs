import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RESULT_DIR } from './config.mjs';

const safeFilePart = (value) => value.replace(/[^a-zA-Z0-9_-]/g, '_');

export const summarizeBody = (body) => {
    if (Array.isArray(body)) return { type: 'array', length: body.length };
    if (body && typeof body === 'object') return { type: 'object', keys: Object.keys(body).slice(0, 30) };
    const preview = typeof body === 'string' ? body.slice(0, 300) : body;
    return { type: body === null ? 'null' : typeof body, preview };
};

export const saveResult = async (requestId, response) => {
    await mkdir(RESULT_DIR, { recursive: true });
    const resultPath = join(RESULT_DIR, `${safeFilePart(requestId)}.ndjson`);
    await writeFile(resultPath, `${JSON.stringify(response)}\n`, 'utf8');
    return resultPath;
};

export const createJobWriter = async (jobId) => {
    await mkdir(RESULT_DIR, { recursive: true });
    const resultPath = join(RESULT_DIR, `${safeFilePart(jobId)}.ndjson`);
    await writeFile(resultPath, '', 'utf8');
    let writeChain = Promise.resolve();
    return {
        resultPath,
        append(record) {
            writeChain = writeChain.then(() => appendFile(resultPath, `${JSON.stringify(record)}\n`, 'utf8'));
            return writeChain;
        },
        close() {
            return writeChain;
        },
    };
};
