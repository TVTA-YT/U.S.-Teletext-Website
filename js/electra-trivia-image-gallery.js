document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('gallery-container');
    const yearSelect = document.getElementById('trivia-year');
    const monthSelect = document.getElementById('trivia-month');
    const status = document.getElementById('trivia-status');

    const TRIVIA_API_URL = '/api/electra-keyfax-trivia';

    // Delay between image requests by 500 ms
    const REQUEST_DELAY_MS = 500;

    // If an image fails to load, wait 2 seconds before retrying once
    const RETRY_DELAY_MS = 2000;

    // Full screen viewer: scroll 60px (mouse wheel/trackpad) to change image, then ignore input for 450 ms
    const FS_WHEEL_THRESHOLD = 60;
    const FS_WHEEL_COOLDOWN_MS = 450;

    // Full screen viewer: swipe 50px on mobile to change image
    const FS_SWIPE_THRESHOLD = 50;

    // ^ Month value used for pages whose caption isn't a readable date
    const UNKNOWN_MONTH = 'unknown';

    const MONTH_NAMES = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];

    // year -> month ("1"–"12" or UNKNOWN_MONTH) -> [items], filled once the data arrives
    const byYearMonth = new Map();

    // Bumped on every render, so images queued for an old selection stop loading
    let renderToken = 0;

    // The images for the selected month, in the order shown (the full screen viewer steps through these)
    let currentItems = [];

    fetch(TRIVIA_API_URL)
        .then(response => {
            if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
            return response.json();
        })
        .then(setUpGallery)
        .catch(error => {
            console.error('Failed to load gallery data:', error);
            container.innerHTML = '<p class="text-center text-danger">Unable to load images. There may be an issue somewhere.</p>';
            yearSelect.disabled = true;
            monthSelect.disabled = true;
        });

    // Turn the caption value in the JSON into a JS Date
    // Only real dates count: "December 13, 1992", "Dec 13, 1992", "12/13/1992" or "1992-12-13".
    // (new Date() on its own guesses: it reads "Summer 1990" as January 1990.)
    function parseCaptionDate(caption) {
        const text = String(caption ?? '').trim();
        let year, month, day;

        let m = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
        if (m) {
            // Full month name or an abbreviation of at least 3 letters ("Dec", "Sept")
            const word = m[1].toLowerCase();
            month = word.length >= 3 ? MONTH_NAMES.findIndex(name => name.toLowerCase().startsWith(word)) + 1 : 0;
            day = Number(m[2]);
            year = Number(m[3]);
        } else if ((m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
            [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
        } else if ((m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
            [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
        } else {
            return null;
        }

        if (month < 1 || month > 12) return null;
        const date = new Date(year, month - 1, day);
        return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
    }

    // Create image alt text
    function buildAltText(item) {
        let text = item.caption || `Trivia page from ${item.year}`;
        if (item.contributor) {
            text += ` (contributed by: ${item.contributor})`;
        }
        return text;
    }

    function monthLabel(month) {
        return month === UNKNOWN_MONTH ? 'Unknown date' : MONTH_NAMES[Number(month) - 1];
    }


    /* GROUPING AND MENUS */

    // ! Group the data by year and month, then build the menus
    function setUpGallery(items) {
        if (!Array.isArray(items) || items.length === 0) {
            container.innerHTML = '<p>No images available.</p>';
            yearSelect.disabled = true;
            monthSelect.disabled = true;
            return;
        }

        items.forEach(item => {
            const year = String(item.year);
            const date = parseCaptionDate(item.caption);
            const month = date ? String(date.getMonth() + 1) : UNKNOWN_MONTH;

            if (!byYearMonth.has(year)) byYearMonth.set(year, new Map());
            const months = byYearMonth.get(year);
            if (!months.has(month)) months.set(month, []);
            months.get(month).push({ ...item, date });
        });

        // Sort each month's images by date (undated ones last)
        byYearMonth.forEach(months => {
            months.forEach(monthItems => {
                monthItems.sort((a, b) => {
                    if (!a.date && !b.date) return 0;
                    if (!a.date) return 1;
                    if (!b.date) return -1;
                    return a.date - b.date;
                });
            });
        });

        // Year menu: oldest to newest, starting on "Select a year"
        const years = [...byYearMonth.keys()].sort((a, b) => Number(a) - Number(b));
        yearSelect.replaceChildren(placeholder('Select a year'), ...years.map(year => new Option(year, year)));
        yearSelect.disabled = false;

        // Nothing is selected unless the URL asks for a year/month (e.g. a shared ?year=1992&month=12 link)
        applySelectionFromUrl();
    }

    // & First option in a menu, shown until the user picks something
    function placeholder(text) {
        const option = new Option(text, '');
        option.disabled = true;
        option.selected = true;
        return option;
    }

    // & Clear the gallery and ask the user to choose
    function showPrompt(text) {
        renderToken++; // stop any images still loading
        currentItems = [];
        const prompt = document.createElement('p');
        prompt.className = 'text-center text-body-secondary py-4';
        prompt.textContent = text;
        container.replaceChildren(prompt);
        status.textContent = '';
    }

    // & Restore the year/month from the URL, or start with nothing selected
    function applySelectionFromUrl() {
        const params = new URLSearchParams(location.search);
        const year = params.get('year');

        if (!byYearMonth.has(year)) {
            yearSelect.value = '';
            monthSelect.replaceChildren(placeholder('Select a month'));
            monthSelect.disabled = true;
            showPrompt('Choose a year and month to see the pages.');
            return;
        }

        yearSelect.value = year;
        fillMonths(year, params.get('month'));

        if (monthSelect.value) render({ updateUrl: false });
        else showPrompt('Choose a month to see the pages.');
    }

    // Month menu: only the months that have images in the chosen year
    function fillMonths(year, preferredMonth) {
        const months = [...byYearMonth.get(year).keys()].sort((a, b) => {
            if (a === UNKNOWN_MONTH) return 1;
            if (b === UNKNOWN_MONTH) return -1;
            return Number(a) - Number(b);
        });

        monthSelect.replaceChildren(placeholder('Select a month'), ...months.map(month => {
            const count = byYearMonth.get(year).get(month).length;
            return new Option(`${monthLabel(month)} (${count})`, month);
        }));
        monthSelect.disabled = false;

        // Only pre-select a month when the URL asks for one; otherwise leave "Select a month"
        monthSelect.value = months.includes(preferredMonth) ? preferredMonth : '';
    }

    yearSelect.addEventListener('change', () => {
        // A new year starts with no month selected
        fillMonths(yearSelect.value, null);
        showPrompt('Choose a month to see the pages.');

        // Keep the URL in step (year only), so a reload doesn't bring back the old month
        const url = new URL(location.href);
        url.searchParams.set('year', yearSelect.value);
        url.searchParams.delete('month');
        history.replaceState(null, '', url);
        monthSelect.focus();
    });

    monthSelect.addEventListener('change', () => {
        if (monthSelect.value) render();
    });

    // Back/forward buttons restore an earlier selection
    window.addEventListener('popstate', () => {
        closeFullscreen();
        if (byYearMonth.size) applySelectionFromUrl();
    });


    /* SHOWING THE SELECTED MONTH */

    // ! Show only the images for the selected year and month
    function render({ updateUrl = true } = {}) {
        const year = yearSelect.value;
        const month = monthSelect.value;
        const monthItems = byYearMonth.get(year)?.get(month) ?? [];
        const token = ++renderToken;

        if (updateUrl) {
            const url = new URL(location.href);
            url.searchParams.set('year', year);
            url.searchParams.set('month', month);
            history.pushState(null, '', url);
        }

        const heading = document.createElement('h2');
        heading.className = 'mt-4 mb-3';
        heading.textContent = month === UNKNOWN_MONTH ? `${year} (unknown date)` : `${monthLabel(month)} ${year}`;

        const row = document.createElement('div');
        row.className = 'row';
        const images = [];
        currentItems = monthItems;

        monthItems.forEach((item, index) => {
            const col = document.createElement('div');
            col.className = 'col-lg-3 col-md-4 col-6';

            // A button, so the image can be opened with the keyboard as well as the mouse
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'trivia-image-button p-0 border-0 bg-transparent w-100';
            button.setAttribute('aria-label', `View ${item.caption || 'this trivia page'} full screen`);
            button.addEventListener('click', () => openFullscreen(index));

            // Creating the image and its metadata
            const img = document.createElement('img');
            img.dataset.src = item.imageURL;
            img.alt = buildAltText(item);
            img.className = 'figure-img mw-100 border border-white rounded expandable-image loading';
            button.appendChild(img);
            col.appendChild(button);

            // Add date caption underneath each image
            const dateLabel = document.createElement('p');
            dateLabel.className = 'text-center';
            dateLabel.textContent = item.caption;
            col.appendChild(dateLabel);

            row.appendChild(col);
            images.push(img);
        });

        container.replaceChildren(heading, row);

        // Announced by screen readers (the status element has aria-live="polite")
        const pages = monthItems.length === 1 ? 'page' : 'pages';
        status.textContent = `Showing ${monthItems.length} trivia ${pages} from ${heading.textContent}.`;

        loadImagesInOrder(images, token);
    }

    // Load the month's images one at a time, 500 ms apart, instead of all at once
    function loadImagesInOrder(images, token) {
        let index = 0;

        function loadNext() {
            // Stop if the user picked another month in the meantime
            if (token !== renderToken || index >= images.length) return;

            const img = images[index++];
            img.addEventListener('load', () => img.classList.remove('loading'), { once: true });
            img.addEventListener('error', () => {
                img.classList.remove('loading');
                img.classList.add('load-error');
            }, { once: true });
            img.src = img.dataset.src;

            setTimeout(loadNext, REQUEST_DELAY_MS);
        }

        loadNext();
    }


    /* FULL SCREEN VIEWER (same viewer and CSS classes as the teletext sample gallery) */

    let fullscreenOpen = false;
    let fullscreenIndex = 0;
    let fullscreenWheelAccumulator = 0;
    let fullscreenWheelCooldown = false;
    let fullscreenTouchStartX = null;
    let fullscreenTouchStartY = null;
    let fullscreenLastFocused = null;
    let fullscreenHintTimer = null;
    let fullscreenRetryTimer = null;
    const fullscreenElements = {};

    // & Build the full screen viewer
    function buildFullscreenViewer() {
        const overlay = document.createElement('div');
        overlay.id = 'fullscreen-image-viewer';
        overlay.className = 'fullscreen-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Full screen image viewer');
        overlay.hidden = true;

        // ^ Close button
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'fullscreen-close';
        closeBtn.setAttribute('aria-label', 'Close full screen viewer');
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            closeFullscreen();
        });

        // ^ Image
        const imgWrap = document.createElement('div');
        imgWrap.className = 'fullscreen-image-wrap';

        const img = document.createElement('img');
        img.className = 'fullscreen-image';
        img.alt = '';
        img.draggable = false;

        // ^ Loading spinner
        const spinner = document.createElement('div');
        spinner.className = 'fullscreen-spinner spinner-border text-primary';
        spinner.setAttribute('role', 'status');
        spinner.hidden = true;

        imgWrap.appendChild(img);
        imgWrap.appendChild(spinner);

        // ^ Caption (date, contributor, position)
        const caption = document.createElement('div');
        caption.className = 'fullscreen-image-caption';
        caption.setAttribute('aria-live', 'polite');

        // ^ Viewer hint
        const hint = document.createElement('div');
        hint.className = 'fullscreen-hint';
        hint.textContent = 'Scroll or click to browse images • Press Escape to close';

        overlay.appendChild(closeBtn);
        overlay.appendChild(imgWrap);
        overlay.appendChild(caption);
        overlay.appendChild(hint);
        document.body.appendChild(overlay);

        Object.assign(fullscreenElements, { overlay, closeBtn, imgWrap, img, spinner, caption, hint });

        // ^ Click the right half for the next image, the left half for the previous one
        overlay.addEventListener('click', (event) => {
            const rect = overlay.getBoundingClientRect();
            const relativeX = event.clientX - rect.left;
            fullscreenImageNavigate(relativeX > rect.width / 2 ? 1 : -1);
        });

        // ^ Mouse wheel, trackpad and touch. "passive: false" lets the wheel handler stop the page behind from scrolling
        overlay.addEventListener('wheel', onFullscreenWheel, { passive: false });
        overlay.addEventListener('touchstart', onFullscreenTouchStart, { passive: true });
        overlay.addEventListener('touchend', onFullscreenTouchEnd, { passive: true });
    }

    // & Open the full screen viewer on one of the selected month's images
    function openFullscreen(index) {
        if (!currentItems.length) return;

        // Show overlay and lock the page behind it so it doesn't scroll
        fullscreenLastFocused = document.activeElement;
        fullscreenOpen = true;
        fullscreenElements.overlay.hidden = false;
        document.body.classList.add('fullscreen-lock');

        renderFullscreenFrame(index);

        // For keyboards, focus the close button
        fullscreenElements.closeBtn.focus();

        // Show the hint when the viewer opens; hide it after 3 seconds
        fullscreenElements.hint.classList.add('fullscreen-hint-visible');
        clearTimeout(fullscreenHintTimer);
        fullscreenHintTimer = setTimeout(() => {
            fullscreenElements.hint.classList.remove('fullscreen-hint-visible');
        }, 3000);
    }

    // & Close the full screen viewer
    function closeFullscreen() {
        if (!fullscreenOpen) return;

        fullscreenOpen = false;
        fullscreenElements.overlay.hidden = true;
        document.body.classList.remove('fullscreen-lock');
        clearTimeout(fullscreenRetryTimer);

        // Put keyboard focus back on the image that was opened
        if (fullscreenLastFocused && typeof fullscreenLastFocused.focus === 'function') {
            fullscreenLastFocused.focus();
        }
    }

    // & Go to the next (1) or previous (-1) image in the selected month
    function fullscreenImageNavigate(delta) {
        const target = fullscreenIndex + delta;
        if (target < 0 || target > currentItems.length - 1) return;
        renderFullscreenFrame(target);
    }

    // & Show one image in the viewer
    function renderFullscreenFrame(index) {
        const item = currentItems[index];
        if (!item) return;
        fullscreenIndex = index;

        // Show the spinner and hide the image until it loads
        fullscreenElements.spinner.hidden = false;
        fullscreenElements.img.style.opacity = '0';
        clearTimeout(fullscreenRetryTimer);

        let retriedImage = false;

        fullscreenElements.img.onload = () => {
            fullscreenElements.spinner.hidden = true;
            fullscreenElements.img.style.opacity = '1';
        };

        // If loading fails, wait 2 seconds and try once more
        fullscreenElements.img.onerror = () => {
            if (!retriedImage) {
                retriedImage = true;
                fullscreenRetryTimer = setTimeout(() => {
                    fullscreenElements.img.src = item.imageURL;
                }, RETRY_DELAY_MS);
                return;
            }
            fullscreenElements.spinner.hidden = true;
        };

        fullscreenElements.img.src = item.imageURL;
        fullscreenElements.img.alt = buildAltText(item);

        // Caption: "December 13, 1992 - Contributed by TVTA - 2 of 4"
        const parts = [item.caption || `Trivia page from ${item.year}`];
        if (item.contributor) parts.push(`Contributed by ${item.contributor}`);
        parts.push(`${index + 1} of ${currentItems.length}`);
        fullscreenElements.caption.textContent = parts.join(' - ');
    }

    // & Mouse wheel and trackpad scrolling
    function onFullscreenWheel(event) {
        // Don't scroll the page behind the overlay
        event.preventDefault();
        if (fullscreenWheelCooldown) return;

        fullscreenWheelAccumulator += event.deltaY;

        if (Math.abs(fullscreenWheelAccumulator) > FS_WHEEL_THRESHOLD) {
            fullscreenImageNavigate(fullscreenWheelAccumulator > 0 ? 1 : -1);
            fullscreenWheelAccumulator = 0;
            fullscreenWheelCooldown = true;

            // Allow navigation again after the cooldown
            setTimeout(() => {
                fullscreenWheelCooldown = false;
            }, FS_WHEEL_COOLDOWN_MS);
        }
    }

    // & Mobile swiping: where the finger touches down
    function onFullscreenTouchStart(event) {
        const touch = event.touches[0];
        fullscreenTouchStartX = touch.clientX;
        fullscreenTouchStartY = touch.clientY;
    }

    // & Mobile swiping: where the finger lifts
    function onFullscreenTouchEnd(event) {
        if (fullscreenTouchStartX === null) return;

        const touch = event.changedTouches[0];
        const deltaX = fullscreenTouchStartX - touch.clientX;
        const deltaY = fullscreenTouchStartY - touch.clientY;

        // Vertical swipe, otherwise horizontal swipe
        if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > FS_SWIPE_THRESHOLD) {
            fullscreenImageNavigate(deltaY > 0 ? 1 : -1);
        } else if (Math.abs(deltaX) > FS_SWIPE_THRESHOLD) {
            fullscreenImageNavigate(deltaX > 0 ? 1 : -1);
        }

        fullscreenTouchStartX = null;
        fullscreenTouchStartY = null;
    }

    // Keyboard: Escape closes, arrow keys change image (only while the viewer is open)
    document.addEventListener('keydown', (event) => {
        if (!fullscreenOpen) return;

        if (event.key === 'Escape') {
            closeFullscreen();
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            fullscreenImageNavigate(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            fullscreenImageNavigate(-1);
        }
    });

    buildFullscreenViewer();
});