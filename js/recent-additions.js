async function renderRecentAdditions() {
    const container = document.getElementById("recent-additions");
    if (!container) return;

    const API_URL =
        "https://us-teletext-website.us-teletext-archive.workers.dev/api/recent-additions";

    const serviceImages = {
        "ABC-PLUS": "images/ABC_white.png",
        "AGTEXT": "images/KET_white.png",
        "DaTaVizion": "images/DaTaVizion_white.png",
        "Electra": "images/Electra_white.png",
        "CBS ExtraVision": "images/ExtraVision_white.png",
        "IPTV-AGIDS": "images/IPTV_white.png",
        "Keyfax": "images/Keyfax_white.png",
        "NBC Teletext": "images/NBC-Teletext_white.png",
        "PENNTEXT": "images/PPTN_white.png",
        "SSS Teletext": "images/SSS_white.png",
        "WISINFOTEXT": "images/WHA_white.png",
    };

    // Replace service name string with the image for each service (or network/station logo for text services)
    function getServiceImage(serviceName) {
        return serviceImages[serviceName] || "";
    }

    // Convert service name to lowercase name that will be used for CSS. Remove space and add hyphen if necessary (e.g. "CBS ExtraVision" becomes "cbs-extravision")
    function serviceNameToClass(serviceName) {
        return String(serviceName ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "").replace(/-+/g, "-");
    }

    function hasRealValue(value) {
        if (value === null || value === undefined) return false;

        const trimmed = String(value).trim();

        return (
            trimmed !== "" &&
            trimmed.toLowerCase() !== "null" &&
            trimmed.toLowerCase() !== "n/a"
        );
    }

    try {
        const response = await fetch(API_URL);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const recent = await response.json();

        if (!Array.isArray(recent)) {
            throw new Error("API response was not an array");
        }

        if (recent.length === 0) {
            container.innerHTML = "<p>No recent additions found.</p>";
            return;
        }

        const rowsHtml = recent
            .map((row) => {
                const serviceName = hasRealValue(row.Service_Name)
                    ? String(row.Service_Name).trim()
                    : "";

                const serviceImage = getServiceImage(serviceName);
                const serviceClass = serviceNameToClass(serviceName);

                // Link to the specific teletext sample when an IA_ID exists.
                const sampleDate = hasRealValue(row.IA_ID)
                    ? `<a href="html/teletext-sample-image-gallery.html?stream=${encodeURIComponent(row.IA_ID)}" class="text-white fw-bold">${escHtml(row.Date)}</a>`
                    : escHtml(row.Date);

                const logoHtml = serviceImage
                    ? `<img src="${escHtml(serviceImage)}" alt="${escHtml(serviceName)}" class="mw-100 ${escHtml(serviceClass)}-logo" loading="lazy" />`
                    : escHtml(serviceName);

                return `
                <tr>
                    <td class="additions-table-logo-row">${logoHtml}</td>
                    <td>${sampleDate}</td>
                    <td>${escHtml(row.Date_Added)}</td>
                    <td>${escHtml(row.Recovered_By)}</td>
                </tr>
            `;
            })
            .join("");

        container.innerHTML = `
        <div class="table-responsive">
            <table class="table table-bordered table-custom-blue table-striped align-middle text-center text-white">
                <thead>
                    <tr class="align-middle">
                        <th scope="col" style="width: 25%">Service</th>
                        <th scope="col">Sample Date</th>
                        <th scope="col">Date Added</th>
                        <th scope="col">Contributor</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `;
    } catch (error) {
        container.innerHTML = "<p>Could not load recent additions.</p>";

        console.error("Could not load recent additions:", error);
    }

    function escHtml(value) {
        if (value === null || value === undefined) return "";

        const div = document.createElement("div");
        div.textContent = String(value);

        return div.innerHTML;
    }
}

document.addEventListener("DOMContentLoaded", renderRecentAdditions);