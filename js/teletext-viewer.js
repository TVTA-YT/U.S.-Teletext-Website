"use strict";

// Length of one tick of the viewer's clock. Everything else that follows below is counted in ticks
const TICK_MS = 100;

// Flashing text changes phase every half second
const FLASH_TICKS = 5;

// The rolling header at the top of each page shows a new header 5 times a second
// ! CHANGE THIS
const HEADER_TICKS = 2;

// If a page has subpages, the next page will show after 10 seconds
const SUBPAGE_TICKS = 100;

// A requested page will appear between 0.4 and 1.2 seconds after it is requested
const SEARCH_MIN_TICKS = 4;
const SEARCH_MAX_TICKS = 12;

// If page is not in sample, show a "page not found" message after 3 seconds
const NOT_FOUND_TICKS = 30;


const PAGES_API_BASE = "https://us-teletext-website.us-teletext-archive.workers.dev/api/teletext";
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const RENDER_SCALE = 2;
const OUTSIDE_BOX_COLOR = "#333";

const FLAG_DESCRIPTIONS = {
    4: "C4 erase page",
    5: "C5 newsflash",
    6: "C6 subtitle",
    7: "C7 suppress header",
    8: "C8 update",
    9: "C9 interrupted sequence",
    10: "C10 inhibit display",
    11: "C11 magazine serial",
    12: "C12 national option",
    13: "C13 national option",
    14: "C14 national option",
};

const NEWSFLASH_FLAG = 5;
const SUBTITLE_FLAG = 6;
const SUPPRESS_HEADER_FLAG = 7;
const INHIBIT_DISPLAY_FLAG = 10;

const PAGE_NUMBER_PATTERN = /^[1-8][0-9A-F]{2}$/;

const getElement = id => document.getElementById(id);

const elements = {
    screen: getElement("screen"),
    canvas: getElement("pageCanvas"),
    sourceName: getElement("sourceName"),
    backLink: getElement("backLink"),
    pageInfo: getElement("pageInfo"),
    pageFlags: getElement("pageFlags"),
    pageText: getElement("pageText"),
    entryDisplay: getElement("entryDisplay"),
    pageSelect: getElement("pageSelect"),
    announcer: getElement("announcer"),
    rollingOption: getElement("optRolling"),
    flashOption: getElement("optFlash"),
    aspectOption: getElement("optAspect"),
    sampleTitle: getElement("sample-title"),
    contributor: getElement("contributor"),
    contributorName: getElement("contributor-name"),
    lightImageBanner: getElement("lightImageBanner"),
    darkImageBanner: getElement("darkImageBanner")
};

// & Create a 40-byte row from the provided control codes and text
function makeRows(...parts) {
    const rowBytes = [];

    for (const part of parts) {
        if (typeof part === "number") rowBytes.push(part);
        else for (const character of part) rowBytes.push(character.charCodeAt(0) & SEVEN_BIT_MASK);
    }

    while (rowBytes.length < COLUMN_COUNT) rowBytes.push(SPACE);
    return rowBytes.slice(0, COLUMN_COUNT);
}

const blankRows = () => Array(ROW_COUNT).fill(null);

const viewer = {
    loadState: "none",
    sourceName: null,
    pagesByNumber: new Map(),
    pageNumbers: [],
    headersByMagazine: new Map(),
    headerPositions: new Map(),
    requestedNumber: "100",
    displayed: null,
    headerSource: null,
    entryDigits: "",
    isHolding: false,
    isRevealing: false,
    showBoxedOnly: true,
    flashOn: true,
    search: null,
    subpageTicks: 0,
    tickCount: 0
};

const hasCapture = () => viewer.pagesByNumber.size > 0;
const displayedSubpages = () => viewer.displayed ? viewer.pagesByNumber.get(viewer.displayed.number) : null;
const displayedSubpage = () => displayedSubpages()?.[viewer.displayed.subpageIndex] ?? null;
const comparePageNumbers = (first, second) => parseInt(first, 16) - parseInt(second, 16);
const randomBetween = (low, high) => low + Math.floor(Math.random() * (high - low + 1));


