(() => {
    const SERVICE_IMAGES = {
        "ABC-PLUS": "images/ABC_white.png",
        "AGTEXT": "images/KET_white.png",
        "CBS ExtraVision": "images/ExtraVision_white.png",
        "DaTaVizion": "images/DaTaVizion_white.png",
        "Edutel": "images/TVO_white.png",
        "Electra": "images/Electra_white.png",
        "KCET-TEXT": "images/KCET_white.png",
        "IPTV-AGIDS": "images/IPTV_white.png",
        "Keyfax": "images/Keyfax_white.png",
        "NBC Teletext": "images/NBC-Teletext_white.png",
        "PENNTEXT": "images/PPTN_white.png",
        "SSS Teletext": "images/SSS_white.png",
        "Virtext": "images/WGN9_white.png",
        "WISINFOTEXT": "images/WHA_white.png",
    };

    const VIEWER_PAGES = {
        T34: "html/teletext-viewer",
        T33: "html/nabts-viewer",
    };

    function escHtml(value) {
        if (value === null || value === undefined) return "";
        const div = document.createElement("div");
        div.textContent = String(value);
        return div.innerHTML;
    }

    function hasRealValue(value) {
        if (value === null || value === undefined) return false;
        const trimmed = String(value).trim();
        return trimmed !== "" && trimmed.toLowerCase() !== "null" && trimmed.toLowerCase() !== "n/a";
    }

    // & Does this: "CBS ExtraVision" -> "cbs-extravision"
    function serviceNameToClass(serviceName) {
        return String(serviceName ?? "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9_-]/g, "")
            .replace(/-+/g, "-");
    }

    function getServiceName(row) {
        return hasRealValue(row.Service_Name) ? String(row.Service_Name).trim() : "";
    }

    // & Logo image when one exists, otherwise the service name as text
    function renderLogoCell(row) {
        const serviceName = getServiceName(row);
        const serviceImage = SERVICE_IMAGES[serviceName] || "";

        if (!serviceImage) return escHtml(serviceName);

        const serviceClass = serviceNameToClass(serviceName);
        return `<img src="${escHtml(serviceImage)}" alt="${escHtml(serviceName)}" class="mw-100 ${escHtml(serviceClass)}-logo" loading="lazy" />`;
    }

    // & Generic fetch-and-render for a homepage "recent" table
    async function renderRecentTable({ containerId, tableId, apiUrl, caption, columns, emptyMessage, errorMessage }) {
        const container = document.getElementById(containerId);
        if (!container) return;

        try {
            const response = await fetch(apiUrl);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const rows = await response.json();
            if (!Array.isArray(rows)) throw new Error("API response was not an array");

            if (rows.length === 0) {
                container.innerHTML = `<p>${escHtml(emptyMessage)}</p>`;
                return;
            }

            const headHtml = columns
                .map((col) => {
                    const style = col.width ? ` style="width: ${col.width}"` : "";
                    return `<th scope="col"${style}>${escHtml(col.header)}</th>`;
                })
                .join("");

            const rowsHtml = rows
                .map((row) => {
                    const cells = columns
                        .map((col, i) => {
                            const cls = i === 0 ? ` class="additions-table-logo-row"` : "";
                            return `<td${cls}>${col.cell(row)}</td>`;
                        })
                        .join("");
                    return `<tr>${cells}</tr>`;
                })
                .join("");

            container.innerHTML = `
            <div class="table-responsive overflow-y-auto recent-table-scroll" id="${escHtml(tableId)}">
                <table class="table table-bordered table-custom-blue table-striped align-middle text-center text-white">
                    <caption class="sr-only">${escHtml(caption)}</caption>
                    <thead>
                        <tr class="align-middle">${headHtml}</tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;
        } catch (error) {
            container.innerHTML = `<p>${escHtml(errorMessage)}</p>`;
            console.error(`Could not load ${containerId}:`, error);
        }
    }

    // * * Recent Additions (new samples) * *

    function renderRecentAdditions() {
        return renderRecentTable({
            containerId: "recent-additions",
            tableId: "recent-additions-table",
            apiUrl: "/api/recent-additions",
            caption: "Recently added samples",
            emptyMessage: "No recent additions found.",
            errorMessage: "Could not load recent additions.",
            columns: [
                { header: "Service", width: "25%", cell: renderLogoCell },
                {
                    header: "Sample Date",
                    // Link to the gallery when an IA_ID exists
                    cell: (row) =>
                        hasRealValue(row.IA_ID)
                            ? `<a href="html/teletext-sample-image-gallery.html?stream=${encodeURIComponent(row.IA_ID)}" class="text-white fw-bold">${escHtml(row.Date)}</a>`
                            : escHtml(row.Date),
                },
                { header: "Date Added", cell: (row) => escHtml(row.Date_Added) },
                { header: "Contributor", cell: (row) => escHtml(row.Recovered_By) },
            ],
        });
    }

    // * * Recently Viewable Samples (new streams in the T33/T34 viewers) * *

    // NABTS services (Edutel, ExtraVision, NBC Teletext) go to the T33 viewer; WST services go to the T34 viewer.
    // * Viewer links: ?service=<dataset key>&sample=<IA_ID>, matching the results pages
    // Service_Name -> viewer "service" value (the Worker's dataset key) and stream format
    const SERVICE_VIEWERS = {
        "DaTaVizion": { service: "datavizion", format: "T34" },
        "Edutel": { service: "edutel", format: "T33" },
        "Electra": { service: "electra", format: "T34" },
        "CBS ExtraVision": { service: "extravision", format: "T33" },
        "Keyfax": { service: "keyfax", format: "T34" },
        "NBC Teletext": { service: "nbcTeletext", format: "T33" },
        "SSS Teletext": { service: "sssTeletext", format: "T34" },
        "Virtext": { service: "virtext", format: "T34" },
        // Add Wisconsin Infotext's teletext Service_Name here: { service: "wisconsinInfotextTeletext", format: "T34" }
    };

    function getViewerUrl(row) {
        const known = SERVICE_VIEWERS[getServiceName(row)];

        // Prefer the fields from the API when present; otherwise fall back to the Service_Name lookup
        const service = hasRealValue(row.Dataset) ? String(row.Dataset).trim() : known?.service;
        const format = hasRealValue(row.Format) ? String(row.Format).trim().toUpperCase() : known?.format;
        const page = VIEWER_PAGES[format];

        if (!page || !service || !hasRealValue(row.IA_ID)) return "";
        return `${page}?service=${encodeURIComponent(service)}&sample=${encodeURIComponent(row.IA_ID)}`;
    }

    function renderRecentViewableSamples() {
        return renderRecentTable({
            containerId: "recent-viewable-samples",
            tableId: "recent-viewable-samples-table",
            apiUrl: "/api/recent-viewable-samples",
            caption: "Samples recently made viewable in the teletext viewer",
            emptyMessage: "No newly viewable samples found.",
            errorMessage: "Could not load newly viewable samples.",
            columns: [
                { header: "Service", width: "25%", cell: renderLogoCell },
                {
                    header: "Sample Date",

                    // Link straight into the matching viewer when the stream is available
                    cell: (row) => {
                        const url = getViewerUrl(row);
                        if (!url) return escHtml(row.Date);
                        return `<a href="${escHtml(url)}" class="text-white fw-bold">${escHtml(row.Date)}<span class="sr-only">, open in teletext viewer</span></a>`;
                    },
                },
                { header: "Date Available", cell: (row) => escHtml(row.Date_Viewable) },
                { header: "Format", cell: (row) => escHtml(hasRealValue(row.Format) ? row.Format : SERVICE_VIEWERS[getServiceName(row)]?.format) },
            ],
        });
    }

    document.addEventListener("DOMContentLoaded", () => {
        renderRecentAdditions();
        renderRecentViewableSamples();
    });
})();