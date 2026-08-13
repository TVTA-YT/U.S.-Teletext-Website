async function renderTotalRecordCount() {
    const countEl = document.getElementById("total-record-count");
    if (!countEl) return;

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
        countEl.textContent = total.toLocaleString();


    } catch (error) {
        countEl.textContent = '-';
        console.error('Could not load total record count;', err);
    }
}

document.addEventListener('DOMContentLoaded', renderTotalRecordCount)