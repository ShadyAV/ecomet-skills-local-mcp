import { MAX_MCP_MESSAGE_BYTES } from './config.mjs';

export const attachStdioTransport = ({
    input = process.stdin,
    handleMessage,
    sendError,
    maxMessageBytes = MAX_MCP_MESSAGE_BYTES,
}) => {
    let buffer = '';
    let discardingOversizedLine = false;

    input.setEncoding('utf8');
    const onData = (incomingChunk) => {
        let chunk = incomingChunk;
        if (discardingOversizedLine) {
            const newlineIndex = chunk.indexOf('\n');
            if (newlineIndex < 0) return;
            discardingOversizedLine = false;
            chunk = chunk.slice(newlineIndex + 1);
        }

        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > maxMessageBytes && !buffer.includes('\n')) {
            buffer = '';
            discardingOversizedLine = true;
            sendError(null, -32600, `MCP message exceeds ${maxMessageBytes} bytes`);
            return;
        }

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
            const rawLine = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (Buffer.byteLength(rawLine, 'utf8') > maxMessageBytes) {
                sendError(null, -32600, `MCP message exceeds ${maxMessageBytes} bytes`);
                continue;
            }
            const line = rawLine.trim();
            if (!line) continue;
            try {
                void handleMessage(JSON.parse(line));
            } catch {
                sendError(null, -32700, 'Parse error');
            }
        }
    };

    input.on('data', onData);
    return () => input.off('data', onData);
};
