async function renderResults(config) {
  const {
    jsonPath,
    filterParam,
    filterField,
    groupByField = null,
    groupOrder = null,
    sortSecondaryField = null,
    columns
  } = config;

  const heading = document.getElementById('year-heading');
  const countEl = document.getElementById('result-count');
  const container = document.getElementById('results');

  const params = new URLSearchParams(window.location.search);
  const filterValue = params.get(filterParam);

  if (!filterValue) {
    container.innerHTML = '<p>No search value provided.</p>';
    return;
  }

  let allRows;
  try {
    const response = await fetch(jsonPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allRows = await response.json();
  } catch (err) {
    container.innerHTML = `<p>Could not load results (${escapeHtml(err.message)}).</p>`;
    return;
  }

  let rows = allRows.filter(r =>
    String(r[filterField] ?? '').includes(String(filterValue))
  );

  rows.sort((a, b) => {
    if (groupByField) {
      const aIdx = groupOrder ? groupOrder.indexOf(a[groupByField]) : 0;
      const bIdx = groupOrder ? groupOrder.indexOf(b[groupByField]) : 0;
      if (aIdx !== bIdx) return aIdx - bIdx;
    }
    if (sortSecondaryField) {
      return new Date(a[sortSecondaryField]) - new Date(b[sortSecondaryField]);
    }
    return 0;
  });

  if (heading) heading.textContent = filterValue;
  if (countEl) countEl.textContent = `${rows.length} result${rows.length === 1 ? '' : 's'} found`;

  container.innerHTML = '';

  if (rows.length === 0) {
    container.innerHTML = '<p>No results found.</p>';
    return;
  }

  const rowDiv = document.createElement('div');
  rowDiv.className = 'row';

  if (groupByField) {
    let currentGroup = null;
    let tbody = null;

    for (const r of rows) {
      const groupValue = r[groupByField];

      if (groupValue !== currentGroup) {
        currentGroup = groupValue;

        const col = document.createElement('div');
        col.className = 'col-xl-6 col-lg-6 col-md-6 col-sm-12';
        const headerCells = columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');

        col.innerHTML = `
          <h1>${escapeHtml(groupValue)}</h1>
          <div class="table-responsive">
            <table class="table table-bordered table-primary table-striped justify-content-center align-middle text-nowrap">
              <thead><tr>${headerCells}</tr></thead>
              <tbody></tbody>
            </table>
          </div>
        `;
        rowDiv.appendChild(col);
        tbody = col.querySelector('tbody');
      }

      appendRow(tbody, r, columns);
    }
  } else {
    const col = document.createElement('div');
    col.className = 'col-12';
    const headerCells = columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('');
    col.innerHTML = `
    <div class="table-responsive">
      <table class="table table-bordered table-primary table-striped justify-content-center align-middle text-nowrap">
        <thead><tr>${headerCells}</tr></thead>
          <tbody></tbody>
      </table>
    </div>
    `;
    rowDiv.appendChild(col);
    const tbody = col.querySelector('tbody');
    rows.forEach(r => appendRow(tbody, r, columns));
  }

  container.appendChild(rowDiv);
}

function appendRow(tbody, row, columns) {
  const tr = document.createElement('tr');
  if (row.IsNew) tr.classList.add('row-new');
  tr.innerHTML = columns.map(c => {
    if (c.renderZip) {
      return row.Download_Link
        ? `<td><a href="${escapeHtml(row.Download_Link)}"><i class="bi bi-file-zip"></i></a></td>`
        : `<td><i class="bi bi-slash-circle"></i></td>`;
    }
    return `<td>${escapeHtml(row[c.key])}</td>`;
  }).join('');
  tbody.appendChild(tr);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
