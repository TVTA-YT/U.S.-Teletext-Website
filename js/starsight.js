function getQueryParameters() {
    return new URLSearchParams(window.location.search);
}

// Base URL (none since the site is hosted on Cloudflare and will fetch data from there)
const WORKER_BASE = "";

// API call
const API_BASE = `${WORKER_BASE}/api/poster`;

// Cache poster lookups so the same program title isn't fetched more than once per session
const posterCache = new Map();

// & Some programs use an ampersand, but the data uses the word "and"; swap them if there is no exact match
function swapAmpersand(title) {
    if (/\band\b/i.test(title)) {
        return title.replace(/\band\b/i, "&");
    }
    if (title.includes("&")) {
        return title.replace("&", "and");
    }
    return null;
}

// & Look up a poster URL for a program title using the Worker's "/api/poster" route
async function fetchPosterUrl(title, year) {

    // Check cache first
    if (posterCache.has(title)) return posterCache.get(title);

    // & Make the API request
    async function lookup(t) {
        const params = new URLSearchParams({ title: t });
        if (year) params.set("year", year);
        const response = await fetch(`${API_BASE}?${params}`);
        const result = await response.json();
        return result.poster ?? null;
    }

    let posterUrl = null;

    // Find the poster image for the specific program
    try {
        posterUrl = await lookup(title);

        // If the exact title didn't match, try swapping "and" for an ampersand
        if (!posterUrl) {
            const altTitle = swapAmpersand(title);
            if (altTitle) posterUrl = await lookup(altTitle);
        }
    } catch (err) {
        console.warn("Poster lookup failed:", title, err);
    }

    // Save the result in cache
    posterCache.set(title, posterUrl);
    return posterUrl;
}

// ^ Light/dark TV rating icons
const RATING_ICONS = {
    "TV-Y": {
        light: "../images/rating-icons/TV-Y.png",
        dark: "../images/rating-icons/TV-Y_white.png"
    },
    "TV-Y7": {
        light: "../images/rating-icons/TV-Y7.png",
        dark: "../images/rating-icons/TV-Y7_white.png"
    },
    "TV-Y7-FV": {
        light: "../images/rating-icons/TV-Y7-FV.png",
        dark: "../images/rating-icons/TV-Y7-FV_white.png"
    },
    "TV-G": {
        light: "../images/rating-icons/TV-G.png",
        dark: "../images/rating-icons/TV-G_white.png"
    },
    "TV-G": {
        light: "../images/rating-icons/TV-G.png",
        dark: "../images/rating-icons/TV-G_white.png"
    },
    "TV-14": {
        light: "../images/rating-icons/TV-14.png",
        dark: "../images/rating-icons/TV-14_white.png"
    },
    "TV-MA": {
        light: "../images/rating-icons/TV-MA.png",
        dark: "../images/rating-icons/TV-MA_white.png"
    }
};

// & Display light/dark icons based on which is active
function isDarkModeActive() {
    return document.documentElement.getAttribute("data-bs-theme") === "dark";
}

// ^ Image path for the closed captioned icon
const CC_ICON_PATH = "../images/rating-icons/CC.png";

// & Use local sample data instead
// ! This is for local development only. This does not run outside of there
async function loadData() {
    const jsonUrl = getQueryParameters().get("json");
    if (!jsonUrl) {
        console.error("Missing 'json' query parameter");
        return null;
    }
    const response = await fetch(jsonUrl);
    return response.json();
}

// ^ One EPG time slot is 30 minutes
const SLOT_MINUTES = 30;

// ^ Display 48 time slots (12:00am to 11:30pm)
const VISIBLE_SLOTS = 48;

// ^ For now, the schedule starts at 12:00am
const DAY_START_MINUTES = 0;

// ^ Standard (non-DST) UTC offset for PTZ stations only
// ! This is used as a fallback for now
const STANDARD_UTC_OFFSET_MINUTES = -480;
const DST_ADJUSTMENT_MINUTES = 60;

let currentData = null;
let currentDateString = null;

// & Calculate minutes since midnight
function formatTime(minutesOfDay) {

    const total = ((minutesOfDay % 1440) + 1440) % 1440;

    // Convert minutes to hours, fetch remaining minutes, convert 24-hour time to 12-hour, then display formatted time
    let hours = Math.floor(total / 60);
    const mins = total % 60;
    const period = hours >= 12 ? "P" : "A";
    hours = hours % 12 || 12
    return `${hours}${mins === 0 ? "" : ":" + String(mins).padStart(2, "0")}${period}`;
}

// & Keep channel column vertically synchronized with the program grid
function syncServiceColumnScroll() {
    document.querySelector(".guide-scroll").addEventListener("scroll", (e) => {
        document.querySelector(".service-column").scrollTop = e.target.scrollTop;
    });
}

// & Build the EPG time slots
function buildTimeRow() {
    const timeRow = document.getElementById("time");
    timeRow.innerHTML = "";
    document.querySelector(".time-row").style.gridTemplateColumns = `repeat(${VISIBLE_SLOTS}, var(--slot-width))`;

    // Loop through the 48 time slots and put them in their own DIV elements. Calculate the timeslot (e.g. 0 minutes is 12:00am)
    for (let i = 0; i < VISIBLE_SLOTS; i++) {
        const div = document.createElement("div");
        div.textContent = formatTime(DAY_START_MINUTES + i * SLOT_MINUTES);
        timeRow.appendChild(div);
    };
}

// & Convert numerical date (e.g. 1994-05-03) to a readable date (e.g. Tuesday, May 3, 1994) to use in a table heading
function formatDateDisplay(dateString) {

    // The second parameter in "Date" adds UTC to the date, which prevents accidental timezone changes
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
        timeZone: "UTC",
    });
}

// & Convert the date into a label that will be used for the clickable dates on the table
function formatDayButtonLabel(dateString) {

    // Create UTC Date object then return the formatted date (e.g. Tue, May 4)
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
    });
}

// & Convert the date into a label that includes the year; this is used when searching for a program
function formatSearchResultDateLabel(dateString) {
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC"
    });
}

// & Convert the date into a label that will be used for date column to the left of the table
function formatDayColumnLabel(dateString) {

    // Create UTC Date object then return the formatted date (e.g. May 4)
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        month: "short", day: "numeric", timeZone: "UTC",
    });
}

// & Check whether a given UTC timestamp falls inside one of the capture's daylight saving windows
function isDuringDaylightSaving(isoString, daylightSavingChanges) {
    const t = new Date(isoString).getTime();
    return daylightSavingChanges.some(change => {
        const start = new Date(change.starts).getTime();
        const end = new Date(change.ends).getTime();
        return t >= start && t < end;
    });
}

// & Standard (non-DST) UTC offset reported by the clock used by the transmitting station
// * If this is absent, fallback to PTZ
function getStandardOffsetMinutes(data) {
    const entry = (data.clock || []).find(c => Number.isFinite(c.utcOffsetMinutes));
    return entry ? entry.utcOffsetMinutes : STANDARD_UTC_OFFSET_MINUTES;
}

