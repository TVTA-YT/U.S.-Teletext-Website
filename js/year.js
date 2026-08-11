const monthOrder = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

async function renderYear(year) {
  const container = document.getElementById('results');
  const heading = document.getElementById('year-heading');
  const countEl = document.getElementById('result-count');

  const response = await fetch('../php/teletext_data.json');
  const allRows = await response.json();

  const rows = allRows
    .filter(r => String(r.Year).includes(String(year)))
    .sort((a, b) => {
      const monthDiff = monthOrder.indexOf(a.Month) - monthOrder.indexOf(b.Month);
      if (monthDiff !== 0) return monthDiff;
      return new Date(a.Date) - new Date(b.Date);
    });

  heading.textContent = year;
  countEl.textContent = `${rows.length} result${rows.length === 1 ? '' : 's'} found`;

  container.innerHTML = '';

  if (rows.length === 0) {
    container.innerHTML = '<p>No programs found for this year.</p>';
    return;
  }

  const rowDiv = document.createElement('div');
  rowDiv.className = 'row';

  let currentMonth = null;
  let tbody = null;

  for (const r of rows) {
    if (r.Month !== currentMonth) {
      currentMonth = r.Month;

      const col = document.createElement('div');
      col.className = 'col-xl-6 col-lg-6 col-md-6 col-sm-12';
      col.innerHTML = `
        <h1>${escapeHtml(r.Month)}</h1>
        <table class="table table-bordered table-primary table-striped justify-content-center align-middle">
          <thead>
            <tr>
              <th>Date</th><th>Time</th><th>Affiliate</th>
              <th>Program</th><th>Tape</th><th>ZIP?</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      `;
      rowDiv.appendChild(col);
      tbody = col.querySelector('tbody');
    }

    const zipCell = r.Download_Link
      ? `<a href="../zip/${escapeHtml(r.Download_Link)}"><i class="bi bi-file-zip">${escapeHtml(r.ZIP)}</i></a>`
      : `<i class="bi bi-slash-circle"></i>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.Date)}</td>
      <td>${escapeHtml(r.Time)}</td>
      <td>${escapeHtml(r.Affiliate)}</td>
      <td>${escapeHtml(r.Program_Title)}</td>
      <td>${escapeHtml(r.Tape_Type)}</td>
      <td>${zipCell}</td>
    `;
    tbody.appendChild(tr);
  }

  container.appendChild(rowDiv);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Read ?year= from the URL and render on load
const params = new URLSearchParams(window.location.search);
const year = params.get('year');
if (year) {
  renderYear(year);
}
