importScripts('naplps-font.js', 'nabts.js');

self.addEventListener('message', ({ data: { bytes, grid } }) => {
    try {
        const reportProgress = (packetsRead, packetCount) => {
            self.postMessage({ type: 'progress', done: packetsRead, total: packetCount });
        }

        const { records, summary } = NABTS.readT33(new Uint8Array(bytes), reportProgress);

        NABTS.interpret(records, grid);
        self.postMessage({ type: 'done', records, summary });
    } catch (error) {
        self.postMessage({ type: 'error', message: String(error?.message ?? error) });
    }
});