// & Determine the correct UTC offset for a specific listing, accounting for daylight saving
function getUtcOffsetMinutes(isoString, data) {
    const inDst = isDuringDaylightSaving(isoString, data.daylightSavingChanges || []);
    return getStandardOffsetMinutes(data) + (inDst ? DST_ADJUSTMENT_MINUTES : 0);
}

// & Create clickable list of available dates in the JSON
function buildDaySelection(data) {

    // Use the same local-date logic as everything else, so date buttons match what's actually rendered
    const dates = [...new Set(data.listings.map(l => listingLocalDate(l.start, data)))].sort();
    const container = document.querySelector(".day-selection");
    container.innerHTML = "";

    // Create a DIV for each date. The label will be the date. Clicking on it should show that day's programs.
    dates.forEach((dateString, index) => {
        const button = document.createElement("div");
        button.textContent = formatDayButtonLabel(dateString);
        button.style.cursor = "pointer";

        // The first date should automatically be selected
        if (index === 0) {
            button.classList.add("selected");
        }

        // Add the "selected" class to a clicked date
        button.addEventListener("click", () => {
            container.querySelectorAll(".selected").forEach(button => {
                button.classList.remove("selected");
            });

            button.classList.add("selected");

            // Show spinner when a date is clicked
            const overlay = document.getElementById("loadingOverlay");
            if (overlay) overlay.style.display = "";

            setTimeout(() => {
                renderGuideData(data, dateString);
                if (overlay) overlay.style.display = "none"
            }, 20);
        });
        container.appendChild(button);
    });

    return dates;
}

// & Convert ISO date/time string into minutes since midnight
function listingStartMinutes(isoString, data) {

    // Convert ISO into JS Date object
    const utcDate = new Date(isoString);
    const offset = getUtcOffsetMinutes(isoString, data);

    // Convert UTC time (e.g. 1994-05-03T13:00:00Z) into time since midnight
    const localMinutesOfDay = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes() + offset;

    /*
    * Convert number of minutes into value representing time of day which wraps around at midnight; also works for negative numbers
    * Keep time between 0 and 1439 minutes even when timezone conversion produces a negative value
    */
    return ((localMinutesOfDay % 1440) + 1440) % 1440
}

function listingLocalDate(isoString, data) {
    const date = new Date(isoString);
    const offset = getUtcOffsetMinutes(isoString, data);
    date.setUTCMinutes(date.getUTCMinutes() + offset);
    return date.toISOString().slice(0, 10);
}

// & Determine where each program should be placed inside the schedule
function computeGridPlacement(startMinutes, durationMinutes) {

    // Determine grid columns, then how many columns the program should occupy
    const startCol = Math.round((startMinutes - DAY_START_MINUTES) / SLOT_MINUTES) + 1;
    const span = Math.round(durationMinutes / SLOT_MINUTES);
    return { startCol, span };
}

// & Format a duration in minutes (e.g. "1 hr 30 min", "30 mins", or "1 hr")
function formatRuntime(durationMinutes) {
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
}

// Lookup maps built once per data load, reused by search instead of rebuilding per keystroke
let programByID = new Map();
let descriptionByID = new Map();
let channelsById = new Map();

// & Build lookup maps
function buildLookupMaps(data) {
    programByID = new Map(data.programs.map(p => [p.id, p]));
    descriptionByID = new Map(data.descriptions.map(d => [d.id, d]));
    channelsById = new Map(data.channels.map(c => [c.id, c]));
}

// & Find every listing whose program title contains the search query; find across all dates
function searchPrograms(query, data) {

    // Normalize search query. Do not search anything if no query
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return [];

    // Initialize array
    const matches = [];

    // Loop through every listing in the data
    for (const listing of data.listings) {

        // Find the program being searched
        const program = programByID.get(listing.program);

        // Ignore invalid programs
        if (!program || !program.title) continue;

        // Check whether the program title contains the search query
        if (!program.title.toLowerCase().includes(q)) continue;

        // Push results into the array
        matches.push({
            listing,
            program,
            description: listing.description ? descriptionByID.get(listing.description) : null
        });
    }

    return matches;
}

// ^ Limit only to 100 results
const MAX_SEARCH_RESULTS = 100;

// & Render search results as a clickable list, each program opening its own modal
function renderSearchResults(matches, data) {
    const container = document.getElementById("programSearchResults");
    container.innerHTML = "";

    // If no matches found, display message
    if (matches.length === 0) {
        container.innerHTML = "<li>No matching programs found</li>";
        return;
    }

    // Limit search results only to first 100
    matches.slice(0, MAX_SEARCH_RESULTS).forEach(match => {

        // Look up channel, assign display name, get listing date, get program start time, and create the time label
        const channel = channelsById.get(match.listing.channel);
        const channelName = getChannelDisplayName(channel, match.listing.channel);
        const dateString = listingLocalDate(match.listing.start, data);
        const startMinutes = listingStartMinutes(match.listing.start, data);
        const timeLabel = formatTime(startMinutes);

        // Create new list element for each program
        const item = document.createElement("li");
        item.className = "search-result";
        item.style.cursor = "pointer";
        item.textContent = `${match.program.title}  (${channelName} - ${formatSearchResultDateLabel(dateString)}, ${timeLabel})`;

        // When a program is clicked, the content modal will appear with the necessary information
        item.addEventListener("click", () => {
            showProgramModal({
                program: match.program,
                description: match.description,
                startMinutes,
                durationMinutes: match.listing.durationMinutes,
                channelId: match.listing.channel,
            });
        });

        container.appendChild(item);
    });

    // If more than 100 results, note it at the bottom of the list
    if (matches.length > MAX_SEARCH_RESULTS) {
        const notice = document.createElement("li");
        notice.style.fontStyle = "italic";
        notice.textContent = `Showing first ${MAX_SEARCH_RESULTS} of ${matches.length} results`;
        container.appendChild(notice);
    }
}

// & Create the search input; do not re-scan data on every keystroke
function setupProgramSearch(data) {
    const input = document.getElementById("programSearchInput");

    // Timer variable used below
    let debounceTimer = null;

    // Event listener that updates the list of programs while a value is being typed
    input.addEventListener("input", () => {

        // Cancel previous timer
        clearTimeout(debounceTimer);

        // The timer runs 200 ms after the user stops typing
        debounceTimer = setTimeout(() => {

            // Search for the programs after typing stops, then display the results
            const matches = searchPrograms(input.value, data);
            renderSearchResults(matches, data)
        }, 200);
    });
}

// & Take the data from the JSON and organize the programs by channel ID/name for a selected date
function buildChannelSchedules(data, targetDataString) {

    // Map program ID to its correct program. Do the same for program descriptins. Store in empty object
    const programByID = new Map(data.programs.map(p => [p.id, p]));
    const descriptionByID = new Map(data.descriptions.map(d => [d.id, d]));
    const channelSchedules = {};

    data.listings.forEach(listing => {

        // Only keep listings that belong to the date selected in the schedule
        if (listingLocalDate(listing.start, data) !== targetDataString) return;

        // Store the program title. If one doesn't exist, skip it
        const program = programByID.get(listing.program);
        if (!program || !program.title) return;

        // Make sure the program has a valid duration
        if (!listing.durationMinutes || listing.durationMinutes <= 0) return;

        // Get the channel ID
        const key = listing.channel;

        // Hold all programs that aired on a specific channel
        if (!channelSchedules[key]) channelSchedules[key] = [];

        // Push relevant details of each program to the respective channel array
        channelSchedules[key].push({
            program,
            description: listing.description ? descriptionByID.get(listing.description) : null,
            startMinutes: listingStartMinutes(listing.start, data),
            durationMinutes: listing.durationMinutes,
            channelId: key,
        });
    });

    return channelSchedules;
}

