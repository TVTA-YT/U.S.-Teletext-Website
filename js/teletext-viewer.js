"use strict";

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

const NOT_FOUND_TICKS = 30;
const PAGES_API_BASE = "/api/teletext";
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
    reconstructOption: getElement("optReconstruct"),
    realSearchOption: getElement("optRealSearch"),
    rowRevealOption: getElement("optRowReveal"),
    unscrambleOption: getElement("optUnscramble"),
    lightImageBanner: getElement("lightImageBanner"),
    darkImageBanner: getElement("darkImageBanner"),
    sampleTitle: getElement("sample-title"),
    contributor: getElement("contributor"),
    contributorName: getElement("contributor-name")
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
    rollingPagesByMagazine: new Map(),
    headerPositions: new Map(),
    requestedNumber: "100",
    displayed: null,
    headerSource: null,
    headerNumber: null,
    headerTemplates: new Map(),
    clockStartSeconds: 0,
    loadedAt: 0,
    reveal: null,
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
            if (subpage.rows[0]) viewer.headersByMagazine.get(magazine).push({ row: subpage.rows[0], number });
        }
    }

    // The order pages come round in the rolling header. Every page in the magazine once, in page order.
    // * Pages whose header wasn't received still take their turn so a search can always reach them
    viewer.rollingPagesByMagazine = new Map();
    for (const number of viewer.pageNumbers) {
        const magazine = number[0];
        if (!viewer.rollingPagesByMagazine.has(magazine)) viewer.rollingPagesByMagazine.set(magazine, []);

        const row = pagesByNumber.get(number).find(subpage => subpage.rows[0])?.rows[0] ?? null;
        viewer.rollingPagesByMagazine.get(magazine).push({ number, row });
    }

    viewer.loadState = "loaded";
    viewer.sourceName = sourceName;
    viewer.displayed = null;
    viewer.headerSource = null;
    viewer.headerNumber = null;
    viewer.headerTemplates = buildHeaderTemplates(viewer.headersByMagazine);
    viewer.loadedAt = Date.now();
    viewer.search = null;
    viewer.entryDigits = "";
    viewer.isHolding = false;

    elements.sourceName.textContent = sourceName;
    renderPageSelect();

    const subpageCount = [...pagesByNumber.values()].reduce((total, subpage) => total + subpage.length, 0);
    announce(`Opened ${sourceName}: ${viewer.pageNumbers.length} pages, ${subpageCount} subpages.`);

    // Start with P100; otherwise, start with first page
    const startNumber = pageNumberFromHash() ?? (pagesByNumber.has("100") ? "100" : viewer.pageNumbers[0]);

    // Start the rolling header just before the first page, so it doesn't take a whole cycle to appear
    const startPages = viewer.rollingPagesByMagazine.get(startNumber[0]) ?? [];
    viewer.headerPositions.set(startNumber[0], startPages.findIndex(page => page.number === startNumber) - 1);

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

        // The image heading banner to show is determined by the dataset key (e.g. "electra", "keyfax", etc.)
        showServiceBanner(service);

        // The sample title, sample date, and sample contributor come from R2
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


// Filenames for each image heading
const BANNER_NAMES = {
    datavizion: "DaTaVizion",
    electra: "Electra",
    keyfax: "Keyfax",
    sssTeletext: "SSS_Teletext",
    virtext: "Virtext",
    wisconsinInfotextTeletext: "WISINFOTEXT"
};


