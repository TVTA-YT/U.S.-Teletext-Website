// API base URL
const API_BASE = "https://us-teletext-website.us-teletext-archive.workers.dev";

// Default section labels
const SECTION_LABELS = {
    intro: {
        text: "**** WELCOME TO NATA, NORTH AMERICA'S TELETEXT ARCHIVE **** ",
        color: "#fff800",
        font: "Bedstead Bold",
        nbsp: 2,
    },
    watch: {
        text: "==== WATCH THIS SPACE FOR QUICK UPDATES ====",
        color: "#00cfff",
        font: "Bedstead Bold",
        nbsp: 12,
    },
    updates: {
        text: "UPDATES...",
        color: "#e501f6",
        font: "Bedstead Regular",
        nbsp: 2,
    },
};

// "span" elements for the date and time
const dateTimeItems = [
    {
        text: '<span class="marquee-datetime marquee-date"></span>',
        color: "#0019ff",
        font: "Bedstead Regular",
        nbsp: 2,
    },
    {
        text: '<span class="marquee-datetime marquee-time">00:00:00</span>',
        color: "#0019ff",
        font: "Bedstead Regular",
        nbsp: 12,
    },
];

// & Starts where the marquee should enter from (right of screen, starting off-screen)
function startMarqueeEntrance() {
    const content = document.querySelector(".updates-marquee-content");
    const track = document.querySelector(".updates-marquee-track");
    if (!content || !track) return;

    // Get rendered width of marquee track as measured in pixels
    const trackWidth = track.getBoundingClientRect().width;

    // Loop duration is every 50 seconds.
    const loopDurationSec = 30;
    const pxPerSecond = trackWidth / loopDurationSec;

    // Calculate how long it takes the marquee to scroll into the visible area; add custom CSS property and assign class to start animation
    const enterDurationSec = window.innerWidth / pxPerSecond;
    content.style.setProperty("--enter-duration", `${enterDurationSec}s`);
    content.classList.add("marquee-enter");

    // Wait for animation to finish
    content.addEventListener("animationend", function onEnd(e) {

        // When the marquee animation (off-screen to visible area) ends, remove event listener and the initial animation class; assign loop class and start the loop
        if (e.animationName !== "updates-marquee-enter") return;
        content.removeEventListener("animationend", onEnd);
        content.classList.remove("marquee-enter");
        content.classList.add("marquee-loop");
    });
}

// & Create text that will show the date the marquee headlines were last updated
function formatLastUpdatedLabel(headlinesDate) {
    // If no date, return static text
    if (!headlinesDate) return `UPDATE DATE UNKNOWN`;

    // Find date headlines were last updated
    const date = new Date(headlinesDate);
    const fmt = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC"
    }).toUpperCase();

    return `HEADLINES LAST UPDATED: ${fmt}`;
}

// & Format "new samples" text; convert JS Date (e.g. 2026-09-20T00:00:00Z) into short date (e.g. Sep 20)
function formatDayLabel(dayStartISO) {
    const day = new Date(dayStartISO);
    const fmt = day.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC"
    }).toUpperCase();

    return `NEW SAMPLES FOR ${fmt}:`;
}

// & Build everything inside the marquee
function buildMarqueeItems({ dateTimeItems, serviceCounts, headlines, dayStart, lastUpdatedLabel }) {

    // Text for "new samples"
    const newSamplesLabel = {
        text: formatDayLabel(dayStart),
        color: "#00d231",
        font: "Bedstead Regular",
        nbsp: 2,
    };

    // Create array
    const items = [SECTION_LABELS.intro, SECTION_LABELS.watch, ...dateTimeItems, newSamplesLabel];

    // If there are no updates, display static text
    if (serviceCounts.length === 0) {
        items.push({
            text: "NO UPDATES AVAILABLE",
            color: "#ff0000",
            font: "Bedstead Bold",
            nbsp: 12,
        });
        // Output each update otherwise
    } else {
        serviceCounts.forEach((s, i) => {

            // Check if the current item is the last item
            const isLast = i === serviceCounts.length - 1;
            items.push({
                text: `${s.service.toUpperCase()} - ${s.count}`,
                color: "#ff0000",
                font: "Bedstead Condensed",
                nbsp: isLast ? 12 : 0,
                separator: isLast ? undefined : "///&nbsp;",
            });
        });
    }

    // Push all updates into the array
    items.push(SECTION_LABELS.updates);

    // Loop though each headline returned by the API
    headlines.forEach((h, i) => {
        const isLast = i === headlines.length - 1;
        items.push({
            text: h.text,
            color: h.color ?? "#a801f6",
            font: h.font ?? "Bedstead Condensed",
            nbsp: h.nbsp ?? (isLast ? 2 : 2),
            separator: isLast ? undefined : "///",
        });
    });

    // Push the "last updated" text with date into the array
    items.push({
        text: lastUpdatedLabel,
        color: "#fff",
        font: "Bedstead Condensed",
        nbsp: 25,
    });

    return items;
}

// & Render the marquee into HTML
function renderMarqueeHTML(items) {
    return items
        .map((i) => {
            // Add spaces and separators in between each service
            const gap = "&nbsp;".repeat(i.nbsp ?? 2);
            const suffix = i.separator ? ` ${i.separator}` : "";
            return `<span class="updates-marquee-text" style="font-family: '${i.font}', sans-serif; color: ${i.color} !important;">${i.text}${suffix}${gap}</span>`;
        })
        .join("");
}

// Update the current date and time in the marquee
function updateMarqueeDateTime() {
    const now = new Date();

    // Formats date: Sun, September 20, 2026
    const formattedDate = now.toLocaleDateString("en-US", {
        weekday: "short",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York"
    });

    // FOrmats time: 22:00:00 for 10:00pm
    const formattedTime = now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "America/New_York"
    });

    document.querySelectorAll(".marquee-date").forEach((el) => (el.textContent = formattedDate));
    document.querySelectorAll(".marquee-time").forEach((el) => (el.textContent = `${formattedTime} ET`));
}
updateMarqueeDateTime();

// The time should update every second
setInterval(updateMarqueeDateTime, 1000);

// & Get data and construct the marquee
async function initMarquee() {
    try {
        const [updateRes, headlineRes] = await Promise.all([
            fetch(`${API_BASE}/api/marquee/updates`),
            fetch(`${API_BASE}/api/marquee/headlines`),
        ]);

        // Convert response to JSON
        const updateData = await updateRes.json();
        const headlinesData = await headlineRes.json();

        // If accessing items, don't crash id "headlinesData" is undefined; if no items, use an empty array
        const headlineItems = headlinesData?.items ?? [];

        // Determine the last updated date
        const lastUpdatedLabel = formatLastUpdatedLabel(headlinesData?.updatedAt);

        // Build the marquee
        const items = buildMarqueeItems({
            dateTimeItems,
            serviceCounts: updateData.services ?? [],
            headlines: headlineItems,
            dayStart: updateData.dayStart,
            lastUpdatedLabel,
        });

        // Output to HTML
        const html = renderMarqueeHTML(items);
        document.querySelectorAll(".updates-marquee-track").forEach((track) => {
            track.innerHTML = html;
        });
        updateMarqueeDateTime();
    } catch (error) {
        console.error("Marquee init failed:", error);
    }
}

initMarquee().then(startMarqueeEntrance);