// & Create one row of program listings for each channel
function buildProgramRow(scheduleEntries) {
    const row = document.createElement("div");
    row.className = "program-row";
    row.style.gridTemplateColumns = `repeat(${VISIBLE_SLOTS}, var(--slot-width))`;

    // Copy the "scheduleEntries" array and sort it by start time
    const sorted = [...scheduleEntries].sort((a, b) => a.startMinutes - b.startMinutes);

    let nextExpectedCol = 1;

    sorted.forEach(entry => {

        // Calculate starting grid column and the number of columns occupied
        const { startCol, span } = computeGridPlacement(entry.startMinutes, entry.durationMinutes);

        if (!Number.isFinite(startCol) || !Number.isFinite(span) || span <= 0) return;
        if (startCol > VISIBLE_SLOTS) return;

        // Check if a program starts before the previous one has finished
        if (startCol < nextExpectedCol) {
            console.warn("Skipping overlapping listing:", entry);
            return;
        }

        // Fill gaps with no program information
        if (startCol > nextExpectedCol) {
            const filler = document.createElement("div");
            filler.className = "no-data";
            filler.style.gridColumn = `${nextExpectedCol} / span ${startCol - nextExpectedCol}`;
            filler.textContent = "NO DATA";
            row.appendChild(filler);
        }
        if (startCol > VISIBLE_SLOTS) return;

        // Calculate how many columns are left in the grid
        const maxSpan = VISIBLE_SLOTS - startCol + 1;
        const clampedSpan = Math.min(span, maxSpan);

        // Create the cells. Create CSS to place each column and make each grid clickable to show other info in a modal
        const cell = document.createElement("div");
        cell.textContent = entry.program.title;
        cell.style.gridColumn = `${startCol} / span ${clampedSpan}`;
        cell.style.cursor = "pointer";
        cell.addEventListener("click", () => showProgramModal(entry));
        row.appendChild(cell);

        // Update the location where the next program is expected to be placed. Do not extend programs past 11:30pm if they run long
        nextExpectedCol = startCol + clampedSpan;
    });

    // Check if there is empty space until the end of the grid. Filler grid occupies everything from the last program to the end of the guide
    if (nextExpectedCol <= VISIBLE_SLOTS) {
        const filler = document.createElement("div");
        filler.className = "no-data";
        filler.style.gridColumn = `${nextExpectedCol} / span ${VISIBLE_SLOTS - nextExpectedCol + 1}`;
        row.appendChild(filler);
    }

    return row;
}

//  & Build EPG guide for mobile devices
function buildMobileGuide(data, dateString) {
    const container = document.getElementById("starsight-guide-mobile");
    container.innerHTML = "";

    // Same as desktop. Get EPG data for the selected date and organize it by channel name or ID
    const channelSchedules = buildChannelSchedules(data, dateString);
    const channelsById = new Map(data.channels.map(c => [c.id, c]));
    const channelIds = Object.keys(channelSchedules);

    // CSS for the mobile grid
    container.style.gridTemplateColumns = `80px repeat(${channelIds.length}, 100px)`;
    container.style.gridTemplateRows = `40px repeat(${VISIBLE_SLOTS}, 60px)`;

    // Corner cell that acts as a divider and contains no data
    const corner = document.createElement("div");
    corner.className = "corner-cell";
    corner.style.gridRow = "1";
    corner.style.gridColumn = "1";
    container.appendChild(corner);

    // Create the row for the channel names/IDs
    channelIds.forEach((channelId, i) => {
        const channel = channelsById.get(Number(channelId));
        const header = document.createElement("div");
        header.classList.add("channel-header", "text-white");
        header.textContent = getChannelDisplayName(channel, channelId)
        header.style.gridRow = "1";
        header.style.gridColumn = String(i + 2);
        container.appendChild(header);
    });

    // Create the time slot labels
    for (let slot = 0; slot < VISIBLE_SLOTS; slot++) {
        const label = document.createElement("div");
        label.className = "time-label";
        label.classList.add("text-white");
        label.textContent = formatTime(DAY_START_MINUTES + slot * SLOT_MINUTES);
        label.style.gridRow = String(slot + 2);
        label.style.gridColumn = "1";
        container.appendChild(label);
    }

    // Loop through each channel
    channelIds.forEach((channelId, colIndex) => {

        // Sort programs by start time
        const sorted = [...channelSchedules[channelId]].sort((a, b) => a.startMinutes - b.startMinutes);
        let nextExpectedRow = 1;

        sorted.forEach(entry => {

            // Calculate starting grid row and the number of rows occupied
            const { startCol: startRow, span } = computeGridPlacement(entry.startMinutes, entry.durationMinutes);

            // If a starting row of program runtime can't be calculated, skip it
            if (!Number.isFinite(startRow) || !Number.isFinite(span) || span <= 0) return;
            if (startRow > VISIBLE_SLOTS) return;

            // Fill gaps with no program information
            if (startRow > nextExpectedRow) {
                const filler = document.createElement("div");
                filler.classList.add("no-data", "text-white");
                filler.style.gridRow = `${nextExpectedRow + 1} / span ${startRow - nextExpectedRow}`;
                filler.style.gridColumn = String(colIndex + 2);
                filler.textContent = "NO DATA";
                container.appendChild(filler);
            }

            // Calculate how many rows are left in the grid
            const maxSpan = VISIBLE_SLOTS - startRow + 1;
            const clampedSpan = Math.min(span, maxSpan);

            // Create the cells; same as desktop
            const cell = document.createElement("div");
            cell.className = "program";
            cell.textContent = entry.program.title;
            cell.style.gridRow = `${startRow + 1} / span ${clampedSpan}`;
            cell.style.gridColumn = String(colIndex + 2);
            cell.style.cursor = "pointer";
            cell.addEventListener("click", () => showProgramModal(entry));
            container.appendChild(cell);

            nextExpectedRow = startRow + clampedSpan;
        });

        // Same as desktop; fill empty cells
        if (nextExpectedRow <= VISIBLE_SLOTS) {
            const filler = document.createElement("div");
            filler.className = "no-data";
            filler.style.gridRow = `${nextExpectedRow + 1} / span ${VISIBLE_SLOTS - nextExpectedRow}`;
            filler.style.gridColumn = String(colIndex + 2);
            container.appendChild(filler);
        }
    });
}

// & Resolve the best available display name for a channel
function getChannelDisplayName(channel, channelId) {
    if (channel && channel.label) return channel.label;

    // Older captures (e.g. KCET-VBI) used "name"
    if (channel && channel.name) return channel.name;
    if (channel && channel.callSign) return channel.callSign;
    return `CH ${channelId}`;
}

