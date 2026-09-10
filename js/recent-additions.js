async function renderRecentAdditions() {
    const container = document.getElementById("recent-additions");
    if (!container) return;

    const jsonFiles = [
        "json/datavizion_data.json",
        "json/extravision_data.json",
        "json/electra_data.json",
        "json/keyfax_data.json",
        "json/nbc_teletext_data.json",
        "json/sss_teletext_data.json",
        "json/abc_plus_data.json",
        "json/ket_agtext_data.json",
        "json/iptv_agids_data.json",
        "json/wisconsin_infotext_data.json",
    ];

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
    }

    // Replace service name string with the image for each service (or network/station logo for text services)
    function getServiceImage(serviceName) {
        return serviceImages[serviceName];
    }

    // Convert service name to lowercase name that will be used for CSS. Remove space and add hyphen if necessary (e.g. "CBS ExtraVision" becomes "cbs-extravision")
    function serviceNameToClass(serviceName) {
        return String(serviceName ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_-]/g, "").replace(/-+/g, "-");
    }

    try {
        const responses = await Promise.all(
            jsonFiles.map((path) =>
                fetch(path)
                    .then((r) => {
                        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
                        return r.json();
                    })
                    .catch((err) => {
                        console.warn("Skipping recent additions source:", err.message);
                        return [];
                    }),
            ),
        );

        const allRows = responses.flat();

        // Only show records that have a "Date_Added" value (all do, but this is a fallback just in case I forget to add the date). Sort records by date
        const withDates = allRows.filter((r) => r.Date_Added);
        withDates.sort((a, b) => new Date(b.Date_Added) - new Date(a.Date_Added));

        // Only show 10 records
        const recent = withDates.slice(0, 10);

        if (recent.length === 0) {
            container.innerHTML = "<p>No recent additions found.</p>";
            return;
        }

        // ! Create table rows
        const rowsHtml = recent
            .map((r) => {
                const serviceName = r.Service_Name ?? "";
                const serviceImage = getServiceImage(serviceName);
                const serviceClass = serviceNameToClass(serviceName);

                return `
                <tr>
                    <td class="additions-table-logo-row">
                        <img src="${escHtml(serviceImage)}" alt="${escHtml(serviceName)}" class="mw-100 ${escHtml(serviceClass)}-logo" loading="lazy" />
                    </td>
                    <td>${escHtml(r.Date)}</td>
                    <td>${escHtml(r.Date_Added)}</td>
                    <td>${escHtml(r.Recovered_By)}</td>
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
    } catch (err) {
        container.innerHTML = `<p>Could not load recent additions.</p>`;
        console.error("Could not load recent additions:", err);
    }
}

function escHtml(str) {
    if (str === null || str === undefined) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", renderRecentAdditions);
