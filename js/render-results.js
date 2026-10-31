// This and the Tape Value Map below are used to assist screen readers with pronunciation
const SERVICE_SPOKEN_LABELS = {
    KET: "Kentucky Educational Television",
    AGTEXT: "AGH TEXT",
    IPTV: "Iowa Public Television",
    AGIDS: "Agricultural InfoData Service",
    Infotext: "InfoText",
    DaTaVizion: "Data Vision"
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

const NETWORK_LOGOS = {
    "MTV": "../images/logos/MTV.png",
    "Nickelodeon": "../images/logos/Nickelodeon.png",
    "PBS": "../images/logos/PBS.png"
};

// Base URL (none since the site is hosted on Cloudflare and will fetch data from there)
const WORKER_BASE = "";

// API call
const API_BASE = `${WORKER_BASE}/api`;

async function renderResults(config) {
    const {
        dataset,
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

    if (!dataset) {
        console.error('renderResults() called without a "dataset" value');
        return;
    }

    const resolvedPath = `${API_BASE}/${dataset}`;

    const heading = document.getElementById('year-heading');
    const countEl = document.getElementById('result-count');
    const container = document.getElementById('results');
    const sortControls = document.getElementById('sort-controls');

    // Read URL parameters
    const params = new URLSearchParams(window.location.search);
    const filterValue = params.get(filterParam);

    let allRows;
    try {
        const response = await fetch(resolvedPath);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        allRows = await response.json();

        if (!Array.isArray(allRows)) {
            throw new Error('API returned an invalid dataset');
        }

    } catch (err) {
        if (container) {
            container.innerHTML = `<p>Could not load results (${escapeHtml(err.message)}).</p>`;
        }

        console.error(`Could not load dataset "${dataset}"`, err)
        return;
    }

    // If no filter is applied, show all rows. Otherwise, filter results depending on the filter the user chooses
    const showAllRows = !filterValue;
    let rows = showAllRows ? allRows.slice() : allRows.filter(r => String(r[filterField] ?? '').includes(String(filterValue)))

    // Default sort by month-group order (if configured) then secondary date field
    function applyDefaultSort(list) {
        return [...list].sort((a, b) => {
            if (showAllRows) {
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

    // Create the heading for each page
    if (heading) {
        const headingText = showAllRows ? 'All Records' : filterValue;

        // The next few blocks below are for screen readers
        const spokenText = showAllRows
            ? getSpokenText(serviceLabel, stationLabel, 'all records')
            : getSpokenText(serviceLabel, stationLabel, filterValue);

        heading.removeAttribute('aria-label', spokenText);
        heading.innerHTML = '';

        const visualSpan = document.createElement('span');
        visualSpan.setAttribute('aria-hidden', 'true');
        heading.appendChild(visualSpan);

        // Animate heading
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
                    renderTable(applyDefaultSort(rows), columns, showAllRows ? null : groupByField, container, dataset);
                    return;
                }

                const opt = sortOptions[Number(sortSelect.value)];
                const sorted = sortRowsByField(rows, opt.field, opt.type);

                // Custom sort overrides month-grouping
                renderTable(sorted, columns, null, container, dataset);
            });
        } else {
            sortControls.innerHTML = '';
        }
    }

    renderTable(rows, columns, showAllRows ? null : groupByField, container, dataset);
}

// Handles sorting based on the selected filter
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
        return String(aVal ?? '').localeCompare(String(bVal ?? ''));
    });
}

// ! Render the table
// Tables with more rows than this get a scrollable wrapper
const SCROLL_ROW_THRESHOLD = 5;

