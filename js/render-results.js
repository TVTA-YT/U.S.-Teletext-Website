const SERVICE_SPOKEN_LABELS = {
  KET: "Kentucky Educational Television",
  AGTEXT: "AGH TEXT",
};

const TAPE_VALUE_MAPS = {
  BMAX_Name: {
    BMAX: "Betamax",
  },

  BMAX_Speed: {
    BI: "B-1",
    BII: "B-2",
    BIII: "B-3",
  },
};

async function renderResults(config) {
  const {
    jsonPath,
    filterParam,
    filterField,
    groupByField = null,
    groupOrder = null,
    sortSecondaryField = null,
    serviceLabel = null,
    stationLabel = null,
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


  if (heading) {
    const visibleParts = [stationLabel, serviceLabel].filter(Boolean).join(' ');
    const headingText = visibleParts ? `${visibleParts} - ${filterValue}` : filterValue;
    const spokenText = getSpokenText(serviceLabel, stationLabel, filterValue);

    heading.removeAttribute('aria-label');
    heading.innerHTML = '';

    const visualSpan = document.createElement('span');
    visualSpan.setAttribute('aria-hidden', 'true');
    heading.appendChild(visualSpan);

    const srSpan = document.createElement('span');
    srSpan.className = 'sr-only';
    srSpan.textContent = spokenText;
    heading.appendChild(srSpan);

    LetterReveal.type(visualSpan, headingText)
    visualSpan.removeAttribute('aria-label');
  }
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
        const headerCells = columns.map(c => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');

        col.innerHTML = `
          <h2 aria-label="Table row month: ${escapeHtml(groupValue)}">${escapeHtml(groupValue)}</h2>
          <div class="table-responsive">
            <table class="table table-bordered table-primary justify-content-center align-middle text-nowrap results-table">
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
    const headerCells = columns.map(c => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');
    col.innerHTML = `
    <div class="table-responsive">
      <table class="table table-bordered table-primary table-striped justify-content-center align-middle text-nowrap results-table">
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

// visibleHtml: the raw HTML that should be seen but not spoken
// spokenText: the plain text a screen reader should say instead
function renderAccessibleCell(visibleHtml, spokenText) {
  return `<span aria-hidden="true" class="table-result">${visibleHtml}</span><span class="sr-only">${escapeHtml(spokenText)}</span>`;
}

function appendRow(tbody, row, columns) {
  const tr = document.createElement('tr');
  if (row.IsNew) tr.classList.add('row-new');
  const hasAnyLink = Boolean(row.Download_Link || row.HTML_Link || row.TEXT1 || row.TEXT2);
  if (!hasAnyLink) tr.classList.add('row-no-download-link');

  const nonTeletextDirectory = `../html/other-text-services/${row.Service_Name}/${row.Year}/`;

  tr.innerHTML = columns.map(c => {
    if (c.renderHTML) {
      if (!row.HTML_Link) {
        const visible = `<i class="bi bi-slash-circle-fill"></i>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: No download link available.`)}</td>`;
      }
      const htmlPath = nonTeletextDirectory + row.HTML_Link;
      const visible = `<a href="${escapeHtml(htmlPath)}" class="text-black"><i class="bi bi-filetype-html"></i></a>`;
      return `<td>${renderAccessibleCell(visible, `${c.label}: HTML file available.`)}</td>`;
    }

    if (c.renderABCPlus || c.renderWisconsinInfotext) {
      const value = row[c.key];

      if (!value) {
        const visible = `<i class="bi bi-slash-circle-fill"></i>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: No HTML file available.`)}</td>`;
      }

      const path = nonTeletextDirectory + value;
      const visible = `<a href="${escapeHtml(path)}" class="text-black"><i class="bi bi-filetype-html"></i></a>`;
      return `<td>${renderAccessibleCell(visible, `${c.label}: HTML file available.`)}</td>`;
    }

    if (c.renderZip) {
      if (row.Download_Link) {
        const visible = `<a href="${escapeHtml(row.Download_Link)}"><i class="bi bi-file-zip-fill"></i></a>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: Download link available.`)}</td>`;
      }
      const visible = `<i class="bi bi-slash-circle-fill"></i>`;
      return `<td>${renderAccessibleCell(visible, `${c.label}: No download link available.`)}</td>`;
    }

    if (c.renderThumbnail) {
      if (!row.Thumbnail) {
        const visible = `<i class="bi bi-slash-circle-fill"></i>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: No thumbnail image available.`)}</td>`;
      }
      const imagePath = row.Thumbnail;
      const visible = `<img src="${escapeHtml(imagePath)}" alt="" role="presentation" class="mw-100 teletext-preview" data-bs-target="#imageModal" data-bs-caption="${escapeHtml(row.Service_Name)} - ${escapeHtml(row.Date)}">`;
      return `<td>${renderAccessibleCell(visible, `${c.label}: ${escapeHtml(row.Service_Name)} index page from ${escapeHtml(row.Date)}.`)}</td>`;
    }

    if (c.accessibleMap) {
      const map = TAPE_VALUE_MAPS[c.accessibleMap];
      const spoken = (map && map[row[c.key]]) || row[c.key];
      const visible = escapeHtml(row[c.key]);
      return `<td>${renderAccessibleCell(visible, `${c.label}: ${spoken}.`)}</td>`;
    }

    if (c.key === 'Program_Title' && String(row.Notes ?? '').trim() !== '') {
      const notes = escapeHtml(row.Notes);
      const title = renderProgramTitles(row[c.key]);
      const spokenTitle = getSpokenProgramTitle(row[c.key]);
      const visible = `${title} <i class="bi bi-info-circle-fill" aria-hidden="true"></i>`;
      return `<td class="tape-notes" data-bs-toggle="tooltip" data-bs-html="true" data-bs-title="<h4 class='tooltip-heading'>ARCHIVE NOTE</h4><p class='tooltip-body'>${notes}</p>">${renderAccessibleCell(visible, `${c.label}: ${spokenTitle}. Archive note: ${row.Notes}`)}</td>`;
    }

    if (c.key === 'Program_Title') {
      const visible = renderProgramTitles(row[c.key]);
      const spokenTitle = getSpokenProgramTitle(row[c.key]);
      return `<td>${renderAccessibleCell(visible, `${c.label}: ${spokenTitle}.`)}</td>`;
    }

    const visible = escapeHtml(row[c.key]);
    return `<td>${renderAccessibleCell(visible, `${c.label}: ${row[c.key]}.`)}</td>`;
  }).join('');

  tbody.appendChild(tr);

  tr.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
    new bootstrap.Tooltip(el);
  });
}

function getSpokenText(serviceLabel, stationLabel, filterValue) {
  const serviceSpoken = serviceLabel ? (SERVICE_SPOKEN_LABELS[serviceLabel] || serviceLabel) : null;
  const stationSpoken = stationLabel ? (SERVICE_SPOKEN_LABELS[stationLabel] || stationLabel) : null;

  const combinedLabel = [stationSpoken, serviceSpoken].filter(Boolean).join(' ');

  return combinedLabel ? `${combinedLabel} results from ${filterValue}` : filterValue;
}

function splitProgramTitles(rawTitle) {
  return String(rawTitle ?? '').split("|").map(t => t.trim()).filter(t => t !== '');
}

function getSpokenProgramTitle(rawTitle) {
  return splitProgramTitles(rawTitle).join(', ');
}

function renderProgramTitles(rawTitle) {
  const titles = splitProgramTitles(rawTitle);

  if (titles.length <= 1) {
    return escapeHtml(rawTitle);
  }

  const items = titles.map(t => `<li class="text-black">${escapeHtml(t)}</li>`).join('');
  return `<ul class="mb-0 ps-3 multiple-programs">${items}</ul>`
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}