// & Rendering and refreshing the EPG data
function renderGuideData(data, dateString) {

    currentData = data;
    currentDateString = dateString;

    // Clear all these elements before displaying a new schedule
    document.querySelectorAll(".service-column div:not(.service-header)").forEach(el => el.remove());
    document.querySelectorAll(".guide-scroll .program-row").forEach(el => el.remove());
    document.getElementById("date").textContent = formatDateDisplay(dateString);
    document.querySelector(".date-column").textContent = formatDayColumnLabel(dateString);

    // Get EPG data for the selected date and organize it by channel. Also get channel IDs
    const channelSchedules = buildChannelSchedules(data, dateString);
    const channelsById = new Map(data.channels.map(c => [c.id, c]));
    const channelIds = Object.keys(channelSchedules);

    // Get the service ID column, loop through each channel ID, then create the label
    const serviceColumn = document.querySelector(".service-column");
    channelIds.forEach(channelId => {
        const channel = channelsById.get(Number(channelId));
        const label = document.createElement("div");
        label.classList.add("text-white");
        label.textContent = getChannelDisplayName(channel, channelId)
        serviceColumn.appendChild(label);
    });

    // Get the scrollable guide element, loop through each channel ID, then dislay the corresponding programs
    const guideScroll = document.querySelector(".guide-scroll");
    channelIds.forEach(channelId => {
        const row = buildProgramRow(channelSchedules[channelId]);
        guideScroll.appendChild(row);
    });

    buildMobileGuide(data, dateString);
}

// & Strip redundant rating-code prefixes some descriptions have baked into their text (e.g. "TVPG Rich Manhattan housewife...")
function stripRatingPrefix(text) {
    return text.replace(/^(TVY7FV|TVY7|TVY|TVG|TVPG|TV14|TVMA|TVM)\s+/i, "");
}

// & Resolve the best available content rating label for a description
function getRatingLabel(description) {
    if (!description) return "Not Rated";

    // If a TV rating
    if (description.tvRating) return description.tvRating;

    // If a movie (MPAA) rating
    if (description.ratingName) return description.ratingName;

    // Fallback for older samples
    if (description.ratingSystem && description.rating != null) return `System: ${description.ratingSystem}, code ${description.rating}`;

    return "Not Rated";
}

// & Bootstrap modal
function showProgramModal(entry) {
    const description = entry.description;

    // Program title and description
    document.getElementById("programModalTitle").textContent = entry.program.title;
    document.getElementById("programModalDescription").textContent = description ? stripRatingPrefix(description.text) : "No description available";

    // Program channel name or ID
    const channel = channelsById.get(Number(entry.channelId));
    document.getElementById("programModalChannel").textContent = getChannelDisplayName(channel, entry.channelId);

    // Program start and end times
    const startLabel = formatTime(entry.startMinutes);
    const endLabel = formatTime(entry.startMinutes + entry.durationMinutes);
    document.getElementById("programModalTime").textContent = `${startLabel} - ${endLabel} (${formatRuntime(entry.durationMinutes)})`;

    // Closed captioning
    const ccIconEl = document.getElementById("programModalCCIcon");

    // If a program is closed captioned, display the icon
    if (entry.program.closedCaptioned) {
        ccIconEl.src = CC_ICON_PATH;
        ccIconEl.alt = "Closed Captioned";
        ccIconEl.style.display = "";

        // Display nothing if it isn't
    } else {
        ccIconEl.removeAttribute("src");
        ccIconEl.alt = "";
        ccIconEl.style.display = "none";
    }

    // Whether a program is black & white or color
    document.getElementById("programModalColor").textContent = entry.program.blackAndWhite ? "Yes" : "No";

    // Whether a program is stereo or mono
    document.getElementById("programModalAudio").textContent = entry.program.stereo ? "Stereo" : "Mono";

    // Ratings
    const ratingIconEl = document.getElementById("programModalRatingIcon");
    const ratingLabel = getRatingLabel(description);
    const ratingIconSet = RATING_ICONS[ratingLabel];

    // If a program has a rating, display the specific icon
    if (ratingIconSet) {
        ratingIconEl.src = isDarkModeActive() ? ratingIconSet.dark : ratingIconSet.light;
        ratingIconEl.alt = ratingLabel;
        ratingIconEl.style.display = "";

        // If not rated, display nothing
    } else {
        ratingIconEl.removeAttribute("src");
        ratingIconEl.alt = "";
        ratingIconEl.style.display = "none";
    }

    // Program year
    document.getElementById("programModalYear").textContent = description && description.year ? description.year : "Unknown";

    // If a program has a star rating system, display it
    const starsEl = document.getElementById("programModalStars");
    if (starsEl) {
        starsEl.textContent = description && description.stars != null ? "★".repeat(description.stars) + "☆".repeat(4 - description.stars) : "None available";
    }

    // If a program has advisories, display them
    const advisoriesEl = document.getElementById("programModalAdvisories");
    if (advisoriesEl) {
        advisoriesEl.textContent = description && description.advisories && description.advisories.length
            ? description.advisories.join(", ")
            : "No advisories.";
    }

    // ^ Generic "No Poster Available" placeholder image for when no poster image is found
    const PLACEHOLDER_POSTER_PATH = "../images/no-poster-available.png";

    // Show a placeholder poster immediately, then swap it in once the lookup resolves
    const posterEl = document.getElementById("programModalPoster");
    if (posterEl) {
        posterEl.removeAttribute("src");
        posterEl.style.display = "none";

        // If the poster image fails to load, fall back to the placeholder
        posterEl.onerror = () => {

            // ! Avoid looping if the placeholder fails for some reason
            posterEl.onerror = null;

            posterEl.src = PLACEHOLDER_POSTER_PATH;
            posterEl.alt = "No poster available";
        };

        // ^ Generic titles like these are showing incorrect poster images
        const GENERIC_TITLES = ["News", "Paid Programming", "To Be Announced"];

        // If the program name is one of the generic titles, display the fallback poster image
        if (GENERIC_TITLES.includes(entry.program.title)) {
            posterEl.src = PLACEHOLDER_POSTER_PATH;
            posterEl.alt = "No poster available";
            posterEl.style.display = "";

            // Otherwise, display the poster image
        } else {
            const year = description && description.year ? description.year : null;
            fetchPosterUrl(entry.program.title, year).then(url => {
                if (document.getElementById("programModalTitle").textContent !== entry.program.title) return;
                posterEl.src = url || PLACEHOLDER_POSTER_PATH;
                posterEl.alt = url ? `Poster for ${entry.program.title}` : "No poster available";
                posterEl.style.display = "";
            });
        }
    }

    const modal = new bootstrap.Modal(document.getElementById("programModal"));
    modal.show();
}

// On mobile, show mobile EPG and hide desktop EPG. Vice versa for desktop
window.addEventListener("resize", () => {
    if (currentData && currentDateString) {
        renderGuideData(currentData, currentDateString);
    }
});

function getQueryParameters() {
    return new URLSearchParams(window.location.search);
}

// Base URL (none since the site is hosted on Cloudflare and will fetch data from there)
const WORKER_BASE = "";

