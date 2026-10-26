{
    // ^ API base URL (blank = same origin)
    const API_BASE = "";

    // ^ The typing speed of each character
    const TYPE_SPEED = 25;

    // ^ How long to wait to show the next story (5 seconds)
    const HOLD_TIME = 5000;

    // ^ Hosts that should use the backup data instead of the API ("" covers opening the file directly)
    const DEV_HOSTS = ["localhost", "127.0.0.1", ""];
    const IS_DEV = DEV_HOSTS.includes(location.hostname) || location.hostname.endsWith(".workers.dev");

    // ^ Backup headline data for the dev site (same shape as the KV value)
    const DEV_HEADLINES = {
        updatedAt: "2026-10-26",
        items: [
            {
                title: "Games in NABTS samples now playable",
                body: "Some NABTS samples, mainly NBC Teletext samples, include games that are now playable thanks to updated code used for the website's NABTS viewer.",
                date: "2026-10-26",
            },
            {
                title: "Updated NABTS Code for Decode-Orc coming soon",
                body: "Updated code for NABTS decoding is currently in the works; this code is only in a GitHub pull request but will be available soon. Until then, please reach out if you would like your samples re-decoded with the new code.",
                date: "2026-10-26",
            },
        ],
    };

    // ^ Backup new-samples data for the dev site (same shape as the API response)
    const DEV_SAMPLES = {
        dayStart: "2026-10-25T00:00:00Z",
        services: [
            { service: "Electra", count: 12 },
            { service: "ExtraVision", count: 4 },
            { service: "NBC Teletext", count: 2 },
            { service: "AgText", count: 1 },
        ],
    };

    // & Format "2026-10-25" as "October 25, 2026" (UTC so the day never shifts)
    function formatLongDate(iso) {
        return new Date(iso).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
        });
    }

    // & Format "2026-10-25" as "10/25/2026"
    function formatShortDate(iso) {
        return new Date(iso).toLocaleDateString("en-US", {
            month: "2-digit",
            day: "2-digit",
            year: "numeric",
            timeZone: "UTC",
        });
    }

    // & Fetch JSON from the API; log and return null on failure so one bad endpoint doesn't break the other
    async function fetchJSON(path) {
        try {
            const res = await fetch(`${API_BASE}${path}`);
            if (!res.ok) throw new Error(`${path} returned ${res.status}`);
            return await res.json();
        } catch (error) {
            console.error("Quick updates failed to load:", error);
            return null;
        }
    }

    // & Get the headlines and new samples (or the backup data on the dev site)
    async function loadData() {
        if (IS_DEV) return [DEV_HEADLINES, DEV_SAMPLES];
        return Promise.all([fetchJSON("/api/marquee/headlines"), fetchJSON("/api/marquee/updates")]);
    }

    // & Turn the API data into stories the rotator can use
    function buildStories(headlines, samples) {
        const stories = [];

        // The new samples story goes first, only if there are new samples
        const services = samples?.services ?? [];
        if (services.length > 0) {
            stories.push({
                title: "New Samples Added",
                body: "",
                list: services.map((s) => `${s.service} - ${s.count}`),
                date: samples.dayStart ? `(${formatLongDate(samples.dayStart)})` : "",
            });
        }

        // Then each headline from the KV
        (headlines?.items ?? [])
            .filter((item) => item.title && item.body)
            .forEach((item) => {
                stories.push({
                    title: item.title,
                    body: item.body,
                    list: [],
                    date: item.date ? `(${formatLongDate(item.date)})` : "",
                });
            });

        return stories;
    }

    document.addEventListener("DOMContentLoaded", async () => {
        const section = document.getElementById("quick-updates");
        const list = document.getElementById("quick-updates-list");
        const srBox = document.getElementById("quick-updates-sr");
        const counter = document.getElementById("quick-updates-counter");
        const lastUpdated = document.getElementById("quick-updates-last-updated");
        const timerText = document.getElementById("next-update-timer-text");
        const container = document.getElementById("quick-updates-container");
        const titleEl = list.querySelector('[data-field="title"]');
        const bodyEl = list.querySelector('[data-field="body"]');
        const listEl = list.querySelector('[data-field="list"]');
        const dateEl = list.querySelector('[data-field="date"]');
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        // Load everything before starting
        const [headlines, samples] = await loadData();
        let stories = buildStories(headlines, samples);

        // If nothing came back, show a single notice instead
        if (stories.length === 0) {
            stories = [{ title: "No Updates Available", body: "There are no updates to show.", list: [], date: "" }];
        }

        // Fill in the "Last Updated" line in the section's header
        if (headlines?.updatedAt && lastUpdated) {
            lastUpdated.textContent = `Last Updated: ${formatShortDate(headlines.updatedAt)}`;
        }

        // & Make a list item with the given text
        function makeItem(text) {
            const li = document.createElement("li");
            li.classList.add("keep-text-white");
            li.textContent = text;
            return li;
        }

        // & Show a story all at once (used for reduced motion and for measuring height)
        function renderStory(story) {
            titleEl.textContent = story.title;
            bodyEl.textContent = story.body;
            listEl.replaceChildren(...story.list.map(makeItem));
            dateEl.textContent = story.date;
        }

        // & Clear everything in the box
        function clearStory() {
            titleEl.textContent = "";
            bodyEl.textContent = "";
            listEl.replaceChildren();
            dateEl.textContent = "";
        }

        // & Show the "next update in..." text after the story finishes typing, then clear it when it reaches 0
        async function countdown(ms) {
            for (let s = Math.ceil(ms / 1000); s > 0; s--) {
                timerText.textContent = `(next update in ${s})`;
                await sleep(1000);
            }

            // Keep the text blank while the story types
            timerText.textContent = "\u00A0";
        }

        const cursor = document.createElement("span");
        cursor.className = "quick-updates-cursor";

        // Lock the box to the tallest story so the layout doesn't jump
        let maxHeight = 0;
        stories.forEach((story) => {
            renderStory(story);
            maxHeight = Math.max(maxHeight, list.offsetHeight);
        });
        list.style.minHeight = maxHeight + "px";
        clearStory();

        // & Overwrite one element's text character by character
        function typeOver(el, newText) {
            const oldText = el.textContent;
            const end = Math.max(newText.length, oldText.length);
            let k = 0;
            return new Promise((resolve) => {
                (function tick() {
                    if (k > end) {
                        // Trim trailing blanks
                        el.textContent = newText;
                        return resolve();
                    }
                    el.replaceChildren(
                        // Past the end of the new text, pad with spaces to blank out old characters
                        document.createTextNode(newText.slice(0, k).padEnd(k, " ")),
                        cursor,
                        document.createTextNode(oldText.slice(k)),
                    );
                    k++;
                    setTimeout(tick, TYPE_SPEED);
                })();
            });
        }

        // & Overwrite the list one item at a time; blank out and remove any extra old items
        async function typeList(newLines) {
            const oldItems = [...listEl.children];
            const count = Math.max(oldItems.length, newLines.length);

            for (let i = 0; i < count; i++) {
                // Add a new item only when it's about to be typed, so empty bullets don't show early
                let li = oldItems[i];
                if (!li) {
                    li = makeItem("");
                    listEl.appendChild(li);
                }
                await typeOver(li, newLines[i] ?? "");
            }

            // Remove items the new story doesn't use
            [...listEl.children].slice(newLines.length).forEach((li) => li.remove());
        }

        // & Show each update's content
        async function showStory(i) {
            const story = stories[i];

            // The update counter in the section's footer
            counter.textContent = `Update ${i + 1} / ${stories.length}`;

            // Red background for the new samples story, blue for everything else
            container?.classList.toggle("samples-story", story.list.length > 0);
            srBox.textContent = [story.title + ".", story.body, story.list.join(", "), story.date].filter(Boolean).join(" ");

            // If a user has reduced motion enabled, display the text normally
            if (reduceMotion) {
                renderStory(story);
                return;
            }

            await typeOver(titleEl, story.title);

            // Clear whichever of the body or list is going away before typing the other,
            // so the two are never on screen together and the box stays the same height
            if (story.list.length > 0) {
                await typeOver(bodyEl, story.body);
                await typeList(story.list);
            } else {
                await typeList([]);
                await typeOver(bodyEl, story.body);
            }

            await typeOver(dateEl, story.date);
            cursor.remove();
        }

        // & Run everything
        async function run() {
            let i = 0;
            while (true) {
                await showStory(i);

                // With only one story, there's nothing to rotate to
                if (stories.length === 1) break;

                await countdown(HOLD_TIME);

                // Loop back to the first story after the last one finishes
                i = (i + 1) % stories.length;
            }
        }

        // Start displaying the updates only when the user scrolls into the section
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    observer.disconnect();
                    run();
                }
            },
            { threshold: 0.4 },
        );

        observer.observe(section);
    });
}