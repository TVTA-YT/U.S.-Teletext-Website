async function renderTotalRecordCount() {
    const teletextCountEl = document.getElementById("total-record-count");
    const nonTeletextCountEl = document.getElementById("total-record-count-non-teletext");
    const teletextSampleCountEl = document.getElementById("available-sample-count");
    const nonTeletextSampleCountEl = document.getElementById("available-sample-count-non-teletext");
    const electraCountEl = document.getElementById("electra-count");
    const extravisionCountEl = document.getElementById("extravision-count");
    const nbcTeletextCountEl = document.getElementById("nbc-teletext-count");
    const abcPlusCountEl = document.getElementById("abc-plus-count");
    const ketAgtextCountEl = document.getElementById("ket-agtext-count");
    const wisconsinInfotextCountEl = document.getElementById("wisconsin-infotext-count");
    const iptvAgidsCountEl = document.getElementById("iptv-agids-count");
    if (!teletextCountEl && !teletextSampleCountEl && !nonTeletextCountEl && !nonTeletextSampleCountEl) return;

    const jsonFiles = [
        '../json/electra_data.json',
        '../json/extravision_data.json',
        '../json/nbc_teletext_data.json',
        '../json/abc_plus_data.json',
        '../json/ket_agtext_data.json',
        '../json/wisconsin_infotext_data.json',
        '../json/iptv_agids_data.json',
    ];

    try {
        const responses = await Promise.all(
            jsonFiles.map(path => fetch(path).then(r => {
                if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
                return r.json();
            }))
        );

        const teletextResponses = responses.slice(0, 3);
        const nonTeletextResponses = responses.slice(3, 5);

        const teletextTotal = teletextResponses.reduce((sum, rows) => sum + rows.length, 0)
        const teletextAvailableSamples = teletextResponses.reduce((sum, rows) => sum + rows.filter(row => row.Download_Link != null && String(row.Download_Link).trim() !== '').length, 0);

        const nonTeletextTotal = nonTeletextResponses.reduce((sum, rows) => sum + rows.length, 0);
        const nonTeletextAvailableSamples = nonTeletextResponses.reduce((sum, rows) => sum + rows.filter(row => (row.HTML_Link != null && String(row.HTML_Link).trim() != '') || (row.TEXT1 != null && String(row.TEXT1).trim() != '')).length, 0);

        const electraSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Service_Name === 'Electra' && row.Download_Link != null && String(row.Download_Link).trim() !== '').length, 0);
        const extravisionSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Service_Name === 'CBS ExtraVision' && row.Download_Link != null && String(row.Download_Link).trim() !== '').length, 0);
        const nbcTeletextSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Service_Name === 'NBC Teletext' && row.Download_Link != null && String(row.Download_Link).trim() !== '').length, 0);
        const abcPlusSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Service_Name === 'ABC-PLUS' && row.TEXT1 != null && String(row.TEXT1).trim() !== '').length, 0);
        const ketAgtextSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Service_Name === 'AGTEXT' && row.HTML_Link != null && String(row.HTML_Link).trim() !== '').length, 0);
        const wisconsinInfotextSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Service_Name === 'WISINFOTEXT' && row.TEXT1 != null && String(row.TEXT1).trim() !== '').length, 0);
        const iptvAgidsSamples = responses.reduce((sum, rows) => sum + rows.filter(row => row.Service_Name === 'IPTV-AGIDS' && row.TEXT1 != null && String(row.TEXT1).trim() !== '').length, 0);


        if (teletextCountEl) {
            teletextCountEl.textContent = teletextTotal.toLocaleString();
        }

        if (teletextSampleCountEl) {
            teletextSampleCountEl.textContent = teletextAvailableSamples.toLocaleString();
        }

        if (nonTeletextCountEl) {
            nonTeletextCountEl.textContent = nonTeletextTotal.toLocaleString();
        }

        if (nonTeletextSampleCountEl) {
            nonTeletextSampleCountEl.textContent = nonTeletextAvailableSamples.toLocaleString();
        }

        if (electraCountEl) {
            electraCountEl.textContent = electraSamples.toLocaleString();
        }

        if (extravisionCountEl) {
            extravisionCountEl.textContent = extravisionSamples.toLocaleString();
        }

        if (nbcTeletextCountEl) {
            nbcTeletextCountEl.textContent = nbcTeletextSamples.toLocaleString();
        }

        if (abcPlusCountEl) {
            abcPlusCountEl.textContent = abcPlusSamples.toLocaleString();
        }

        if (ketAgtextCountEl) {
            ketAgtextCountEl.textContent = ketAgtextSamples.toLocaleString();
        }

        if (wisconsinInfotextCountEl) {
            wisconsinInfotextCountEl.textContent = wisconsinInfotextSamples.toLocaleString();
        }

        if (iptvAgidsCountEl) {
            iptvAgidsCountEl.textContent = iptvAgidsSamples.toLocaleString();
        }


    } catch (error) {
        if (teletextCountEl) teletextCountEl.textContent = '-';
        if (teletextSampleCountEl) teletextSampleCountEl.textContent = '-';
        if (nonTeletextCountEl) nonTeletextCountEl.textContent = '-';
        if (nonTeletextSampleCountEl) nonTeletextSampleCountEl.textContent = '-';
        if (electraCountEl) electraCountEl.textContent = '-';
        if (extravisionCountEl) extravisionCountEl.textContent = '-';
        if (nbcTeletextCountEl) nbcTeletextCountEl.textContent = '-';
        if (ketAgtextCountEl) ketAgtextCountEl.textContent = '-';
        if (abcPlusCountEl) abcPlusCountEl.textContent = '-';
        if (wisconsinInfotextCountEl) wisconsinInfotextCountEl.textContent = '-';
        if (iptvAgidsCountEl) iptvAgidsCountEl.textContent = '-';
        console.error('Could not load total record/sample count;', error);
    }
}

document.addEventListener('DOMContentLoaded', renderTotalRecordCount)