// ! Render the table
function renderTable(rows, columns, groupByField, container, dataset) {
    container.innerHTML = '';
    const headerCells = columns.map(c => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');

    // All records (no grouping): one table
    if (!groupByField) {
        const section = createTableSection(headerCells, columns, 'table-striped all-records');
        const tbody = section.querySelector('tbody');
        rows.forEach(r => appendRow(tbody, r, columns, dataset));
        container.appendChild(section);
        return;
    }

    // Grouped by month: one full-width table per group, stacked vertically
    const groups = new Map();
    for (const r of rows) {
        const key = r[groupByField];
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }

    for (const [groupValue, groupRows] of groups) {
        const section = createTableSection(headerCells, columns, '', groupValue);
        const tbody = section.querySelector('tbody');
        groupRows.forEach(r => appendRow(tbody, r, columns, dataset));
        applyScrollIfNeeded(section, groupRows.length, groupValue);
        container.appendChild(section);
    }
}

// Builds a heading (optional) + table wrapper
function createTableSection(headerCells, columns, extraTableClasses = '', headingText = null) {
    const section = document.createElement('section');
    section.className = 'results-group mb-4';

    const headingHtml = headingText !== null
        ? `<h2 aria-label="Table row month: ${escapeHtml(headingText)}">${escapeHtml(headingText)}</h2>`
        : '';

    const hasFixedWidths = columns.some(c => c.width);
    const colgroup = hasFixedWidths
        ? `<colgroup>${columns.map(c =>
            c.width ? `<col style="width: ${escapeHtml(c.width)}">` : '<col>'
        ).join('')}</colgroup>`
        : '';

    section.innerHTML = `
        ${headingHtml}
        <div class="table-responsive">
            <table class="table table-bordered table-primary table-striped align-middle results-table ${hasFixedWidths ? 'fixed-columns' : 'text-nowrap'} ${extraTableClasses}">
                ${colgroup}
                <thead>
                    <tr>${headerCells}</tr>
                </thead>
                <tbody></tbody>
            </table>
        </div>
    `;
    return section;
}

// Makes the table wrapper scrollable and keyboard-reachable when it has many rows
function applyScrollIfNeeded(section, rowCount, label) {
    if (rowCount <= SCROLL_ROW_THRESHOLD) return;

    const wrapper = section.querySelector('.table-responsive');
    wrapper.classList.add('table-scroll');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', `${label} results, scrollable table`);
}

// visibleHtml: the raw HTML that should be seen but not spoken
// spokenText: the plain text a screen reader should say instead
function renderAccessibleCell(visibleHtml, spokenText, extraAttributes = '') {
    return `<td${extraAttributes}><span class="cell-wrap"><span aria-hidden="true" class="table-result">${visibleHtml}</span><span class="sr-only">${escapeHtml(spokenText)}</span></span></td>`;
}

// Prevent any null or undefined values from being treated as real data
function hasRealValue(v) {
    if (v === null || v === undefined) return false;
    const trimmed = String(v).trim();
    return trimmed !== '' && trimmed.toLowerCase() !== 'null' && trimmed.toLowerCase() !== 'n/a';
}

// ! Create the table rows
function appendRow(tbody, row, columns, dataset) {
    const tr = document.createElement('tr');

    const isNewRecord = row.isNew === true;
    const isUpdatedRecord = !isNewRecord && row.isUpdated === true;

    if (isNewRecord) tr.classList.add('row-new');
    if (isUpdatedRecord) tr.classList.add('row-updated');

    // if (row.isNew) (now - Number(firstSeen)) <= NEW_WINDOW_SECONDS;
    const hasAnyLink = hasRealValue(row.Download_Link) || hasRealValue(row.HTML_Link) || hasRealValue(row.TEXT1) || hasRealValue(row.TEXT2) || hasRealValue(row.Data);
    if (!hasAnyLink) tr.classList.add('row-no-download-link');

    const nonTeletextDirectory = `/files/${encodeURIComponent(row.Service_Name)}/${encodeURIComponent(row.Year)}/`;
    const epgDirectory = `/files/${encodeURIComponent(row.Service_Name)}/`;

    tr.innerHTML = columns.map(c => {
        // This is for KCET and KET AGTEXT. If the "HTML_Link" column has a value, display it. Otherwise, show an icon
        // The next few "if" statements will have similar functionality
        if (c.renderHTML) {
            if (!row.HTML_Link) {
                const visible = `<i class="bi bi-slash-circle-fill"></i>`;
                return renderAccessibleCell(visible, `${c.label}: No HTML file available`);
            }
            const htmlPath = nonTeletextDirectory + row.HTML_Link;
            const visible = `<a href="${escapeHtml(htmlPath)}" class="text-black"><i class="bi bi-filetype-html"></i></a>`;
            return renderAccessibleCell(visible, `${c.label}: HTML file available`);
        }

        // For ABC PLUS, PENNTEXT, and Wisconsin Infotext, which use TEXT1 and TEXT2
        if (c.renderABCPlus || c.renderWisconsinInfotext) {
            const value = row[c.key];

            if (!value) {
                const visible = `<i class="bi bi-slash-circle-fill"></i>`;
                return renderAccessibleCell(visible, `${c.label}: No HTML file available`);
            }

            const path = nonTeletextDirectory + value;
            const visible = `<a href="${escapeHtml(path)}" class="text-black"><i class="bi bi-filetype-html"></i></a>`;
            return renderAccessibleCell(visible, `${c.label}: HTML file available`);
        }

        // For StarSight, which uses its own datasets
        if (c.renderStarSightDate) {
            const jsonFile = row.Data;
            const dateValue = row[c.key];

            if (!hasRealValue(jsonFile) || !hasRealValue(dateValue)) {
                // const visible = `<i class="bi bi-slash-circle-fill"></i>`;
                const visible = escapeHtml(dateValue ?? '');
                return renderAccessibleCell(visible, `${c.label}: ${dateValue}`);
            }

            const jsonUrl = epgDirectory + jsonFile;
            const guidePath = `starsight-data.html?json=${encodeURIComponent(jsonUrl)}`;
            const visible = `<a href="${escapeHtml(guidePath)}" class="text-black fw-bold">${escapeHtml(dateValue)}</a>`;
            return renderAccessibleCell(visible, `${c.label}: ${dateValue}. View EPG guide`);
        }

        // Showing ZIP download link for all teletext services
        if (c.renderZip) {
            if (row.Download_Link) {
                const visible = `<a href="${escapeHtml(row.Download_Link)}"><i class="bi bi-file-zip-fill"></i></a>`;
                return renderAccessibleCell(visible, `${c.label}: Download link available`);
            }

            const visible = `<i class="bi bi-slash-circle-fill"></i>`;
            return renderAccessibleCell(visible, `${c.label}: No download link available`);
        }

        // Show viewable teletext samples
        // * NABTS services (Edutel, ExtraVision, and NBC Teletext) have "NABTS_Stream" as the column name
        if (c.renderTeletext) {
            const isNabts = row.NABTS_Stream !== undefined;
            const hasSample = isNabts ? hasRealValue(row.NABTS_Stream) : hasRealValue(row.Teletext_Sample);

            if (!hasSample || !hasRealValue(row.IA_ID)) {
                const visible = `<i class="bi bi-slash-circle-fill"></i>`;
                return renderAccessibleCell(visible, `${c.label}: Teletext stream not available for viewing`);
            }

            const iaID = String(row.IA_ID).trim();
            const viewerPath = isNabts
                ? `nabts-viewer.html?service=${encodeURIComponent(dataset)}&sample=${encodeURIComponent(iaID)}`
                : `wst-viewer.html?service=${encodeURIComponent(dataset)}&sample=${encodeURIComponent(iaID)}`;
            const visible = `<a href="${escapeHtml(viewerPath)}" class="text-black"><img src="../images/teletext-icon.png" class="mw-100 w-25" /></a>`;
            return renderAccessibleCell(visible, `${c.label}: View teletext stream`);
        }

        // Displaying the thumbnail for all teletext services
        if (c.renderThumbnail) {
            if (!row.Thumbnail) {
                const visible = `<i class="bi bi-slash-circle-fill"></i>`;
                return renderAccessibleCell(visible, `${c.label}: No thumbnail image available.`);
            }
            const imagePath = row.Thumbnail;
            const visible = `<img src="${escapeHtml(imagePath)}" alt="" role="presentation" class="mw-100 teletext-preview" data-bs-target="#imageModal" data-bs-caption="${escapeHtml(row.Service_Name)} - ${escapeHtml(row.Date)}">`;
            return renderAccessibleCell(visible, `${c.label}: ${row.Service_Name} index page from ${row.Date}`, ' class="thumbnail-column"');
        }

        // For StarSight, show the network's logo. Fall back to plain text for any network without one
        if (c.renderNetworkLogo) {
            const network = String(row[c.key] ?? '').trim();
            const spokenNetwork = SERVICE_SPOKEN_LABELS[network] || network;
            const logoPath = NETWORK_LOGOS[network];

            // No logo for this network: show the name as text
            if (!logoPath) {
                return renderAccessibleCell(escapeHtml(network), `${c.label}: ${spokenNetwork}`);
            }

            const visible = `<img src="${escapeHtml(logoPath)}" alt="" role="presentation" class="network-logo">`;
            return renderAccessibleCell(visible, `${c.label}: ${spokenNetwork}`);
        }
        // Only PBS affiliates fill this in; leave the cell empty for every other network
        if (c.renderAffiliate) {
            if (!hasRealValue(row[c.key])) return '<td></td>';
            const affiliate = String(row[c.key]).trim();
            return renderAccessibleCell(escapeHtml(affiliate), `${c.label}: ${affiliate}`);
        }

        // Screen reader guide
        if (c.accessibleMap) {
            const map = TAPE_VALUE_MAPS[c.accessibleMap];
            const spoken = (map && map[row[c.key]]) || row[c.key];
            const visible = escapeHtml(row[c.key]);
            return renderAccessibleCell(visible, `${c.label}: ${spoken}.`);
        }

        /*
        If the "Notes" column in the DB is not empty, make the text bold and create a tooltip.
        Make screen readers read an available tooltip while inside the "Program Title" column.
        */
        if (c.key === 'Program_Title' && String(row.Notes ?? '').trim() !== '') {
            const notes = escapeHtml(row.Notes);
            const title = renderProgramTitles(row[c.key]);
            const spokenTitle = getSpokenProgramTitle(row[c.key]);
            const visible = `${title} <i class="bi bi-info-circle-fill" aria-hidden="true"></i>`;
            const tooltipAttributes = ` class="tape-notes" data-bs-toggle="tooltip" data-bs-html="true" data-bs-title="<h4 class='tooltip-heading'>ARCHIVE NOTE</h4><p class='tooltip-body'>${notes}</p>"`
            return renderAccessibleCell(visible, `${c.label}: ${spokenTitle}. Archive note: ${row.Notes}`, tooltipAttributes);
        }

        if (c.key === 'Program_Title') {
            const visible = renderProgramTitles(row[c.key]);
            const spokenTitle = getSpokenProgramTitle(row[c.key]);
            return renderAccessibleCell(visible, `${c.label}: ${spokenTitle}`);
        }

        // Link the viewable sample, directing to the "Teletext Sample Image Gallery" page, inside the "Date" column
        if (c.key === 'Date') {
            const stream = row.IA_ID;

            if (hasRealValue(stream)) {
                const galleryPath = `teletext-sample-image-gallery.html?stream=${encodeURIComponent(stream)}`;
                const visible = `<a href="${escapeHtml(galleryPath)}" class="text-black fw-bold">${escapeHtml(row[c.key])}</a>`;
                return renderAccessibleCell(visible, `${c.label}: ${row[c.key]}. View teletext images.`);
            }
            const visible = escapeHtml(row[c.key]);
            return renderAccessibleCell(visible, `${c.label}: ${row[c.key]}`);
        }

        const visible = escapeHtml(row[c.key]);
        return renderAccessibleCell(visible, `${c.label}: ${row[c.key]}`);
    }).join('');

    tbody.appendChild(tr);

    tr.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
        new bootstrap.Tooltip(el);
    });
}