// & Show the service's banner in the page heading
function showServiceBanner(service) {
    const bannerService = BANNER_NAMES[service];
    if (!bannerService) return;

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
    const months = [
        "Jan.", "Feb.", "Mar.",
        "Apr.", "May", "June",
        "July", "Aug.", "Sept.",
        "Oct.", "Nov.", "Dec."
    ];
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


/*
* *** ! SportScreen descrambling ! ***
* On Later Electra samples, there are pages for sports subscription services: SportScreen, HSW, SuperSCREEN, and CSW.
* Rows 1-22 were scrambled so only their own decoders could read them. The scrambled lines appear as random text and mosaic characters.
* These services shared the same encryption system.
* Each 7-bit character is XORed with a 20-column pattern that starts at column 3; nothing else changes it. XOR undoes itself, so the same step scrambles the page again
*/

// ! Key for descrambling SportScreen pages
const SPORTSCREEN_KEY = [
    0x04, 0x05, 0x3e, 0x06,
    0x0a, 0x08, 0x09, 0x09,
    0x08, 0x0a, 0x06, 0x3e,
    0x05, 0x04, 0x03, 0x20,
    0x01, 0x01, 0x20, 0x03
];

// ! The first and last rows to look at
const SPORTSCREEN_FIRST_ROW = 1;
const SPORTSCREEN_LAST_ROW = 22;

// ! Row 23 is partially left alone because the phone number is plaintext, but the text before it is de-scrambled
const SPORTSCREEN_FOOTER_ROW = 23;

const sportScreenKeyFor = column => SPORTSCREEN_KEY[(column - 3 + SPORTSCREEN_KEY.length) % SPORTSCREEN_KEY.length];

// & Count blank cells both ways: plain spaces, and spaces scrambled with their column's key
function countSportScreenBlanks(rows) {

    // Get raw row counts
    let readableBlanks = 0;
    let scrambledBlanks = 0;

    // Examine only the SportScreen rows
    for (let rowNumber = SPORTSCREEN_FIRST_ROW; rowNumber <= SPORTSCREEN_LAST_ROW; rowNumber++) {

        // Examine each row. Defensive programming applied so an empty array is used if "pageRows[rowNumber]" doesn't exist
        (rows[rowNumber] ?? []).forEach((byteValue, column) => {

            // Assign normal spaces to "readableBlanks"
            if (byteValue === SPACE) readableBlanks++;

            // Detect a scrambled space
            else if (byteValue === (SPACE ^ sportScreenKeyFor(column))) scrambledBlanks++;
        });
    }
    return { readableBlanks, scrambledBlanks };
}

// & Determine if the current page is a scrambled page, regardless of whether it has been unscrambled (bytes 00 21 in columns 38-39)
// * A page still scrambled is also recognized by a row's worth of scrambled spaces
function isSportScreenPage(rows) {
    const footer = rows[SPORTSCREEN_FOOTER_ROW] ?? [];
    if (footer[38] === (SPACE ^ sportScreenKeyFor(38)) && footer[39] === (SPACE ^ sportScreenKeyFor(39))) return true;
    if (String.fromCharCode(...footer).includes("SportScreen")) return true;

    const { readableBlanks, scrambledBlanks } = countSportScreenBlanks(rows);
    return scrambledBlanks >= COLUMN_COUNT && scrambledBlanks > readableBlanks;
}

// & Scrambled pages show their blank cells as each column's key XOR space instead of spaces
function isSportScreenScrambled(rows) {
    const { readableBlanks, scrambledBlanks } = countSportScreenBlanks(rows);
    return scrambledBlanks > readableBlanks;
}

// ^ There are 8 columns in the SportScreen footer that are scrambled. Store only these columns
const SPORTSCREEN_CODE_COLUMNS = 8;

// ^ 3 categories of valid code characters: spaces (0x20), numbers (0x30 - 0x39), and uppercase letters (A-Z)
const isCodeCharacter = byteValue => byteValue === SPACE || (byteValue >= 0x30 && byteValue <= 0x39) || (byteValue >= 0x41 && byteValue <= 0x5a);

// ^ Apply the XOR de-scrambling code only those specific columns in the footer
const toggledFooterCode = footer => footer.map((byteValue, column) => column < SPORTSCREEN_CODE_COLUMNS ? byteValue ^ sportScreenKeyFor(column) : byteValue);

// & Determine if the code is scrambled
function isFooterCodeScrambled(footer) {

    // Take first 8 bytes, keep only bytes that look like valid characters, then count them
    const codeCharacters = rowBytes => rowBytes.slice(0, SPORTSCREEN_CODE_COLUMNS).filter(isCodeCharacter).length;

    // Compare columns before and after toggling
    return codeCharacters(toggledFooterCode(footer)) > codeCharacters(footer);
}

/*
* *** ! Mel Stewart's Picks descrambling ! *** ----
* On later Electra samples, Mel Stewart's Picks used a different encryption scheme.
* Each character's last three bits are swapped in pairs (1 becomes 4, 2 becomes 7, and 3 becomes 6, for example; this is based on XOR 5.
* Characters ending in 0 or 5 are left alone. So "CJJQGDII" is FOOTBALL, while spaces, P, H, E and M look untouched.
* It applies to every row except the header.
* These pages have no noticeable blank pattern, so they are recognized by words; this means that un-swapping must turn up common words such as these: "THE", "FOR", "CALL", and "FINAL").
*/

// ^ Start with the first and last rows
const LETTER_SWAP_FIRST_ROW = 1;
const LETTER_SWAP_LAST_ROW = 24;

// ^ 3 recognizable words must be detected at minimum for decryption to be applied
const LETTER_SWAP_MIN_WORDS = 3;

// ! This is required for the letter swap. If this wasn't here, every row would be affected regardless of whether it used letter-swap
const LETTER_SWAP_WORDS = new Set(`THE AND FOR OF TO IS IN ON AT BY OR NOT ARE ALL CALL CALLS FREE NEWS ONLY WITH FROM THIS
    THAT YOUR YOU OUR DAY DAYS WEEK TODAY TIME TIMES LINE LINES OPEN FINAL SCORE SCORES GAME GAMES PICKS PICK BEST PLAY PLAYS
    SPORTS FOOTBALL BASKETBALL BASEBALL HOCKEY COLLEGE NFL NBA NHL OVER UNDER TOTAL EASTERN INFORMATION MATTER LAWS`.split(/\s+/)
);

// ^ Swap the binary bits. Only the last low 7 bits need to be XOR'd. Flip only bits 0 and 2 (e.g. 010 becomes 111 and 011 becomes 110)
// * Control characters are not to be swapped. If the bottom 3 bits are 000 and 101, leave it alone
const swapLetterBits = byteValue => (byteValue < SPACE || [0, 5].includes(byteValue & 7) ? byteValue : byteValue ^ 5);

// & How many common words a page's text contains
function countCommonWords(rows) {
    let text = "";

    // Extract rows 1-24
    for (let rowNumber = LETTER_SWAP_FIRST_ROW; rowNumber <= LETTER_SWAP_LAST_ROW; rowNumber++) {
        text += String.fromCharCode(...(rows[rowNumber] ?? []).map(byteValue => {

            // Converted to printable ASCII characters
            const value = byteValue & SEVEN_BIT_MASK;
            return value >= SPACE && value < 0x7f ? value : SPACE;
        })) + " ";
    }
    return (text.match(/[A-Za-z]+/g) ?? []).filter(word => LETTER_SWAP_WORDS.has(word.toUpperCase())).length;
}

// ^ Create rows with the letter swap applied
const letterSwappedRows = rows => rows.map((rowBytes, rowNumber) =>
    rowBytes && rowNumber >= LETTER_SWAP_FIRST_ROW && rowNumber <= LETTER_SWAP_LAST_ROW
        ? rowBytes.map(byteValue => swapLetterBits(byteValue & SEVEN_BIT_MASK))
        : rowBytes);

// & Figure out if the current page is scrambled with letter-swap. The page must reveal many more common words than it currently shows
function isLetterSwapped(rows) {

    // Get how many recognizable words are visible
    const shownWords = countCommonWords(rows);

    // Get how many recognizable words appear if the letter-swap is applied
    const swappedWords = countCommonWords(letterSwappedRows(rows));

    // Return the swapped words
    return swappedWords >= LETTER_SWAP_MIN_WORDS && swappedWords > shownWords * 2;
}


// Remember which subpages are letter-swapped, since the word check would otherwise run on every frame
const letterSwapCheck = new WeakMap();
const isLetterSwappedSubpage = subpage => {
    if (!letterSwapCheck.has(subpage)) letterSwapCheck.set(subpage, isLetterSwapped(subpage.rows));
    return letterSwapCheck.get(subpage);
};

// & The rows to show for a subpage: scrambled pages are unscrambled or scrambled to match the option
// * A letter-swapped page already unscrambled in the editor can't be told apart from ordinary text, so it stays readable
function displayRowsFor(subpage) {

    // User preferences
    const rows = subpage?.rows;
    const wantsReadable = elements.unscrambleOption?.checked ?? true;

    // If a letter-swapped page, decode using the letter-swap method and return decoded text
    if (rows && !isSportScreenPage(rows) && isLetterSwappedSubpage(subpage)) return wantsReadable ? letterSwappedRows(rows) : rows;

    // Ignore pages that don't require de-scrambling
    if (!rows || !isSportScreenPage(rows)) return rows ?? null;

    // Toggle the decoder depending on the user's input (keep original or de-scramble)
    const togglesBody = isSportScreenScrambled(rows) === wantsReadable;

    // Do the same as above, but for the footer row
    const footer = rows[SPORTSCREEN_FOOTER_ROW];
    const togglesCode = Boolean(footer) && isFooterCodeScrambled(footer) === wantsReadable;

    // Return original rows if nothing needs to be changed
    if (!togglesBody && !togglesCode) return rows;

    // Create new copy of the page with decoded text and graphics
    return rows.map((rowBytes, rowNumber) => {

        // Preserve missing rows
        if (!rowBytes) return rowBytes;

        // Apply separate de-scrambling for the footer since it's a mix of XOR and plaintext
        if (rowNumber === SPORTSCREEN_FOOTER_ROW) return togglesCode ? toggledFooterCode(rowBytes) : rowBytes;

        // XOR relevant rows and return them
        return togglesBody && rowNumber >= SPORTSCREEN_FIRST_ROW && rowNumber <= SPORTSCREEN_LAST_ROW
            ? rowBytes.map((byteValue, column) => byteValue ^ sportScreenKeyFor(column))
            : rowBytes;
    });
}


// & Draw rows as they "arrive", top to bottom, like how a decoder would've received the page (inspired by VHS-Teletext's viewer).
// * NOTE: Rows not yet drawn show what was on screen before: nothing after a page change, or the previous subpage when the carousel moves on, unless the new subpage has the erase flag (C4)

// This value is per row, so loading a full page takes about 0.6 seconds
const ROW_REVEAL_MS = 25;
const ERASE_FLAG = 4;


// & Start revealing the page
function startReveal(oldRows) {
    if (!elements.rowRevealOption?.checked) {
        viewer.reveal = null;
        return;
    }

    const isFirstFrame = viewer.reveal === null;
    viewer.reveal = { startedAt: performance.now(), oldRows: oldRows ?? blankRows() };
    if (isFirstFrame) requestAnimationFrame(stepReveal);
}


// & Incrementally step the revealing ("drawing") of the page
function stepReveal() {
    if (!viewer.reveal) return;
    render();

    if (revealedRowCount() < ROW_COUNT) requestAnimationFrame(stepReveal);
    else {
        viewer.reveal = null;
        render();
    }
}

const revealedRowCount = () => Math.floor((performance.now() - viewer.reveal.startedAt) / ROW_REVEAL_MS) + 1;


// & The body rows to draw right now: received rows up to the reveal point, the old screen below it
function rowsOnScreen(rows) {
    if (!viewer.reveal) return rows;
    const shownRows = revealedRowCount();
    return rows.map((rowBytes, rowNumber) => (rowNumber <= shownRows ? rowBytes : viewer.reveal.oldRows[rowNumber]));
}


// & Show requested page (first subpage if page has subpages)
function showPage(number) {
    viewer.displayed = { number, subpageIndex: 0 };
    viewer.search = null;
    viewer.subpageTicks = 0;
    viewer.headerSource = displayedSubpage().rows[0];
    viewer.headerNumber = number;

    history.replaceState(null, "", `#${number}`);
    startReveal(null);   // a new page starts from a blank screen
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
    const previousRows = displayRowsFor(displayedSubpage());
    viewer.displayed.subpageIndex = (viewer.displayed.subpageIndex + direction + count) % count;
    startReveal(displayedSubpage().flags.includes(ERASE_FLAG) ? null : previousRows);
    viewer.subpageTicks = 0;
    if (!elements.rollingOption.checked) {
        viewer.headerSource = displayedSubpage().rows[0];
        viewer.headerNumber = viewer.displayed.number;
    }

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


// & De-scramble or re-scrambled certain scrambled pages
function toggleUnscramble() {
    if (!elements.unscrambleOption) return;
    elements.unscrambleOption.checked = !elements.unscrambleOption.checked;
    elements.unscrambleOption.dispatchEvent(new Event("change"));
    announce(elements.unscrambleOption.checked ? "Showing scrambled pages as unscrambled, as seen with a required decoder." : "Showing scrambled pages as seen without a decoder.");
}


// & Roll the header on to the next page transmitted in the requested page's magazine
// * Pages come round in page order and wrap back to the start of the magazine, as in a real transmission cycle
function rollHeader() {
    const magazine = viewer.requestedNumber[0];
    const pages = viewer.rollingPagesByMagazine.get(magazine);

    // Keep header as it is if there is nothing in a magazine
    if (!pages?.length) return false;

    const position = ((viewer.headerPositions.get(magazine) ?? -1) + 1) % pages.length;
    viewer.headerPositions.set(magazine, position);

    const { number, row } = pages[position];
    viewer.headerNumber = number;

    // Keep the last received header text if this page's wasn't received
    if (row) viewer.headerSource = row;
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
        const hasRolled = elements.rollingOption.checked && viewer.tickCount % HEADER_TICKS === 0 && rollHeader();
        if (hasRolled) needsDraw = true;

        if (viewer.search) {
            viewer.search.tickWaited++;
            viewer.search.ticksLeft--;

            // Realistic search: the page appears when the rolling header reaches it. Otherwise it appears after a short wait
            const waitsForPage = elements.rollingOption.checked && elements.realSearchOption?.checked;
            const hasArrived = waitsForPage
                ? viewer.search.isFound && hasRolled && viewer.headerNumber === viewer.requestedNumber
                : viewer.search.ticksLeft <= 0;

            if (hasArrived) {
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

    // The reconstructed clock needs a redraw once a second
    if (elements.reconstructOption?.checked && hasCapture() && viewer.tickCount % (1000 / TICK_MS) === 0) needsDraw = true;

    if (needsDraw) render();
}


// *** ! Reconstructed header ! ***

// ^ Columns 8-39 carry the service's header text
const HEADER_TEXT_START = 8;

// ^ T34 rows can lose columns 32-39
const SERVICE_NAME_START = 32;

// ^ The clock pattern to replicate. This can slightly differ (e.g. "18:47:00", "18:47.00", or "18 47/00")
const CLOCK_PATTERN = /^\d\d\D\d\d\D\d\d$/;       // 18:47:59, 18:39.28, 12 45/12 (any separators)

const SECONDS_PER_DAY = 24 * 60 * 60;

const headerText = row => String.fromCharCode(...row.map(byteValue => byteValue & SEVEN_BIT_MASK));

// & The most common value in a list
function mostCommon(values) {
    const counts = new Map();
    let best = SPACE;
    let bestCount = 0;

    for (const value of values) {
        const count = (counts.get(value) ?? 0) + 1;
        counts.set(value, count);
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }

    return best;
}

// & Build a clean header by taking the most common byte in each column across many damaged copies
function voteHeader(rows) {
    const template = makeRows("");
    for (let column = HEADER_TEXT_START; column < COLUMN_COUNT; column++) {
        template[column] = mostCommon(rows.map(row => row[column] & SEVEN_BIT_MASK));
    }
    return template;
}

const clockToSeconds = ([hours, minutes, seconds]) => hours * 3600 + minutes * 60 + seconds;

// & Read "HH?MM?SS" at a column as seconds since midnight, or null if it isn't a real time
function readClock(row, column) {
    const clockText = headerText(row).slice(column, column + 8);
    if (!CLOCK_PATTERN.test(clockText)) return null;

    const [hours, minutes, seconds] = [0, 3, 6].map(offset => Number(clockText.slice(offset, offset + 2)));
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    return clockToSeconds([hours, minutes, seconds]);
}


// & Find the clock: the time-shaped field whose value changes between headers.
// * A date such as 04.24.84 is the same shape, but "84" isn't a valid number of seconds and a date doesn't change
function findClock(template, rows, pageColumn) {
    let best = null;

    for (let column = HEADER_TEXT_START; column <= COLUMN_COUNT - 8; column++) {
        // Skip anything overlapping the page number, whose digits also change between headers
        const overlapsPage = pageColumn !== null && column < pageColumn + 3 && column + 8 > pageColumn;
        if (overlapsPage || readClock(template, column) === null) continue;

        const times = rows.map(row => readClock(row, column)).filter(seconds => seconds !== null);
        const changes = new Set(times).size > 1 || rows.length === 1;

        if (changes && times.length > (best?.times.length ?? 0)) best = { column, times };
    }

    return best;
}


// & Find the page number: the 3-character field that matches the page each header was received with.
// * Works with or without a "P" in front (P100 or 100)
function findPageColumn(headers) {
    let bestColumn = null;
    let bestMatches = 0;

    for (let column = HEADER_TEXT_START; column <= COLUMN_COUNT - 3; column++) {
        const matches = headers.filter(header => headerText(header.row).slice(column, column + 3).toUpperCase() === header.number).length;
        if (matches > bestMatches) {
            bestColumn = column;
            bestMatches = matches;
        }
    }

    // Needs to match at least half the headers, so a stray number elsewhere isn't mistaken for it
    return bestMatches * 2 >= headers.length ? bestColumn : null;
}


// & Where the clock and page number sit in a template, and every clock time read from the received headers
function describeTemplate(template, headers) {
    const rows = headers.map(header => header.row);
    const pageColumn = findPageColumn(headers);
    const clock = findClock(template, rows, pageColumn);

    return {
        template,
        clockColumn: clock?.column ?? null,
        times: clock?.times ?? [],
        pageColumn
    };
}

// & Full screen for the TV screen. Safari on older iPads needs the "webkit" versions
const canUseFullscreen = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

function toggleFullscreen() {
    if (!canUseFullscreen) return;

    const action = fullscreenElement()
        ? (document.exitFullscreen ?? document.webkitExitFullscreen).call(document)
        : (elements.screen.requestFullscreen ?? elements.screen.webkitRequestFullscreen).call(elements.screen);

    Promise.resolve(action).catch(() => announce("Full screen isn't available right now."));
}

// & Keep the button in step however full screen was entered or left (including the Esc key)
function handleFullscreenChange() {
    const isFullscreen = fullscreenElement() === elements.screen;
    document.querySelectorAll('[data-command="fullscreen"]').forEach(button => button.setAttribute("aria-pressed", String(isFullscreen)));

    // Focus the screen so the arrow keys work straight away
    if (isFullscreen) elements.screen.focus();
    announce(isFullscreen ? "Full screen on. Press Escape to exit." : "Full screen off.");
}

document.addEventListener("fullscreenchange", handleFullscreenChange);
document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

// Hide the button where full screen isn't supported (iPhone Safari)
document.querySelectorAll('[data-command="fullscreen"]').forEach(button => { button.hidden = !canUseFullscreen; });


// & One reconstructed header per magazine
function buildHeaderTemplates(headersByMagazine) {
    const allRows = [...headersByMagazine.values()].flat().map(header => header.row);

    // Headers that still have their last 8 columns, for magazines that lost them
    const hasServiceName = row => row.slice(SERVICE_NAME_START).some(byteValue => (byteValue & SEVEN_BIT_MASK) !== SPACE);
    const completeRows = allRows.filter(hasServiceName);
    const serviceName = completeRows.length ? voteHeader(completeRows).slice(SERVICE_NAME_START) : null;

    const templates = new Map();
    const allTimes = [];

    for (const [magazine, headers] of headersByMagazine) {
        const rows = headers.map(header => header.row);
        const template = voteHeader(rows);
        const details = describeTemplate(template, headers);

        // Only rebuild magazines whose header has a clock; anything else keeps its received headers
        if (details.clockColumn === null) continue;
        if (serviceName && !hasServiceName(template)) template.splice(SERVICE_NAME_START, serviceName.length, ...serviceName);

        templates.set(magazine, details);
        allTimes.push(...details.times);
    }

    // One clock for the whole sample, so it doesn't jump between magazines. Start from the middle time received
    allTimes.sort((first, second) => first - second);
    viewer.clockStartSeconds = allTimes[Math.floor(allTimes.length / 2)] ?? 0;

    return templates;
}

// & A clean header for this page, with a running clock that starts from the capture's time
function reconstructedHeader(pageNumber) {
    const details = viewer.headerTemplates.get(pageNumber[0]);
    if (!details) return null;

    const row = details.template.slice();

    const elapsed = Math.floor((Date.now() - viewer.loadedAt) / 1000);
    const total = (viewer.clockStartSeconds + elapsed) % SECONDS_PER_DAY;
    const digits = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
        .map(value => String(value).padStart(2, "0")).join("");

    // Keep the service's own separators (":" or ".") and only replace the digits
    [0, 1, 3, 4, 6, 7].forEach((offset, index) => { row[details.clockColumn + offset] = digits.charCodeAt(index); });

    if (details.pageColumn !== null) {
        [...pageNumber].forEach((character, index) => { row[details.pageColumn + index] = character.charCodeAt(0); });
    }

    return row;
}


// & Build header row; columns 0-7 show the page number the user requested (e.g. "P1...") or "HOLD" when hold is enabled
// * Columns 8-39 comes from whichever page header was last received
function buildHeaderRow() {
    const reconstructed = elements.reconstructOption?.checked ? reconstructedHeader(viewer.headerNumber ?? viewer.requestedNumber) : null;
    const sourceHeader = reconstructed ?? viewer.headerSource ?? displayedSubpage()?.rows[0] ?? null;
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
    const bodyRows = rowsOnScreen(displayRowsFor(subpage) ?? blankRows());
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
    elements.pageText.textContent = pageToText(displayRowsFor(subpage), { revealConcealed: viewer.isRevealing }) || "This page has no text to display.";
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


// & Render the selected page
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
    "prev-subpage": () => stepSubpage(-1),
    "fullscreen": toggleFullscreen
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
    else if (key === "u" || key === "U") toggleUnscramble();
    else if (key === "v" || key === "V") toggleFullscreen();
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

elements.pageSelect.addEventListener("change", () => goToPage(elements.pageSelect.value));

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
    viewer.headerNumber = viewer.displayed?.number ?? null;
    render();
});

elements.reconstructOption?.addEventListener("change", render);

elements.unscrambleOption?.addEventListener("change", () => {
    render();

    // The plaintext version of the page also follows the option
    renderPageDetails();
});


// Change aspect ratio of viewer
elements.aspectOption.addEventListener("change", () => {
    elements.screen.classList.toggle("tv-aspect", elements.aspectOption.checked);
});


window.addEventListener("hashchange", () => {
    const number = pageNumberFromHash();
    if (number && number !== viewer.displayed?.number) goToPage(number);
});


// If reduced motion is enabled, keep the header still and keep text static; option to change available
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    elements.rollingOption.checked = false;
    elements.flashOption.checked = false;
    if (elements.rowRevealOption) elements.rowRevealOption.checked = false;
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
if (requestedSample) openSample(requestedSample);