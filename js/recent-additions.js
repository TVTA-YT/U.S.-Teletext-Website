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

    const withDates = allRows.filter((r) => r.Date_Added);
    withDates.sort((a, b) => new Date(b.Date_Added) - new Date(a.Date_Added));

    const recent = withDates.slice(0, 10);

    if (recent.length === 0) {
      container.innerHTML = "<p>No recent additions found.</p>";
      return;
    }

    const rowsHtml = recent
      .map(
        (r) => `
      <tr>
        <td class="fw-bold">${escHtml(r.Service_Name ?? "")}</td>
        <td>${escHtml(r.Date)}</td>
        <td>${escHtml(r.Date_Added)}</td>
      </tr>
    `,
      )
      .join("");

    container.innerHTML = `
      <div class="table-responsive">
        <table class="table table-bordered table-custom-blue table-striped align-middle text-center text-nowrap text-white">
          <thead>
            <tr><th scope="col">Service</th><th scope="col">Sample Date</th><th scope="col">Date Added</th></tr>
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