// Assign specific pronunciations for specific abbreviations and service names
function getSpokenText(serviceLabel, stationLabel, filterValue) {
    const serviceSpoken = serviceLabel ? (SERVICE_SPOKEN_LABELS[serviceLabel] || serviceLabel) : null;
    const stationSpoken = stationLabel ? (SERVICE_SPOKEN_LABELS[stationLabel] || stationLabel) : null;
    const combinedLabel = [stationSpoken, serviceSpoken].filter(Boolean).join(' ');
    const rawText = combinedLabel ? `${combinedLabel} results: ${filterValue}` : filterValue;

    /*
    Screen readers are not pronouncing "records," as in "All Records", correctly.
    It instead pronounces it the way when someone says they're going to "record" something (ree-cord).
    This is a fix for that.
    */
    return rawText.replace(/\bRecords\b/gi, 'Wreckerds');
}

// If there are two or more program titles, they are split with a pipe. This removed the pipe and wraps the other titles to a new line
function splitProgramTitles(rawTitle) {
    return String(rawTitle ?? '').split("|").map(t => t.trim()).filter(t => t !== '');
}

// Join separate program titles with a comma; this is used for screen readers
function getSpokenProgramTitle(rawTitle) {
    return splitProgramTitles(rawTitle).join(', ');
}

// If there are two or more program titles, put them in an unordered list
function renderProgramTitles(rawTitle) {
    const titles = splitProgramTitles(rawTitle);

    if (titles.length <= 1) {
        return escapeHtml(rawTitle);
    }

    const items = titles.map(t => `<li class="text-black">${escapeHtml(t)}</li>`).join('');
    return `<ul class="mb-0 ps-0 multiple-programs">${items}</ul>`
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}