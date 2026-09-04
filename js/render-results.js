const SERVICE_SPOKEN_LABELS = {
  KET: "Kentucky Educational Television",
  AGTEXT: "AGH TEXT",
  IPTV: "Iowa Public Television",
  AGIDS: "Agricultural InfoData Service",
  Infotext: "InfoText",
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
    sortOptions = null,
    columns
  } = config;

  const heading = document.getElementById('year-heading');
  const countEl = document.getElementById('result-count');
  const container = document.getElementById('results');
  const sortControls = document.getElementById('sort-controls');

  const params = new URLSearchParams(window.location.search);
  const filterValue = params.get(filterParam);

  let allRows;
  try {
    const response = await fetch(jsonPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allRows = await response.json();
  } catch (err) {
    container.innerHTML = `<p>Could not load results (${escapeHtml(err.message)}).</p>`;
    return;
  }

  const showAllRows = !filterValue;

  let rows = showAllRows ? allRows.slice() : allRows.filter(r => String(r[filterField] ?? '').includes(String(filterValue)))

  // Default sort — month-group order (if configured) then secondary date field.
  function applyDefaultSort(list) {
    return [...list].sort((a, b) => {
      if(showAllRows) {
        return new Date(b.Date_Added) - new Date(a.Date_Added);
      }

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
  }

  rows = applyDefaultSort(rows);

  if (heading) {
    const visibleParts = [stationLabel, serviceLabel].filter(Boolean).join(' ');
    const headingText = showAllRows
      ? (visibleParts ? `All Records` : 'All Records')
      : (visibleParts ? `${filterValue}` : filterValue);
    const spokenText = showAllRows
      ? getSpokenText(serviceLabel, stationLabel, 'all records')
      : getSpokenText(serviceLabel, stationLabel, filterValue);

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

  if (rows.length === 0) {
    container.innerHTML = '<p>No results found.</p>';
    if (sortControls) sortControls.innerHTML = '';
    return;
  }

  // Sort dropdown field that will only show when viewing all records
  if (sortControls) {
    if (showAllRows && sortOptions && sortOptions.length > 0) {
      sortControls.innerHTML = `
      <form>
        <div class="mb-3">
          <label for="sort-select" class="form-label me-2">Sort by</label>
          <select id="sort-select" class="form-select">
            <option value="default">Default (Date Added)</option>
            ${sortOptions.map((opt, i) => `<option value="${i}">${escapeHtml(opt.label)}</option>`).join('')}
          </select>
        </div>
      </form>
      `;

      const sortSelect = document.getElementById('sort-select');

      sortSelect.addEventListener('change', () => {
        if (sortSelect.value === 'default') {
          renderTable(applyDefaultSort(rows), columns, showAllRows ? null : groupByField, container);
          return;
        }

        const opt = sortOptions[Number(sortSelect.value)];
        const sorted = sortRowsByField(rows, opt.field, opt.type);
        // Custom sort overrides month-grouping
        renderTable(sorted, columns, null, container);
      });
    } else {
      sortControls.innerHTML = '';
    }
  }

  renderTable(rows, columns, showAllRows ? null : groupByField, container);
}

function sortRowsByField(rows, field, type) {
  return [...rows].sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];

    if (type === 'date') {
      return new Date(aVal) - new Date(bVal);
    }
    if (type === 'number') {
      return Number(aVal) - Number(bVal);
    }
    // default: string comparison
    return String(aVal ?? '').localeCompare(String(bVal ?? ''));
  });
}