// API call
const API_BASE = `${WORKER_BASE}/api/poster`;

// Cache poster lookups so the same program title isn't fetched more than once per session
const posterCache = new Map();

// & Some programs use an ampersand, but the data uses the word "and"; swap them if there is no exact match
function swapAmpersand(title) {
    if (/\band\b/i.test(title)) {
        return title.replace(/\band\b/i, "&");
    }
    if (title.includes("&")) {
        return title.replace("&", "and");
    }
    return null;
}

// & Look up a poster URL for a program title using the Worker's "/api/poster" route
async function fetchPosterUrl(title, year) {

    // Check cache first
    if (posterCache.has(title)) return posterCache.get(title);

    // & Make the API request
    async function lookup(t) {
        const params = new URLSearchParams({ title: t });
        if (year) params.set("year", year);
        const response = await fetch(`${API_BASE}?${params}`);
        const result = await response.json();
        return result.poster ?? null;
    }

    let posterUrl = null;

    // Find the poster image for the specific program
    try {
        posterUrl = await lookup(title);

        // If the exact title didn't match, try swapping "and" for an ampersand
        if (!posterUrl) {
            const altTitle = swapAmpersand(title);
            if (altTitle) posterUrl = await lookup(altTitle);
        }
    } catch (err) {
        console.warn("Poster lookup failed:", title, err);
    }

    // Save the result in cache
    posterCache.set(title, posterUrl);
    return posterUrl;
}

// ^ Light/dark TV rating icons
const RATING_ICONS = {
    "TV-Y": {
        light: "../images/rating-icons/TV-Y.png",
        dark: "../images/rating-icons/TV-Y_white.png"
    },
    "TV-Y7": {
        light: "../images/rating-icons/TV-Y7.png",
        dark: "../images/rating-icons/TV-Y7_white.png"
    },
    "TV-Y7-FV": {
        light: "../images/rating-icons/TV-Y7-FV.png",
        dark: "../images/rating-icons/TV-Y7-FV_white.png"
    },
    "TV-G": {
        light: "../images/rating-icons/TV-G.png",
        dark: "../images/rating-icons/TV-G_white.png"
    },
    "TV-G": {
        light: "../images/rating-icons/TV-G.png",
        dark: "../images/rating-icons/TV-G_white.png"
    },
    "TV-14": {
        light: "../images/rating-icons/TV-14.png",
        dark: "../images/rating-icons/TV-14_white.png"
    },
    "TV-MA": {
        light: "../images/rating-icons/TV-MA.png",
        dark: "../images/rating-icons/TV-MA_white.png"
    }
};

// & Display light/dark icons based on which is active
function isDarkModeActive() {
    return document.documentElement.getAttribute("data-bs-theme") === "dark";
}

// ^ Image path for the closed captioned icon
const CC_ICON_PATH = "../images/rating-icons/CC.png";

// & Use local sample data instead
// ! This is for local development only. This does not run outside of there
async function loadData() {
    const jsonUrl = getQueryParameters().get("json");
    if (!jsonUrl) {
        console.error("Missing 'json' query parameter");
        return null;
    }
    const response = await fetch(jsonUrl);
    return response.json();
}

// ^ One EPG time slot is 30 minutes
const SLOT_MINUTES = 30;

// ^ Display 48 time slots (12:00am to 11:30pm)
const VISIBLE_SLOTS = 48;

// ^ For now, the schedule starts at 12:00am
const DAY_START_MINUTES = 0;

// ^ Standard (non-DST) UTC offset for PTZ stations only
// ! This is used as a fallback for now
const STANDARD_UTC_OFFSET_MINUTES = -480;
const DST_ADJUSTMENT_MINUTES = 60;

let currentData = null;
let currentDateString = null;

// & Calculate minutes since midnight
function formatTime(minutesOfDay) {

    const total = ((minutesOfDay % 1440) + 1440) % 1440;

    // Convert minutes to hours, fetch remaining minutes, convert 24-hour time to 12-hour, then display formatted time
    let hours = Math.floor(total / 60);
    const mins = total % 60;
    const period = hours >= 12 ? "P" : "A";
    hours = hours % 12 || 12
    return `${hours}${mins === 0 ? "" : ":" + String(mins).padStart(2, "0")}${period}`;
}

// & Keep channel column vertically synchronized with the program grid
function syncServiceColumnScroll() {
    document.querySelector(".guide-scroll").addEventListener("scroll", (e) => {
        document.querySelector(".service-column").scrollTop = e.target.scrollTop;
    });
}

// & Build the EPG time slots
function buildTimeRow() {
    const timeRow = document.getElementById("time");
    timeRow.innerHTML = "";
    document.querySelector(".time-row").style.gridTemplateColumns = `repeat(${VISIBLE_SLOTS}, var(--slot-width))`;

    // Loop through the 48 time slots and put them in their own DIV elements. Calculate the timeslot (e.g. 0 minutes is 12:00am)
    for (let i = 0; i < VISIBLE_SLOTS; i++) {
        const div = document.createElement("div");
        div.textContent = formatTime(DAY_START_MINUTES + i * SLOT_MINUTES);
        timeRow.appendChild(div);
    };
}

// & Convert numerical date (e.g. 1994-05-03) to a readable date (e.g. Tuesday, May 3, 1994) to use in a table heading
function formatDateDisplay(dateString) {

    // The second parameter in "Date" adds UTC to the date, which prevents accidental timezone changes
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
        timeZone: "UTC",
    });
}

// & Convert the date into a label that will be used for the clickable dates on the table
function formatDayButtonLabel(dateString) {

    // Create UTC Date object then return the formatted date (e.g. Tue, May 4)
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
    });
}

// & Convert the date into a label that includes the year; this is used when searching for a program
function formatSearchResultDateLabel(dateString) {
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC"
    });
}

// & Convert the date into a label that will be used for date column to the left of the table
function formatDayColumnLabel(dateString) {

    // Create UTC Date object then return the formatted date (e.g. May 4)
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        month: "short", day: "numeric", timeZone: "UTC",
    });
}

// & Check whether a given UTC timestamp falls inside one of the capture's daylight saving windows
function isDuringDaylightSaving(isoString, daylightSavingChanges) {
    const t = new Date(isoString).getTime();
    return daylightSavingChanges.some(change => {
        const start = new Date(change.starts).getTime();
        const end = new Date(change.ends).getTime();
        return t >= start && t < end;
    });
}

// & Standard (non-DST) UTC offset reported by the clock used by the transmitting station
// * If this is absent, fallback to PTZ
function getStandardOffsetMinutes(data) {
    const entry = (data.clock || []).find(c => Number.isFinite(c.utcOffsetMinutes));
    return entry ? entry.utcOffsetMinutes : STANDARD_UTC_OFFSET_MINUTES;
}

// & Determine the correct UTC offset for a specific listing, accounting for daylight saving
function getUtcOffsetMinutes(isoString, data) {
    const inDst = isDuringDaylightSaving(isoString, data.daylightSavingChanges || []);
    return getStandardOffsetMinutes(data) + (inDst ? DST_ADJUSTMENT_MINUTES : 0);
}