// & Announcements for screen readers
function announce(message) {
    elements.announcer.textContent = "";
    setTimeout(() => {
        elements.announcer.textContent = message
    }, 50);
}


// & In the JSON, a row consists of 40 bytes that have already had parity stripped. The value is null is never received
function normalizedRow(rowBytes) {
    if (!Array.isArray(rowBytes) || rowBytes.length === 0) return null;
    return Array.from({ length: COLUMN_COUNT }, (_, column) => (Number(rowBytes[column] ?? SPACE) & SEVEN_BIT_MASK));
}

// & Loading sample
function loadSample(data, sourceName) {
    const pagesByNumber = new Map();

    for (const entry of data?.pages ?? []) {
        const number = String(entry?.page ?? "").toUpperCase();
        if (!PAGE_NUMBER_PATTERN.test(number) || !Array.isArray(entry.rows)) continue;

        const subpage = {
            number,
            subcode: String(entry.subcode ?? "0000").toUpperCase(),
            transmission: entry.transmission ?? null,
            flags: Array.isArray(entry.flags) ? entry.flags : [],
            edited: Boolean(entry.edited),
            rows: Array.from({ length: ROW_COUNT }, (_, rowNumber) => normalizedRow(entry.rows[rowNumber]))
        };

        if (!pagesByNumber.has(number)) pagesByNumber.set(number, []);
        pagesByNumber.get(number).push(subpage);
    }

    // Fail safe
    if (pagesByNumber.size === 0) throw new Error("Sample has no teletext pages.");

    for (const subpages of pagesByNumber.values()) {
        subpages.sort((first, second) => first.subcode.localeCompare(second.subcode) || (first.transmission ?? 0) - (second.transmission ?? 0));
    }

    viewer.pagesByNumber = pagesByNumber;
    viewer.pageNumbers = [...pagesByNumber.keys()].sort(comparePageNumbers);
    viewer.headersByMagazine = new Map();
    viewer.headerPositions = new Map();

    for (const number of viewer.pageNumbers) {
        const magazine = number[0];
        if (!viewer.headersByMagazine.has(magazine)) viewer.headersByMagazine.set(magazine, []);

        for (const subpage of pagesByNumber.get(number)) {
            if (subpage.rows[0]) viewer.headersByMagazine.get(magazine).push(subpage.rows[0]);
        }
    }

    viewer.loadState = "loaded";
    viewer.sourceName = sourceName;
    viewer.displayed = null;
    viewer.headerSource = null;
    viewer.search = null;
    viewer.entryDigits = "";
    viewer.isHolding = false;

    elements.sourceName.textContent = sourceName;
    renderPageSelect();

    const subpageCount = [...pagesByNumber.values()].reduce((total, subpage) => total + subpage.length, 0);
    announce(`Opened ${sourceName}: ${viewer.pageNumbers.length} pages, ${subpageCount} subpages.`);

    // Start with P100; otherwise, start with first page
    const startNumber = pageNumberFromHash() ?? (pagesByNumber.has("100") ? "100" : viewer.pageNumbers[0]);
    goToPage(startNumber);
}


// & Get the sample name from the value in the URL
function sampleFromURL() {
    const parameters = new URLSearchParams(location.search);
    const service = parameters.get("service") ?? "";
    const sample = parameters.get("sample") ?? "";
    return SAFE_KEY_PATTERN.test(service) && SAFE_KEY_PATTERN.test(sample) ? { service, sample } : null;
}


// & Fetch necessary JSON from Cloudflare
async function openSample({ service, sample }) {
    const label = `${service} sample ${sample}`;
    viewer.loadState = "loading";
    elements.pageInfo.textContent = `Loading ${label}...`;
    render();

    try {
        const response = await fetch(`${PAGES_API_BASE}/${encodeURIComponent(service)}/${encodeURIComponent(sample)}`);
        if (response.status === 404) throw new Error("No available data for this sample.");
        if (!response.ok) throw new Error(`The server responded with ${response.status}.`);
        const data = await response.json();
        showSampleDetails(data.sample, service);
        loadSample(data, data.source || label);
    } catch (error) {
        showLoadError(label, error);
    }
}