function renderTable(rows, columns, groupByField, container) {
  container.innerHTML = '';

  if (!groupByField) {
    const headerCells = columns.map(c => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');
    container.innerHTML = `
      <div class="table-responsive">
        <table class="table table-bordered table-primary table-striped justify-content-center align-middle text-nowrap results-table${groupByField ? '' : ' all-records'}">
          <thead><tr>${headerCells}</tr></thead>
          <tbody></tbody>
        </table>
      </div>
    `;
    const tbody = container.querySelector('tbody');
    rows.forEach(r => appendRow(tbody, r, columns));
    return;
  }

  const rowDiv = document.createElement('div');
  rowDiv.className = 'row';

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

  container.appendChild(rowDiv);
}

// visibleHtml: the raw HTML that should be seen but not spoken
// spokenText: the plain text a screen reader should say instead
function renderAccessibleCell(visibleHtml, spokenText) {
  return `<span aria-hidden="true" class="table-result">${visibleHtml}</span><span class="sr-only">${escapeHtml(spokenText)}</span>`;
}

function hasRealValue(v) {
  if (v === null || v === undefined) return false;
  const trimmed = String(v).trim();
  return trimmed !== '' && trimmed.toLowerCase() !== 'null' && trimmed.toLowerCase() !== 'n/a';
}

function appendRow(tbody, row, columns) {
  const tr = document.createElement('tr');
  if (row.IsNew) tr.classList.add('row-new');
  const hasAnyLink = hasRealValue(row.Download_Link) || hasRealValue(row.HTML_Link) || hasRealValue(row.TEXT1) || hasRealValue(row.TEXT2);
  if (!hasAnyLink) tr.classList.add('row-no-download-link');

  const nonTeletextDirectory = `../html/other-text-services/${row.Service_Name}/${row.Year}/`;

  tr.innerHTML = columns.map(c => {
    if (c.renderHTML) {
      if (!row.HTML_Link) {
        const visible = `<i class="bi bi-slash-circle-fill"></i>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: No download link available`)}</td>`;
      }
      const htmlPath = nonTeletextDirectory + row.HTML_Link;
      const visible = `<a href="${escapeHtml(htmlPath)}" class="text-black"><i class="bi bi-filetype-html"></i></a>`;
      return `<td>${renderAccessibleCell(visible, `${c.label}: HTML file available`)}</td>`;
    }

    if (c.renderABCPlus || c.renderWisconsinInfotext) {
      const value = row[c.key];

      if (!value) {
        const visible = `<i class="bi bi-slash-circle-fill"></i>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: No HTML file available`)}</td>`;
      }

      const path = nonTeletextDirectory + value;
      const visible = `<a href="${escapeHtml(path)}" class="text-black"><i class="bi bi-filetype-html"></i></a>`;
      return `<td>${renderAccessibleCell(visible, `${c.label}: HTML file available`)}</td>`;
    }

    if (c.renderZip) {
      if (row.Download_Link) {
        const visible = `<a href="${escapeHtml(row.Download_Link)}"><i class="bi bi-file-zip-fill"></i></a>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: Download link available`)}</td>`;
      }
      const visible = `<i class="bi bi-slash-circle-fill"></i>`;
      return `<td>${renderAccessibleCell(visible, `${c.label}: No download link available`)}</td>`;
    }

    if (c.renderThumbnail) {
      if (!row.Thumbnail) {
        const visible = `<i class="bi bi-slash-circle-fill"></i>`;
        return `<td>${renderAccessibleCell(visible, `${c.label}: No thumbnail image available.`)}</td>`;
      }
      const imagePath = row.Thumbnail;
      const visible = `<img src="${escapeHtml(imagePath)}" alt="" role="presentation" class="mw-100 teletext-preview" data-bs-target="#imageModal" data-bs-caption="${escapeHtml(row.Service_Name)} - ${escapeHtml(row.Date)}">`;
      return `<td class="thumbnail-column">${renderAccessibleCell(visible, `${c.label}: ${escapeHtml(row.Service_Name)} index page from ${escapeHtml(row.Date)}`)}</td>`;
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
      return `<td>${renderAccessibleCell(visible, `${c.label}: ${spokenTitle}`)}</td>`;
    }

    if (c.key === 'Date') {
      const stream = row.IA_ID;
      console.log('IA_ID:', row.IA_ID);

      if (hasRealValue(stream)) {
        const galleryPath = `teletext-sample-image-gallery.html?stream=${encodeURIComponent(stream)}`;
        console.log('Gallery URL:', galleryPath);

        const visible = `<a href="${escapeHtml(galleryPath)}" class="text-black fw-bold">${escapeHtml(row[c.key])}</a>`;

        return `<td>${renderAccessibleCell(visible, `${c.label}: ${row[c.key]}. View teletext images.`)}</td>`;
      }
      const visible = escapeHtml(row[c.key]);
      return `<td>${renderAccessibleCell(visible, `${c.label}: ${row[c.key]}`)}</td>`;
    }

    const visible = escapeHtml(row[c.key]);
    return `<td>${renderAccessibleCell(visible, `${c.label}: ${row[c.key]}`)}</td>`;
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

  const rawText = combinedLabel ? `${combinedLabel} results: ${filterValue}` : filterValue;

  return rawText.replace(/\bRecords\b/gi, 'Wreckerds');
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