// & Create clickable list of available dates in the JSON
function buildDaySelection(data) {

    // Use the same local-date logic as everything else, so date buttons match what's actually rendered
    const dates = [...new Set(data.listings.map(l => listingLocalDate(l.start, data)))].sort();
    const container = document.querySelector(".day-selection");
    container.innerHTML = "";

    // Create a DIV for each date. The label will be the date. Clicking on it should show that day's programs.
    dates.forEach((dateString, index) => {
        const button = document.createElement("div");
        button.textContent = formatDayButtonLabel(dateString);
        button.style.cursor = "pointer";

        // The first date should automatically be selected
        if (index === 0) {
            button.classList.add("selected");
        }

        // Add the "selected" class to a clicked date
        button.addEventListener("click", () => {
            container.querySelectorAll(".selected").forEach(button => {
                button.classList.remove("selected");
            });

            button.classList.add("selected");

            // Show spinner when a date is clicked
            const overlay = document.getElementById("loadingOverlay");
            if (overlay) overlay.style.display = "";

            setTimeout(() => {
                renderGuideData(data, dateString);
                if (overlay) overlay.style.display = "none"
            }, 20);
        });
        container.appendChild(button);
    });

    return dates;
}

// & Convert ISO date/time string into minutes since midnight
function listingStartMinutes(isoString, data) {

    // Convert ISO into JS Date object
    const utcDate = new Date(isoString);
    const offset = getUtcOffsetMinutes(isoString, data);

    // Convert UTC time (e.g. 1994-05-03T13:00:00Z) into time since midnight
    const localMinutesOfDay = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes() + offset;

    /*
    * Convert number of minutes into value representing time of day which wraps around at midnight; also works for negative numbers
    * Keep time between 0 and 1439 minutes even when timezone conversion produces a negative value
    */
    return ((localMinutesOfDay % 1440) + 1440) % 1440
}

function listingLocalDate(isoString, data) {
    const date = new Date(isoString);
    const offset = getUtcOffsetMinutes(isoString, data);
    date.setUTCMinutes(date.getUTCMinutes() + offset);
    return date.toISOString().slice(0, 10);
}

// & Determine where each program should be placed inside the schedule
function computeGridPlacement(startMinutes, durationMinutes) {

    // Determine grid columns, then how many columns the program should occupy
    const startCol = Math.round((startMinutes - DAY_START_MINUTES) / SLOT_MINUTES) + 1;
    const span = Math.round(durationMinutes / SLOT_MINUTES);
    return { startCol, span };
}

// & Format a duration in minutes (e.g. "1 hr 30 min", "30 mins", or "1 hr")
function formatRuntime(durationMinutes) {
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    if (hours === 0) return `${minutes} min`;
    if (minutes === 0) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
}

// Lookup maps built once per data load, reused by search instead of rebuilding per keystroke
let programByID = new Map();
let descriptionByID = new Map();
let channelsById = new Map();

// & Build lookup maps
function buildLookupMaps(data) {
    programByID = new Map(data.programs.map(p => [p.id, p]));
    descriptionByID = new Map(data.descriptions.map(d => [d.id, d]));
    channelsById = new Map(data.channels.map(c => [c.id, c]));
}

// & Find every listing whose program title contains the search query; find across all dates
function searchPrograms(query, data) {

    // Normalize search query. Do not search anything if no query
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return [];

    // Initialize array
    const matches = [];

    // Loop through every listing in the data
    for (const listing of data.listings) {

        // Find the program being searched
        const program = programByID.get(listing.program);

        // Ignore invalid programs
        if (!program || !program.title) continue;

        // Check whether the program title contains the search query
        if (!program.title.toLowerCase().includes(q)) continue;

        // Push results into the array
        matches.push({
            listing,
            program,
            description: listing.description ? descriptionByID.get(listing.description) : null
        });
    }

    return matches;
}

// ^ Limit only to 100 results
const MAX_SEARCH_RESULTS = 100;

// & Render search results as a clickable list, each program opening its own modal
function renderSearchResults(matches, data) {
    const container = document.getElementById("programSearchResults");
    container.innerHTML = "";

    // If no matches found, display message
    if (matches.length === 0) {
        container.innerHTML = "<li>No matching programs found</li>";
        return;
    }

    // Limit search results only to first 100
    matches.slice(0, MAX_SEARCH_RESULTS).forEach(match => {

        // Look up channel, assign display name, get listing date, get program start time, and create the time label
        const channel = channelsById.get(match.listing.channel);
        const channelName = getChannelDisplayName(channel, match.listing.channel);
        const dateString = listingLocalDate(match.listing.start, data);
        const startMinutes = listingStartMinutes(match.listing.start, data);
        const timeLabel = formatTime(startMinutes);

        // Create new list element for each program
        const item = document.createElement("li");
        item.className = "search-result";
        item.style.cursor = "pointer";
        item.textContent = `${match.program.title}  (${channelName} - ${formatSearchResultDateLabel(dateString)}, ${timeLabel})`;

        // When a program is clicked, the content modal will appear with the necessary information
        item.addEventListener("click", () => {
            showProgramModal({
                program: match.program,
                description: match.description,
                startMinutes,
                durationMinutes: match.listing.durationMinutes,
                channelId: match.listing.channel,
            });
        });

        container.appendChild(item);
    });

    // If more than 100 results, note it at the bottom of the list
    if (matches.length > MAX_SEARCH_RESULTS) {
        const notice = document.createElement("li");
        notice.style.fontStyle = "italic";
        notice.textContent = `Showing first ${MAX_SEARCH_RESULTS} of ${matches.length} results`;
        container.appendChild(notice);
    }
}

// & Create the search input; do not re-scan data on every keystroke
function setupProgramSearch(data) {
    const input = document.getElementById("programSearchInput");

    // Timer variable used below
    let debounceTimer = null;

    // Event listener that updates the list of programs while a value is being typed
    input.addEventListener("input", () => {

        // Cancel previous timer
        clearTimeout(debounceTimer);

        // The timer runs 200 ms after the user stops typing
        debounceTimer = setTimeout(() => {

            // Search for the programs after typing stops, then display the results
            const matches = searchPrograms(input.value, data);
            renderSearchResults(matches, data)
        }, 200);
    });
}

// & Take the data from the JSON and organize the programs by channel ID/name for a selected date
function buildChannelSchedules(data, targetDataString) {

    // Map program ID to its correct program. Do the same for program descriptins. Store in empty object
    const programByID = new Map(data.programs.map(p => [p.id, p]));
    const descriptionByID = new Map(data.descriptions.map(d => [d.id, d]));
    const channelSchedules = {};

    data.listings.forEach(listing => {

        // Only keep listings that belong to the date selected in the schedule
        if (listingLocalDate(listing.start, data) !== targetDataString) return;

        // Store the program title. If one doesn't exist, skip it
        const program = programByID.get(listing.program);
        if (!program || !program.title) return;

        // Make sure the program has a valid duration
        if (!listing.durationMinutes || listing.durationMinutes <= 0) return;

        // Get the channel ID
        const key = listing.channel;

        // Hold all programs that aired on a specific channel
        if (!channelSchedules[key]) channelSchedules[key] = [];

        // Push relevant details of each program to the respective channel array
        channelSchedules[key].push({
            program,
            description: listing.description ? descriptionByID.get(listing.description) : null,
            startMinutes: listingStartMinutes(listing.start, data),
            durationMinutes: listing.durationMinutes,
            channelId: key,
        });
    });

    return channelSchedules;
}

