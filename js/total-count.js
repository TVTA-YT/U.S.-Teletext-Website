// Fetch total and available-sample counts from the API
// and display them in their respective elements.
async function renderTotalRecordCount() {
    const teletextCountEl = document.getElementById("total-record-count");
    const nonTeletextCountEl = document.getElementById("total-record-count-non-teletext");
    const teletextSampleCountEl = document.getElementById("available-sample-count");
    const nonTeletextSampleCountEl = document.getElementById("available-sample-count-non-teletext");

    const datavizionCountEl = document.getElementById("datavizion-count");
    const electraCountEl = document.getElementById("electra-count");
    const extravisionCountEl = document.getElementById("extravision-count");
    const keyfaxCountEl = document.getElementById("keyfax-count");
    const nbcTeletextCountEl = document.getElementById("nbc-teletext-count");
    const sssTeletextCountEl = document.getElementById("sss-teletext-count");

    const abcPlusCountEl = document.getElementById("abc-plus-count");
    const ketAgtextCountEl = document.getElementById("ket-agtext-count");
    const wisconsinInfotextCountEl = document.getElementById("wisconsin-infotext-count");
    const iptvAgidsCountEl = document.getElementById("iptv-agids-count");

    // Don't make an API request if none of the count elements exist.
    const countElements = [
        teletextCountEl,
        nonTeletextCountEl,
        teletextSampleCountEl,
        nonTeletextSampleCountEl,
        datavizionCountEl,
        electraCountEl,
        extravisionCountEl,
        keyfaxCountEl,
        nbcTeletextCountEl,
        sssTeletextCountEl,
        abcPlusCountEl,
        ketAgtextCountEl,
        wisconsinInfotextCountEl,
        iptvAgidsCountEl
    ];

    if (!countElements.some(Boolean)) return;

    const API_URL = "https://us-teletext-website.us-teletext-archive.workers.dev/api/counts";

    try {
        const response = await fetch(API_URL);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const counts = await response.json();

        /*
         * Overall Teletext counts
         *
         * Expected API structure:
         *
         * counts.teletext.total
         * counts.teletext.availableSamples
         */
        const teletextTotal = Number(
            counts.teletext?.total ?? 0
        );

        const teletextAvailableSamples = Number(
            counts.teletext?.availableSamples ?? 0
        );

        /*
         * Overall non-Teletext counts
         */
        const nonTeletextTotal = Number(
            counts.nonTeletext?.total ?? 0
        );

        const nonTeletextAvailableSamples = Number(
            counts.nonTeletext?.availableSamples ?? 0
        );

        /*
         * Individual dataset counts
         *
         * Expected API structure:
         *
         * counts.datasets.datavizion.total
         * counts.datasets.datavizion.availableSamples
         */
        const datasetCounts = counts.datasets ?? {};

        const datavizionSamples = Number(
            datasetCounts.datavizion?.availableSamples ?? 0
        );

        const electraSamples = Number(
            datasetCounts.electra?.availableSamples ?? 0
        );

        const extravisionSamples = Number(
            datasetCounts.extravision?.availableSamples ?? 0
        );

        const keyfaxSamples = Number(
            datasetCounts.keyfax?.availableSamples ?? 0
        );

        const nbcTeletextSamples = Number(
            datasetCounts.nbcTeletext?.availableSamples ?? 0
        );

        const sssTeletextSamples = Number(
            datasetCounts.sssTeletext?.availableSamples ?? 0
        );

        const abcPlusSamples = Number(
            datasetCounts.abcPlus?.availableSamples ?? 0
        );

        const ketAgtextSamples = Number(
            datasetCounts.ketAgtext?.availableSamples ?? 0
        );

        const wisconsinInfotextSamples = Number(
            datasetCounts.wisconsinInfotext?.availableSamples ?? 0
        );

        const iptvAgidsSamples = Number(
            datasetCounts.iptvAgids?.availableSamples ?? 0
        );


        /* --------------------------------------------------
           Display overall counts
        -------------------------------------------------- */

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


        /* --------------------------------------------------
           Display individual dataset sample counts
        -------------------------------------------------- */

        if (datavizionCountEl) {
            datavizionCountEl.textContent = datavizionSamples.toLocaleString();
        }

        if (electraCountEl) {
            electraCountEl.textContent = electraSamples.toLocaleString();
        }

        if (extravisionCountEl) {
            extravisionCountEl.textContent = extravisionSamples.toLocaleString();
        }

        if (keyfaxCountEl) {
            keyfaxCountEl.textContent = keyfaxSamples.toLocaleString();
        }

        if (nbcTeletextCountEl) {
            nbcTeletextCountEl.textContent = nbcTeletextSamples.toLocaleString();
        }

        if (sssTeletextCountEl) {
            sssTeletextCountEl.textContent = sssTeletextSamples.toLocaleString();
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
        // Display "-" if the API cannot be reached.
        countElements.forEach((element) => {
            if (element) {
                element.textContent = "-";
            }
        });

        console.error("Could not load total record/sample count:", error);
    }
}

document.addEventListener("DOMContentLoaded", renderTotalRecordCount);