// & Show error on load if there's an issue
function showLoadError(label, error) {
    viewer.loadState = "failed";
    const message = `Couldn't fetch ${label}: ${error.message}`;
    elements.pageInfo.textContent = message;
    announce(message);
    render();
}


function pageNumberFromHash() {
    const number = location.hash.replace("#", "").toUpperCase();
    return PAGE_NUMBER_PATTERN.test(number) ? number : null;
}


// & Show the service's banner in the page heading
function showServiceBanner(service) {
    const bannerService = service.toLowerCase();

    if (elements.lightImageBanner) {
        elements.lightImageBanner.src = `../images/banners/light/${bannerService}_light.png`;
    }

    if (elements.darkImageBanner) {
        elements.darkImageBanner.src = `../images/banners/dark/${bannerService}.png`;
    }
}


// & Show the service name, sample date, and contributor on the page
function showSampleDetails(details, fallbackService) {
    const service = details?.service || fallbackService;
    const sampleTitle = details?.date ? `${service} (${formatDate(details.date)})` : service;

    if (elements.sampleTitle) elements.sampleTitle.textContent = sampleTitle;
    document.title = `${sampleTitle}`;

    const contributor = details?.recovered_by || "";
    if (elements.contributorName) elements.contributorName.textContent = contributor;
    if (elements.contributor) elements.contributor.hidden = !contributor;
}


// & Convert the stored date for each record (YYYY-MM-DD) to Mon. DD, YYYY)
function formatDate(dateString) {
    if (!dateString) {
        return "";
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString));
    if (!match) {
        return String(dateString);
    }

    const [, year, month, day] = match;
    const months = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
    const monthIndex = Number(month) - 1;
    if (monthIndex < 0 || monthIndex > 11) {
        return String(dateString);
    }

    return `${months[monthIndex]} ${Number(day)}, ${year}`;
}


// & Emulate page search when a viewer requests a page. Animate page header then wait a bit before showing the next page (or show immediately)
function goToPage(number) {
    if (!hasCapture()) return;
    number = number.toUpperCase();
    viewer.requestedNumber = number;
    viewer.entryDigits = "";
    const isFound = viewer.pagesByNumber.has(number);

    // If viewer has checked the option for rolling page headers, animate it. If page is not found, continue animating the header
    if (elements.rollingOption.checked) {
        viewer.search = { ticksLeft: isFound ? randomBetween(SEARCH_MIN_TICKS, SEARCH_MAX_TICKS) : Infinity, tickWaited: 0, isFound };
    } else {
        viewer.search = null;
        if (isFound) showPage(number);
        else announceNotFound(number);
    }

    render();
    renderControls();
}


// & Show requested page (first subpage if page has subpages)
function showPage(number) {
    viewer.displayed = { number, subpageIndex: 0 };
    viewer.search = null;
    viewer.subpageTicks = 0;
    viewer.headerSource = displayedSubpage().rows[0];

    history.replaceState(null, "", `#${number}`);
    renderPageDetails();

    const subpageCount = displayedSubpages().length;
    announce(`Page ${number}${subpageCount > 1 ? `, subpage 1 of ${subpageCount}` : ""}`);
}


// & Announce that a page is not found
function announceNotFound(number) {
    const message = `Page ${number} is not available in this sample.`
    elements.pageInfo.textContent = message;
    announce(message);
}


// & Get previous or next page in the sample, which will wrap around
function stepPage(direction) {
    if (!hasCapture()) return;
    const current = parseInt(viewer.requestedNumber, 16);
    const numbers = viewer.pageNumbers;
    const next = direction > 0
        ? numbers.find(number => parseInt(number, 16) > current) ?? numbers[0]
        : [...numbers].reverse().find(number => parseInt(number, 16) < current) ?? numbers[numbers.length - 1];
    goToPage(next);
}


// & Do not display subpages automatically if using manual controls
function stepSubpage(direction, { isManual = true } = {}) {
    const subpages = displayedSubpages();
    if (!subpages || subpages.length < 2) return;

    const count = subpages.length;
    viewer.displayed.subpageIndex = (viewer.displayed.subpageIndex + direction + count) % count;
    viewer.subpageTicks = 0;
    if (!elements.rollingOption.checked) viewer.headerSource = displayedSubpage().rows[0];

    renderPageDetails();
    render();
    if (isManual) announce(`Subpage ${viewer.displayed.subpageIndex + 1} of ${count}.`);
}


