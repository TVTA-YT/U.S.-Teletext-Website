const API_BASE = "";

const LIST_URL = `${API_BASE}/api/news`;
const STORY_URL = (id) => `${API_BASE}/api/news/${encodeURIComponent(id)}`;
const BASE_TITLE = document.title;

const grid = document.getElementById("story-grid");
const view = document.getElementById("story-view");

const byId = new Map(); // id -> list entry
const storyCache = new Map(); // id -> full story (with body), so revisiting doesn't refetch
let lastOpenedId = null;

// & Escape text values from the DB before putting them into HTML (the story body is the only raw HTML)
function esc(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// & "2026-10-26" -> "October 26, 2026" (parsed as a local date to avoid the UTC off-by-one-day problem)
function formatDate(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    if (!y || !m || !d) return esc(iso);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}


/* PREVIEW GRID */

// & One card. Replace the markup inside with your own design; keep the outer <a href="#id" data-story-id>.
function renderCard(s) {
    const col = document.createElement("div");
    col.className = "col-lg-4 col-md-6 col-12";
    col.innerHTML = `
    ${s.preview ? `<img class="news-card-image mw-100" src="${esc(s.preview)}" alt="${esc(s.previewAlt)}" loading="lazy" />` : ""}
    <p class="news-card-date mb-0">${formatDate(s.date)}</p>
    <a class="news-card ${s.isNew ? "news-card-new" : ""}" href="#${esc(s.id)}" data-story-id="${esc(s.id)}">
        <h2 class="story ${s.isNew ? "text-primary" : ""}">
        ${s.isNew ? '<span class="visually-hidden">New: </span>' : ""}${esc(s.title)}
    </h2>
    </a>
    ${s.summary ? `<p class="news-card-summary">${esc(s.summary)}</p>` : ""}
    `;
    return col;
}

// & "2026-10-26" -> "2026-10" (year included, so October 2026 and October 2027 stay separate)
function monthKey(iso) {
    return String(iso).slice(0, 7);
}

// & "2026-10" -> "October 2026"
function monthLabel(key) {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function renderGrid(stories) {
    if (!stories.length) {
        grid.innerHTML = `<p class="text-center">No articles yet.</p>`;
        return;
    }

    // Group stories by month. The API sends newest first, so the newest month comes first too
    const months = new Map();
    for (const s of stories) {
        const key = monthKey(s.date);
        if (!months.has(key)) months.set(key, []);
        months.get(key).push(s);
    }

    const sections = [...months].map(([key, monthStories]) => {
        const section = document.createElement("section");
        section.className = "news-month mb-5";
        section.setAttribute("aria-labelledby", `month-${key}`);

        const heading = document.createElement("h1");
        heading.id = `month-${key}`;
        heading.className = "news-month-heading";
        heading.textContent = monthLabel(key);

        const row = document.createElement("div");
        row.className = "row g-4";
        row.append(...monthStories.map(renderCard));

        section.append(heading, row);
        return section;
    });

    grid.replaceChildren(...sections);
}


/* STORY VIEW */

async function loadStory(id) {
    if (!storyCache.has(id)) storyCache.set(id, await getJson(STORY_URL(id)));
    return storyCache.get(id);
}

async function showStory(id, sectionId) {
    lastOpenedId = id;
    grid.hidden = true;
    view.hidden = false;
    view.setAttribute("aria-busy", "true");
    view.innerHTML = `<p class="text-center py-5">Loading…</p>`;

    try {
        const s = await loadStory(id);
        view.innerHTML = `
            <a href="#" class="btn btn-outline-secondary mb-4 news-back">
                <i class="bi bi-arrow-left" aria-hidden="true"></i> All articles
            </a>
            <p class="mb-0">${formatDate(s.date)}</p>
            ${s.author ? `<p class="text-body-secondary">Written by: ${esc(s.author)}</p>` : ""}
            <h1 class="story ${s.isNew ? "text-primary" : ""}" id="story-heading" tabindex="-1">
                ${s.isNew ? "NEW: " : ""}${esc(s.title)}
            </h1>
            <div class="story-body">${s.body}</div>`;
        document.title = `${s.title} - ${BASE_TITLE}`;
    } catch (err) {
        view.innerHTML = `
            <p>Sorry, this story couldn't be loaded (${esc(err.message)}).</p>
            <a href="#" class="btn btn-outline-secondary news-back">Back to all articles</a>`;
    }
    view.removeAttribute("aria-busy");

    // Deep link to a section inside a story, e.g. #electra-sportscreen_2026-10-02/mel-stewart-pages
    const target = sectionId && document.getElementById(sectionId);
    if (target) {
        target.scrollIntoView();
    } else {
        window.scrollTo(0, 0);
        document.getElementById("story-heading")?.focus({ preventScroll: true });
    }
}

function showGrid() {
    view.hidden = true;
    view.innerHTML = "";
    grid.hidden = false;
    document.title = BASE_TITLE;

    const card = lastOpenedId && grid.querySelector(`[data-story-id="${CSS.escape(lastOpenedId)}"]`);
    if (card) {
        card.focus({ preventScroll: true });
        card.scrollIntoView({ block: "center" });
    }
}


/* ROUTING */

// URL forms:
//   teletext-news.html                       -> grid
//   teletext-news.html#<storyId>             -> story
//   teletext-news.html#<storyId>/<sectionId> -> story, scrolled to a section
function route() {
    const [id, sectionId] = decodeURIComponent(location.hash.slice(1)).split("/");
    if (id && byId.has(id)) showStory(id, sectionId);
    else showGrid();
}

grid.addEventListener("click", (e) => {
    const card = e.target.closest("a[data-story-id]");
    if (!card || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState({ fromGrid: true }, "", `#${card.dataset.storyId}`);
    route();
});

view.addEventListener("click", (e) => {
    const back = e.target.closest(".news-back");
    if (!back) return;
    e.preventDefault();
    if (history.state?.fromGrid) {
        history.back();
    } else {
        // Arrived straight on a story link: go to the grid without leaving the page
        history.pushState(null, "", location.pathname + location.search);
        route();
    }
});

window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

(async function init() {
    grid.innerHTML = `<p class="text-center py-5">Loading articles…</p>`;
    try {
        const stories = await getJson(LIST_URL);
        stories.forEach((s) => byId.set(s.id, s));
        renderGrid(stories); // already newest first from the API
    } catch (err) {
        grid.innerHTML = `<p class="text-center">Couldn't load articles (${esc(err.message)}). Please try again later.</p>`;
        return;
    }
    route();
})();