// & Create one row of program listings for each channel
function buildProgramRow(scheduleEntries) {
    const row = document.createElement("div");
    row.className = "program-row";
    row.style.gridTemplateColumns = `repeat(${VISIBLE_SLOTS}, var(--slot-width))`;

    // Copy the "scheduleEntries" array and sort it by start time
    const sorted = [...scheduleEntries].sort((a, b) => a.startMinutes - b.startMinutes);

    let nextExpectedCol = 1;

    sorted.forEach(entry => {

        // Calculate starting grid column and the number of columns occupied
        const { startCol, span } = computeGridPlacement(entry.startMinutes, entry.durationMinutes);

        if (!Number.isFinite(startCol) || !Number.isFinite(span) || span <= 0) return;
        if (startCol > VISIBLE_SLOTS) return;

        // Check if a program starts before the previous one has finished
        if (startCol < nextExpectedCol) {
            console.warn("Skipping overlapping listing:", entry);
            return;
        }

        // Fill gaps with no program information
        if (startCol > nextExpectedCol) {
            const filler = document.createElement("div");
            filler.className = "no-data";
            filler.style.gridColumn = `${nextExpectedCol} / span ${startCol - nextExpectedCol}`;
            filler.textContent = "NO DATA";
            row.appendChild(filler);
        }
        if (startCol > VISIBLE_SLOTS) return;

        // Calculate how many columns are left in the grid
        const maxSpan = VISIBLE_SLOTS - startCol + 1;
        const clampedSpan = Math.min(span, maxSpan);

        // Create the cells. Create CSS to place each column and make each grid clickable to show other info in a modal
        const cell = document.createElement("div");
        cell.textContent = entry.program.title;
        cell.style.gridColumn = `${startCol} / span ${clampedSpan}`;
        cell.style.cursor = "pointer";
        cell.addEventListener("click", () => showProgramModal(entry));
        row.appendChild(cell);

        // Update the location where the next program is expected to be placed. Do not extend programs past 11:30pm if they run long
        nextExpectedCol = startCol + clampedSpan;
    });

    // Check if there is empty space until the end of the grid. Filler grid occupies everything from the last program to the end of the guide
    if (nextExpectedCol <= VISIBLE_SLOTS) {
        const filler = document.createElement("div");
        filler.className = "no-data";
        filler.style.gridColumn = `${nextExpectedCol} / span ${VISIBLE_SLOTS - nextExpectedCol + 1}`;
        row.appendChild(filler);
    }

    return row;
}

//  & Build EPG guide for mobile devices
function buildMobileGuide(data, dateString) {
    const container = document.getElementById("starsight-guide-mobile");
    container.innerHTML = "";

    // Same as desktop. Get EPG data for the selected date and organize it by channel name or ID
    const channelSchedules = buildChannelSchedules(data, dateString);
    const channelsById = new Map(data.channels.map(c => [c.id, c]));
    const channelIds = Object.keys(channelSchedules);

    // CSS for the mobile grid
    container.style.gridTemplateColumns = `80px repeat(${channelIds.length}, 100px)`;
    container.style.gridTemplateRows = `40px repeat(${VISIBLE_SLOTS}, 60px)`;

    // Corner cell that acts as a divider and contains no data
    const corner = document.createElement("div");
    corner.className = "corner-cell";
    corner.style.gridRow = "1";
    corner.style.gridColumn = "1";
    container.appendChild(corner);

    // Create the row for the channel names/IDs
    channelIds.forEach((channelId, i) => {
        const channel = channelsById.get(Number(channelId));
        const header = document.createElement("div");
        header.classList.add("channel-header", "text-white");
        header.textContent = getChannelDisplayName(channel, channelId)
        header.style.gridRow = "1";
        header.style.gridColumn = String(i + 2);
        container.appendChild(header);
    });

    // Create the time slot labels
    for (let slot = 0; slot < VISIBLE_SLOTS; slot++) {
        const label = document.createElement("div");
        label.className = "time-label";
        label.classList.add("text-white");
        label.textContent = formatTime(DAY_START_MINUTES + slot * SLOT_MINUTES);
        label.style.gridRow = String(slot + 2);
        label.style.gridColumn = "1";
        container.appendChild(label);
    }

    // Loop through each channel
    channelIds.forEach((channelId, colIndex) => {

        // Sort programs by start time
        const sorted = [...channelSchedules[channelId]].sort((a, b) => a.startMinutes - b.startMinutes);
        let nextExpectedRow = 1;

        sorted.forEach(entry => {

            // Calculate starting grid row and the number of rows occupied
            const { startCol: startRow, span } = computeGridPlacement(entry.startMinutes, entry.durationMinutes);

            // If a starting row of program runtime can't be calculated, skip it
            if (!Number.isFinite(startRow) || !Number.isFinite(span) || span <= 0) return;
            if (startRow > VISIBLE_SLOTS) return;

            // Fill gaps with no program information
            if (startRow > nextExpectedRow) {
                const filler = document.createElement("div");
                filler.classList.add("no-data", "text-white");
                filler.style.gridRow = `${nextExpectedRow + 1} / span ${startRow - nextExpectedRow}`;
                filler.style.gridColumn = String(colIndex + 2);
                filler.textContent = "NO DATA";
                container.appendChild(filler);
            }

            // Calculate how many rows are left in the grid
            const maxSpan = VISIBLE_SLOTS - startRow + 1;
            const clampedSpan = Math.min(span, maxSpan);

            // Create the cells; same as desktop
            const cell = document.createElement("div");
            cell.className = "program";
            cell.textContent = entry.program.title;
            cell.style.gridRow = `${startRow + 1} / span ${clampedSpan}`;
            cell.style.gridColumn = String(colIndex + 2);
            cell.style.cursor = "pointer";
            cell.addEventListener("click", () => showProgramModal(entry));
            container.appendChild(cell);

            nextExpectedRow = startRow + clampedSpan;
        });

        // Same as desktop; fill empty cells
        if (nextExpectedRow <= VISIBLE_SLOTS) {
            const filler = document.createElement("div");
            filler.className = "no-data";
            filler.style.gridRow = `${nextExpectedRow + 1} / span ${VISIBLE_SLOTS - nextExpectedRow}`;
            filler.style.gridColumn = String(colIndex + 2);
            container.appendChild(filler);
        }
    });
}

// & Resolve the best available display name for a channel
function getChannelDisplayName(channel, channelId) {
    if (channel && channel.label) return channel.label;

    // Older captures (e.g. KCET-VBI) used "name"
    if (channel && channel.name) return channel.name;
    if (channel && channel.callSign) return channel.callSign;
    return `CH ${channelId}`;
}