// & Keypad actions
function typeDigit(digit) {
    if (!hasCapture()) return;

    // Typing a number releases the page hold
    if (viewer.isHolding) viewer.isHolding = false;

    // Only focus on the first digit
    if (!viewer.entryDigits && !/^[1-8]$/.test(digit)) return;

    viewer.entryDigits += digit.toUpperCase();

    if (viewer.entryDigits.length === 3) {
        goToPage(viewer.entryDigits);
        return;
    }

    render();
    renderControls();
}


// & Cancel the page entry
function cancelEntry() {
    if (!viewer.entryDigits) return;
    viewer.entryDigits = "";
    render();
    renderControls();
    announce("Page entry cancelled.");
}


// & Hold the current page; do not animate the header or change to a subpage
function toggleHold() {
    if (!hasCapture()) return;
    viewer.isHolding = !viewer.isHolding;
    viewer.entryDigits = "";
    render();
    renderControls();
    announce(viewer.isHolding ? "Hold mode on; the current page will not automatically change." : "Hold mode off.");
}


// & Reveal hiddden text
function toggleReveal() {
    viewer.isRevealing = !viewer.isRevealing;
    render();
    renderControls();
    renderPageDetails();
    announce(viewer.isRevealing ? "Reveal toggled: now showing hidden text." : "Reveal off.");
}


// & Show newsflash text inside a box
function toggleBoxedView() {
    viewer.showBoxedOnly = !viewer.showBoxedOnly;
    render();
    renderControls();
    announce(viewer.showBoxedOnly ? "Showing only the boxed newsflash." : "Showing the full page.");
}


// & Create rolling header and show the next page header that was transmiited in the requested page's magazine
function rollHeader() {
    const magazine = viewer.requestedNumber[0];
    const headers = viewer.headersByMagazine.get(magazine);

    // Keep header as it is if there is nothing in a magazine
    if (!headers?.length) return false;

    const position = ((viewer.headerPositions.get(magazine) ?? -1) + 1) % headers.length;
    viewer.headerPositions.set(magazine, position);
    viewer.headerSource = headers[position];
    return true;
}


// & Determine if a page has flashing text
const pageHasFlash = () => (displayedSubpage()?.rows ?? []).some(rowBytes => rowBytes?.includes(ControlCode.FLASH));

function tick() {
    viewer.tickCount++;
    let needsDraw = false;

    if (elements.flashOption.checked) {
        if (viewer.tickCount % FLASH_TICKS === 0) {
            viewer.flashOn = !viewer.flashOn;
            needsDraw = pageHasFlash();
        }
    } else if (!viewer.flashOn) {
        viewer.flashOn = true;
        needsDraw = true;
    }


    // * Holdover from VHS-Teletext; no data is received while holding a page or typing a number
    const isFrozen = viewer.isHolding || viewer.entryDigits.length > 0 || !hasCapture();

    if (!isFrozen) {
        if (elements.rollingOption.checked && viewer.tickCount % HEADER_TICKS === 0 && rollHeader()) needsDraw = true;

        if (viewer.search) {
            viewer.search.tickWaited++;
            viewer.search.ticksLeft--;

            if (viewer.search.ticksLeft <= 0) {
                showPage(viewer.requestedNumber);
                needsDraw = true;
            } else if (!viewer.search.isFound && viewer.search.tickWaited === NOT_FOUND_TICKS) {
                announceNotFound(viewer.requestedNumber);
            }
        } else if (displayedSubpages()?.length > 1 && ++viewer.subpageTicks >= SUBPAGE_TICKS) {
            stepSubpage(1, { isManual: false });
            needsDraw = true;
        }
    }

    if (needsDraw) render();
}


