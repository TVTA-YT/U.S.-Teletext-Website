function getQueryParameters() {
    return new URLSearchParams(window.location.search);
}

async function loadData() {
    const jsonUrl = getQueryParameters().get("json");

    if (!jsonUrl) {
        console.error("Missing 'json' query parameter");
        return null;
    }
    const response = await fetch(jsonUrl);
    return response.json();
}

// One EPG time slot is 30 minutes
const SLOT_MINUTES = 30;

// Display 48 time slots (12:00am to 11:30pm)
const VISIBLE_SLOTS = 48;

// For now, the schedule starts at 12:00am
const DAY_START_MINUTES = 0;

// The time format in the JSON it UTC. UTC is 8 hours ahead of PST; the only JSON I have was recorded from KCET in CA, which uses PST/PDT.
const UTC_OFFSET_MINUTES = -480;

let currentData = null;
let currentDateString = null;

// & Calculate minutes since midnight
function formatTime(minutesOfDay) {

    const total = ((minutesOfDay % 1440) + 1440) % 1440;

    // Convert minutes to hours, fetch remaining minutes, convert 24-hour time to 12-hour, then display formatted time.
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

// & Convert the date into a label that will be used for date column to the left of the table
function formatDayColumnLabel(dateString) {

    // Create UTC Date object then return the formatted date (e.g. May 4)
    const date = new Date(dateString + "T00:00:00Z");
    return date.toLocaleDateString("en-US", {
        month: "short", day: "numeric", timeZone: "UTC",
    });
}

// & Create clickable list of available dates in the JSON
function buildDaySelection(data) {

    // Again, only get the dates from the date/time string
    const dates = [...new Set(data.listings.map(l => l.start.slice(0, 10)))].sort();
    const container = document.querySelector(".day-selection");
    container.innerHTML = "";

    // Create a DIV for each date. The label will be the date. Clicking on it should show that day's programs.
    dates.forEach((dateString, index) => {
        const button = document.createElement("div");
        button.textContent = formatDayButtonLabel(dateString);

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
            renderGuideData(data, dateString)
        });
        container.appendChild(button);
    });

    return dates;
}

// & Convert ISO date/time string into minutes since midnight
function listingStartMinutes(isoString) {

    // Convert ISO into JS Date object
    const utcDate = new Date(isoString);

    // Convert UTC time (e.g. 1994-05-03T13:00:00Z) into time since midnight
    // Get hours (13), multiply (60 mins in 1 hour = 750), add UTC minutes (00), add UTC offset minutes (750 + (-480) = 270 (5:00am))
    const localMinutesOfDay = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes() + UTC_OFFSET_MINUTES;

    /*
    * Convert number of minutes into value representing time of day which wraps around at midnight; also works for negative numbers
    * Keep time between 0 and 1439 minutes even when timezone conversion produces a negative value
    * e.g. -60 % 1440 = -60. Adding 1440 = 1380. The remainder of that (1380 % 1440) = 1380 (11:00pm).
    */
    return ((localMinutesOfDay % 1440) + 1440) % 1440
}

function listingLocalDate(isoString) {
    const date = new Date(isoString);
    date.setUTCMinutes(date.getUTCMinutes() + UTC_OFFSET_MINUTES);
    return date.toISOString().slice(0, 10);

}

// & Determine where each program should be placed inside the schedule
function computeGridPlacement(startMinutes, durationMinutes) {

    // Determine grid columns, then how many columns the program should occupy
    const startCol = Math.round((startMinutes - DAY_START_MINUTES) / SLOT_MINUTES) + 1;
    const span = Math.round(durationMinutes / SLOT_MINUTES);
    return { startCol, span };
}

// & Take the data from the JSON and organize the programs by channel ID/name for a selected date
function buildChannelSchedules(data, targetDataString) {

    // Map program ID to its correct program. Do the same for program descriptins. Store in empty object
    const programByID = new Map(data.programs.map(p => [p.id, p]));
    const descriptionByID = new Map(data.descriptions.map(d => [d.id, d]));
    const channelSchedules = {};

    data.listings.forEach(listing => {

        // Only keep listings that belong to the date selected in the schedule
        // if (!listing.start.startsWith(targetDataString)) return;
        if (listingLocalDate(listing.start) !== targetDataString) return;

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
            startMinutes: listingStartMinutes(listing.start),
            durationMinutes: listing.durationMinutes,
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
            filler.textContent = "NO PROGRAM AIRING";
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
        header.className = "channel-header";
        header.textContent = (channel && channel.name) ? channel.name : `CH: ${channelId}`;
        header.style.gridRow = "1";
        header.style.gridColumn = String(i + 2);
        container.appendChild(header);
    });

    // Create the time slot labels
    for (let slot = 0; slot < VISIBLE_SLOTS; slot++) {
        const label = document.createElement("div");
        label.className = "time-label";
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
                filler.className = "no-data";
                filler.style.gridRow = `${nextExpectedRow + 1} / span ${startRow - nextExpectedRow}`;
                filler.style.gridColumn = String(colIndex + 2);
                filler.textContent = "NO PROGRAM AIRING";
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
        label.textContent = (channel && channel.name) ? channel.name : `CH ${channelId}`;
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

// & Bootstrap modal
function showProgramModal(entry) {
    document.getElementById("programModalTitle").textContent = entry.program.title;
    document.getElementById("programModalDescription").textContent = entry.description ? entry.description.text : "No description available";
    document.getElementById("programModalCaptioned").textContent = entry.program.closedCaptioned ? "Yes" : "No";
    document.getElementById("programModalColor").textContent = entry.program.blackAndWhite ? "Yes" : "No";
    document.getElementById("programModalAudio").textContent = entry.program.stereo ? "Stereo" : "Mono";
    document.getElementById("programModalRating").textContent = entry.description && entry.description.rating != null ? `System: ${entry.description.ratingSystem}, code ${entry.description.rating}` : "Not Rated";
    document.getElementById("programModalYear").textContent = entry.description && entry.description.year ? entry.description.year : "Unknown";

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
    buildTimeRow();
    syncServiceColumnScroll();

    // Create the clickable date, then show listings from the first date on load
    const dates = buildDaySelection(data);
    renderGuideData(data, dates[0]);
})