// & Rendering and refreshing the EPG data
function renderGuideData(data, dateString) {

    currentData = data;
    currentDateString = dateString;

    // Clear all these elements before displaying a new schedule
    document.querySelectorAll(".service-column div:not(.service-header)").forEach(el => el.remove());
    document.querySelectorAll(".guide-scroll .program-row").forEach(el => el.remove());
    document.getElementById("date").textContent = formatDateDisplay(dateString);
    document.querySelector(".date-column").textContent = formatDayColumnLabel(dateString);

    // Get EPG data for the selected date and organize it by channel. Also get channel IDs
    const channelSchedules = buildChannelSchedules(data, dateString);
    const channelsById = new Map(data.channels.map(c => [c.id, c]));
    const channelIds = Object.keys(channelSchedules);

    // Get the service ID column, loop through each channel ID, then create the label
    const serviceColumn = document.querySelector(".service-column");
    channelIds.forEach(channelId => {
        const channel = channelsById.get(Number(channelId));
        const label = document.createElement("div");
        label.classList.add("text-white");
        label.textContent = getChannelDisplayName(channel, channelId)
        serviceColumn.appendChild(label);
    });

    // Get the scrollable guide element, loop through each channel ID, then dislay the corresponding programs
    const guideScroll = document.querySelector(".guide-scroll");
    channelIds.forEach(channelId => {
        const row = buildProgramRow(channelSchedules[channelId]);
        guideScroll.appendChild(row);
    });

    buildMobileGuide(data, dateString);
}

// & Strip redundant rating-code prefixes some descriptions have baked into their text (e.g. "TVPG Rich Manhattan housewife...")
function stripRatingPrefix(text) {
    return text.replace(/^(TVY7FV|TVY7|TVY|TVG|TVPG|TV14|TVMA|TVM)\s+/i, "");
}

// & Resolve the best available content rating label for a description
function getRatingLabel(description) {
    if (!description) return "Not Rated";

    // If a TV rating
    if (description.tvRating) return description.tvRating;

    // If a movie (MPAA) rating
    if (description.ratingName) return description.ratingName;

    // Fallback for older samples
    if (description.ratingSystem && description.rating != null) return `System: ${description.ratingSystem}, code ${description.rating}`;

    return "Not Rated";
}

// & Bootstrap modal
function showProgramModal(entry) {
    const description = entry.description;

    // Program title and description
    document.getElementById("programModalTitle").textContent = entry.program.title;
    document.getElementById("programModalDescription").textContent = description ? stripRatingPrefix(description.text) : "No description available";

    // Program channel name or ID
    const channel = channelsById.get(Number(entry.channelId));
    document.getElementById("programModalChannel").textContent = getChannelDisplayName(channel, entry.channelId);

    // Program start and end times
    const startLabel = formatTime(entry.startMinutes);
    const endLabel = formatTime(entry.startMinutes + entry.durationMinutes);
    document.getElementById("programModalTime").textContent = `${startLabel} - ${endLabel} (${formatRuntime(entry.durationMinutes)})`;

    // Closed captioning
    const ccIconEl = document.getElementById("programModalCCIcon");

    // If a program is closed captioned, display the icon
    if (entry.program.closedCaptioned) {
        ccIconEl.src = CC_ICON_PATH;
        ccIconEl.alt = "Closed Captioned";
        ccIconEl.style.display = "";

        // Display nothing if it isn't
    } else {
        ccIconEl.removeAttribute("src");
        ccIconEl.alt = "";
        ccIconEl.style.display = "none";
    }

    // Whether a program is black & white or color
    document.getElementById("programModalColor").textContent = entry.program.blackAndWhite ? "Yes" : "No";

    // Whether a program is stereo or mono
    document.getElementById("programModalAudio").textContent = entry.program.stereo ? "Stereo" : "Mono";

    // Ratings
    const ratingIconEl = document.getElementById("programModalRatingIcon");
    const ratingLabel = getRatingLabel(description);
    const ratingIconSet = RATING_ICONS[ratingLabel];

    // If a program has a rating, display the specific icon
    if (ratingIconSet) {
        ratingIconEl.src = isDarkModeActive() ? ratingIconSet.dark : ratingIconSet.light;
        ratingIconEl.alt = ratingLabel;
        ratingIconEl.style.display = "";

        // If not rated, display nothing
    } else {
        ratingIconEl.removeAttribute("src");
        ratingIconEl.alt = "";
        ratingIconEl.style.display = "none";
    }

    // Program year
    document.getElementById("programModalYear").textContent = description && description.year ? description.year : "Unknown";

    // If a program has a star rating system, display it
    const starsEl = document.getElementById("programModalStars");
    if (starsEl) {
        starsEl.textContent = description && description.stars != null ? "★".repeat(description.stars) + "☆".repeat(4 - description.stars) : "None available";
    }

    // If a program has advisories, display them
    const advisoriesEl = document.getElementById("programModalAdvisories");
    if (advisoriesEl) {
        advisoriesEl.textContent = description && description.advisories && description.advisories.length
            ? description.advisories.join(", ")
            : "No advisories.";
    }

    // ^ Generic "No Poster Available" placeholder image for when no poster image is found
    const PLACEHOLDER_POSTER_PATH = "../images/no-poster-available.png";

    // Show a placeholder poster immediately, then swap it in once the lookup resolves
    const posterEl = document.getElementById("programModalPoster");
    if (posterEl) {
        posterEl.removeAttribute("src");
        posterEl.style.display = "none";

        // If the poster image fails to load, fall back to the placeholder
        posterEl.onerror = () => {

            // ! Avoid looping if the placeholder fails for some reason
            posterEl.onerror = null;

            posterEl.src = PLACEHOLDER_POSTER_PATH;
            posterEl.alt = "No poster available";
        };

        // ^ Generic titles like these are showing incorrect poster images
        const GENERIC_TITLES = ["News", "Paid Programming", "To Be Announced"];

        // If the program name is one of the generic titles, display the fallback poster image
        if (GENERIC_TITLES.includes(entry.program.title)) {
            posterEl.src = PLACEHOLDER_POSTER_PATH;
            posterEl.alt = "No poster available";
            posterEl.style.display = "";

            // Otherwise, display the poster image
        } else {
            const year = description && description.year ? description.year : null;
            fetchPosterUrl(entry.program.title, year).then(url => {
                if (document.getElementById("programModalTitle").textContent !== entry.program.title) return;
                posterEl.src = url || PLACEHOLDER_POSTER_PATH;
                posterEl.alt = url ? `Poster for ${entry.program.title}` : "No poster available";
                posterEl.style.display = "";
            });
        }
    }

    const modal = new bootstrap.Modal(document.getElementById("programModal"));
    modal.show();
}

// On mobile, show mobile EPG and hide desktop EPG. Vice versa for desktop
window.addEventListener("resize", () => {
    if (currentData && currentDateString) {
        renderGuideData(currentData, currentDateString);
    }
});

// Load data from the JSON and build the EPG
loadData().then(data => {
    if (!data) return;
    window.debugData = data;
    buildTimeRow();
    syncServiceColumnScroll();
    buildLookupMaps(data);
    setupProgramSearch(data);

    // Create the clickable date, then show listings from the first date on load
    const dates = buildDaySelection(data);
    renderGuideData(data, dates[0]);
}).finally(() => {
    document.getElementById("loadingOverlay").style.display = "none";
})