// & Build header row; columns 0-7 show the page number the user requested (e.g. "P1...") or "HOLD" when hold is enabled
// * Columns 8-39 comes from whichever page header was last received
function buildHeaderRow() {
    const sourceHeader = viewer.headerSource ?? displayedSubpage()?.rows[0] ?? null;
    const row = sourceHeader ? sourceHeader.slice() : makeRows("");

    let label = `P${viewer.requestedNumber}`;
    let color = ControlCode.ALPHA_WHITE;

    if (viewer.entryDigits) {
        label = `P${viewer.entryDigits.padEnd(3, ".")}`;
        color = ControlCode.ALPHA_YELLOW;
    } else if (viewer.isHolding) {
        label = "HOLD";
        color = ControlCode.ALPHA_GREEN;
    }

    for (let column = 0; column < HEADER_CONTROL_COLUMNS; column++) row[column] = SPACE;
    row[2] = color;
    [...label].forEach((character, index) => { row[3 + index] = character.charCodeAt(0); });
    row[7] = ControlCode.ALPHA_WHITE
    return row;
}


// & Render function. Keep the viewer black until a sample finished loading. Show text that shows the status
function render() {
    if (!hasCapture()) {
        drawPage(elements.canvas, blankRows(), { scale: RENDER_SCALE });
        elements.entryDisplay.textContent = "";
        return;
    }

    const subpage = displayedSubpage();
    const bodyRows = subpage?.rows ?? blankRows();
    const flags = subpage?.flags ?? [];
    const isBoxedPage = flags.includes(NEWSFLASH_FLAG) || flags.includes(SUBTITLE_FLAG);

    drawPage(elements.canvas, [buildHeaderRow(), ...bodyRows.slice(1)], {
        scale: RENDER_SCALE,
        revealConcealed: viewer.isRevealing,
        flashOn: viewer.flashOn,
        boxedOnly: isBoxedPage && viewer.showBoxedOnly,
        outsideBoxColor: OUTSIDE_BOX_COLOR,
        hideHeader: flags.includes(SUPPRESS_HEADER_FLAG) && !viewer.entryDigits && !viewer.isHolding,
        hideBody: flags.includes(INHIBIT_DISPLAY_FLAG)
    });

    elements.entryDisplay.textContent = viewer.entryDigits
        ? `P${viewer.entryDigits.padEnd(3, ".")}`
        : viewer.isHolding ? "HOLD" : `P${viewer.requestedNumber}`;
}


// & Render everything about the page that only changes when a new page or subpage is displayed
function renderPageDetails() {
    const subpage = displayedSubpage();
    if (!subpage) return;

    const subpages = displayedSubpages();
    const details = [`P${subpage.number}`];

    if (subpages.length > 1) details.push(`subpage ${viewer.displayed.subpageIndex + 1} of ${subpages.length} (${subpage.subcode})`);
    else if (subpage.subcode !== "0000") details.push(`subcode ${subpage.subcode}`);

    if (subpage.transmission) details.push(`transmission ${subpage.transmission}`);
    if (subpage.edited) details.push("edited");
    elements.pageInfo.textContent = details.join(" · ");

    elements.pageFlags.innerHTML = "";
    if (subpage.flags.length === 0) {
        elements.pageFlags.innerHTML = `<li class="text-body-secondary">None set</li>`
    }

    for (const flag of subpage.flags) {
        const item = document.createElement("li");
        item.textContent = FLAG_DESCRIPTIONS[flag] ?? `C${flag}`;
        elements.pageFlags.append(item);
    }

    elements.canvas.setAttribute("aria-label", `Teletext page ${subpage.number}. The text version follows below the viewer.`);
    elements.pageText.textContent = pageToText(subpage.rows, { revealConcealed: viewer.isRevealing }) || "This page has no text to display.";
    elements.pageSelect.value = subpage.number;
    renderControls();
}


// & Render on-screen controls
function renderControls() {
    document.querySelectorAll('[data-command="hold"]').forEach(button => button.setAttribute("aria-pressed", String(viewer.isHolding)));
    document.querySelectorAll('[data-command="reveal"]').forEach(button => button.setAttribute("aria-pressed", String(viewer.isRevealing)));

    const flags = displayedSubpage()?.flags ?? [];
    const isBoxedPage = flags.includes(NEWSFLASH_FLAG) || flags.includes(SUBTITLE_FLAG);

    document.querySelectorAll('[data-command="boxed"]').forEach(button => {
        button.disabled = !isBoxedPage;
        button.setAttribute("aria-pressed", String(isBoxedPage && viewer.showBoxedOnly));
    });

    const hasSubpages = (displayedSubpages()?.length ?? 0) > 1;
    document.querySelectorAll('[data-command="prev-subpage"], [data-command="next-subpage"]').forEach(button => { button.disabled = !hasSubpages; });
}


