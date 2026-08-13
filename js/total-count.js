async function renderTotalRecordCount() {
    const countEl = document.getElementById("total-record-count");
    const sampleCountEl = document.getElementById("available-sample-count");
    if (!countEl && !sampleCountEl) return;

    const jsonFiles = [
        '../json/electra_data.json',
        '../json/extravision_data.json',
        '../json/nbc_teletext_data.json'
    ];

    try {
        const responses = await Promise.all(
            jsonFiles.map(path => fetch(path).then(r => {
                if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
                return r.json();
            }))
        );

        const total = responses.reduce((sum, rows) => sum + rows.length, 0)

        const availableSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Download_Link != null && String(row.Download_Link).trim() !== '').length, 0);

        if (countEl) {
            countEl.textContent = total.toLocaleString();
        }

        if (sampleCountEl) {
            sampleCountEl.textContent = availableSamples.toLocaleString();
        }


    } catch (error) {
        if (countEL) countEl.textContent = '-';
        if (sampleCountEl) sampleCountEl.textContent = '-';
        console.error('Could not load total record/sample count;', err);
    }
}

document.addEventListener('DOMContentLoaded', renderTotalRecordCount)