// & Render each found page in the page selection form
function renderPageSelect() {
    elements.pageSelect.innerHTML = "";

    for (const number of viewer.pageNumbers) {
        const count = viewer.pagesByNumber.get(number).length;
        const option = document.createElement("option");
        option.value = number;
        option.textContent = count > 1 ? `P${number} (${count} subpages)` : `P${number}`;
        elements.pageSelect.append(option);
    }

    elements.pageSelect.disabled = false;
}


// & Page commands
const commands = {
    "hold": toggleHold,
    "reveal": toggleReveal,
    "boxed": toggleBoxedView,
    "next-page": () => stepPage(1),
    "prev-page": () => stepPage(-1),
    "next-subpage": () => stepSubpage(1),
    "prev-subpage": () => stepSubpage(-1)
};


// Button event listener
document.addEventListener("click", event => {
    const button = event.target.closest("[data-command], [data-digit]");
    if (!button || button.disabled) return;
    if (button.dataset.digit !== undefined) typeDigit(button.dataset.digit);
    else commands[button.dataset.command]?.();
});


// Keyboard event listeners
document.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest("input, select, textarea")) return;
    if (event.target.closest("button") && (event.key === "Enter" || event.key === " ")) return;

    const screenHasFocus = document.activeElement === elements.screen;
    const key = event.key;

    if (/^[0-9a-fA-F]$/.test(key)) typeDigit(key);
    else if (key === ".") toggleHold();
    else if (key === "r" || key === "R") toggleReveal();
    else if (key === "x" || key === "X") toggleBoxedView();
    else if (key === "Escape") cancelEntry();
    else if (key === "+" || key === "PageUp") stepPage(1);
    else if (key === "-" || key === "PageDown") stepPage(-1);
    else if (screenHasFocus && key === "ArrowUp") stepPage(1);
    else if (screenHasFocus && key === "ArrowDown") stepPage(-1);
    else if (screenHasFocus && key === "ArrowRight") stepSubpage(1);
    else if (screenHasFocus && key === "ArrowLeft") stepSubpage(-1);
    else return;

    event.preventDefault();
});

// If picking a page from the dropdown menu, make the viewer behave the same way as typing the page number; go to that page
elements.pageSelect.addEventListener("change", () => goToPage(elements.pageSelect.value));

// If the rolling headers box is unchecked, end any page search and restore displayed page's own header
elements.rollingOption.addEventListener("change", () => {
    if (elements.rollingOption.checked) return;

    if (viewer.search) {
        if (viewer.search.isFound) showPage(viewer.requestedNumber);
        else {
            viewer.search = null;
            announceNotFound(viewer.requestedNumber);
        }
    }

    viewer.headerSource = displayedSubpage()?.rows[0] ?? null;
    render();
});


// Change aspect ratio of viewer
elements.aspectOption.addEventListener("change", () => {
    elements.screen.classList.toggle("tv-aspect", elements.aspectOption.checked);
});


// Go to the page that follows the URL hash (e.g. #110) when it's edited or if a page link is clicked
window.addEventListener("hashchange", () => {
    const number = pageNumberFromHash();
    if (number && number !== viewer.displayed?.number) goToPage(number);
});


// If reduced motion is enabled, keep the header still and keep text static; option to change available
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    elements.rollingOption.checked = false;
    elements.flashOption.checked = false;
}
elements.screen.classList.toggle("tv-aspect", elements.aspectOption.checked);

fitViewerFontToCell();
render();
renderControls();
setInterval(tick, TICK_MS);

document.fonts?.load(VIEWER_FONT).then(() => {
    fitViewerFontToCell();
    render();
}).catch(() => { });

const requestedSample = sampleFromURL();
if (requestedSample) {
    showServiceBanner(requestedSample.service);
    openSample(requestedSample);
}