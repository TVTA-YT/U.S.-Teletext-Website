/* global NABTS */
(() => {
    'use strict';

    const scriptURL = document.currentScript?.src;

    // Cloudflare config
    const CONFIG = {
        // ^ Build URL of the T33 stream
        streamURL: (service, sampleID) => `/api/teletext/${encodeURIComponent(service)}/${encodeURIComponent(sampleID)}`,

        // ^ Optional JSON
        metaURL: (service, sampleID) => `/api/teletext/${encodeURIComponent(service)}/${encodeURIComponent(sampleID)}/meta`,

        // ^ Match filename at end of URL and swap it with the NABTS Worker JS
        workerURL: scriptURL ? scriptURL.replace(/[^/]*$/, 'nabts-worker.js') : null
    };

    // Filenames for each service's image banner
    const BANNER_NAMES = {
        edutel: "Edutel",
        extravision: "CBS-ExtraVision",
        nbcteletext: "NBC-Teletext"
    };

    // & Show the service's banner in the page heading
    const showServiceBanner = (service) => {
        const bannerService = BANNER_NAMES[String(service).toLowerCase()];
        if (!bannerService) return;

        const lightBanner = byID('lightImageBanner');
        if (lightBanner) {
            lightBanner.src = `../images/banners/light/${bannerService}_light.png`;
            lightBanner.hidden = false;
        }

        const darkBanner = byID('darkImageBanner');
        if (darkBanner) {
            darkBanner.src = `../images/banners/dark/${bannerService}.png`;
            darkBanner.hidden = false;
        }
    };

    // Various page elements
    const byID = (id) => document.getElementById(id);                       // ~ Helper
    const screenElement = byID('screen');
    const canvas = byID('pageCanvas');
    const canvasContext = canvas.getContext('2d');
    const pageInfo = byID('pageInfo');
    const pageTextBox = byID('pageText');
    const pageFlagsList = byID('pageFlags');
    const pageSelect = byID('pageSelect');
    const entryDisplay = byID('entryDisplay');
    const announcer = byID('announcer');
    const drawProgressBar = byID('drawProgress');
    const drawClock = byID('drawClock');
    const drawInTimeCheckbox = byID('optDrawInTime');
    const blinkCheckbox = byID('optBlink');
    const aspectCheckbox = byID('optAspect');
    const resolutionSelect = byID('optGrid');
    const fontSelect = byID('optFont');
    const fontCredit = byID('fontCredit');
    const speedSelect = byID('optSpeed');
    const mobileGotoForm = byID('mobileGoto');
    const mobilePageInput = byID('mobilePageInput');
    const fullscreenButton = document.querySelector('[data-command="fullscreen"]');


    // ".matches" is true or false; without it, matchMedia() returns an object, which always counts as true
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Convert record types and flag descriptions into labels
    const RECORD_TYPE_NAMES = { 0: 'Page', 1: 'One-off page', 2: 'Application record', 3: 'Priority page' };
    const FLAG_DESCRIPTIONS = {
        caption: 'Captions',
        update: 'Update',
        cyclic: 'Cyclic (repeats in carousel)',
        alarm: 'Alarm',
        support_record: 'Support record',
        support_needed: 'Needs the supported record',
        index: 'Index page',
        more: 'More (continues on next page)'
    };

    // Viewer objects
    const state = {
        streamBytes: null,
        records: [],
        currentIndex: -1,
        grid: [256, 200],
        font: null,
        player: null,
        frameImage: null,
        animationFrameId: 0,
        playbackStart: 0,
        lastPaintedGeneration: -1,
        lastPaintedPalette: '',
        typedDigits: '',
        entryTimeout: 0,
        speed: 1,
        // Receiver whose drawing times the page is played at, and whether lost data is rebuilt (decode-orc PR #328)
        pace: 'classic',
        reconstruct: true
    };

    // Disable the checkbox for the animations if a user prefers reduced motion
    if (prefersReducedMotion) drawInTimeCheckbox.checked = false;

    // & Helper function for screen readers
    const announce = (message) => {
        announcer.textContent = '';
        setTimeout(() => {
            announcer.textContent = message;
        }, 30);
    };

    /*
    * Convert hex values to string
    * Get the first line of the page to display in the page selection dropdown menu; display nothing if blank or unknown
    * Get only the short address (3 digits) and use it for page numbers
    * Group various versions of 1 address into subpages
    * Get the 3-digit page number; currently ignores pages with a long address (e.g. 0000500)
    * Set the source name; read from the file
    */
    const toHex3 = (value) => value.toString(16).toUpperCase().padStart(3, '0');
    const firstTextLine = (record) => (record.text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
    const hasShortAddress = (record) => !record.long_form;
    const pageKey = (record) => `${record.channel}/${record.addr_text}`;
    const pageNumberOf = (record) => (hasShortAddress(record) ? record.addr_text : null);
    const setSourceName = (fileName) => { if (fileName) byID('sourceName').textContent = fileName; };

    // & Load and apply metadata
    const applyMetadata = (metadata) => {
        if (!metadata) return;

        // Update the HTML "title" tag with the service name and sample date
        if (metadata.title) {
            byID('sample-title').textContent = metadata.title;
            document.title = `${metadata.title} - NABTS Viewer`;
        }

        // Display contributor name and T33 filename if available
        if (metadata.contributor) byID('contributor-name').textContent = metadata.contributor;
        if (metadata.fileName) setSourceName(metadata.fileName);

        // A sample with its own banner (e.g. the 1983 ExtraVision samples) replaces the service banner
        // * The IDs must match the <img> IDs in the HTML (lightImageBanner / darkImageBanner)
        for (const [field, imageID] of [['bannerLight', 'lightImageBanner'], ['bannerDark', 'darkImageBanner']]) {
            const banner = byID(imageID);
            if (metadata[field] && banner) {
                banner.src = metadata[field];
                banner.hidden = false;
            }
        }

        if (metadata.bannerTitle) byID('bannerTitle').textContent = metadata.bannerTitle;
    };

    // & Load the sample; async/await waits for the download and prevents the page from freezing
    // & Load the sample; async/await waits for the download and prevents the page from freezing
    const loadSample = async () => {

        // Read the direct URL, service, and ID from the URL
        const query = new URLSearchParams(location.search);

        // "src" is direct file URL. "service" + "id" build the URL from Cloudflare
        const directURL = query.get('src'), service = query.get('service'), sampleID = query.get('sample');

        // Don't load anything if neither of those are available
        if (!directURL && !(service && sampleID)) return;

        // Show service image heading banner
        if (service) showServiceBanner(service);

        // Prefer the direct URL; otherwise, build the URL from the provided service and ID
        const streamURL = directURL || CONFIG.streamURL(service, sampleID);

        // Fetch details from a service and ID if available
        const metadataURL = (!directURL && service && sampleID && CONFIG.metaURL) ? CONFIG.metaURL(service, sampleID) : null;

        pageInfo.textContent = 'Loading sample...';

        // Fetch metadata details in the background. "await" isn't used so the page loads the data upon page load
        if (metadataURL) {
            fetch(metadataURL)
                .then((response) => (response.ok ? response.json() : null))
                .then(applyMetadata)
                .catch(() => { });
        }

        // Show the file name on page load, which is the last part of the URL path. Don't include any URL query parameters
        setSourceName(decodeURIComponent(streamURL.split('?')[0].split('/').pop()));

        // Fetch the stream. Display an error if something goes wrong
        try {
            const response = await fetch(streamURL);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            state.streamBytes = await response.arrayBuffer();
        } catch (error) {
            pageInfo.textContent = `The sample could not be loaded (${error.message})`;
            announce(pageInfo.textContent);
            return;
        }

        // Decode the stream and open the first page
        if (await decodeStream()) openFirstRecord(query.get('page'));
    };

    // & Parse and interpret "state.streamBytes" in the web worker when possible
    const decodeOnMainThread = () => new Promise((resolve, reject) => {

        // Wait 20 ms so the browser can display the "Decoding..." message before the page is busy
        setTimeout(() => {
            try {
                const { records } = NABTS.readT33(new Uint8Array(state.streamBytes));
                NABTS.interpret(records, state.grid, { font: state.font, pace: state.pace, reconstruct: state.reconstruct });
                resolve(records);
            } catch (error) { reject(error); }
        }, 20);
    });

    // & Decoding in the background using Worker JS file; this is here to prevent a large file from freezing the page
    const decodeInWorker = () => new Promise((resolve, reject) => {
        let worker;
        try {
            worker = new Worker(CONFIG.workerURL);
            // If the browser refuses to start the Worker, decode on the page instead
        } catch {
            resolve(decodeOnMainThread());
            return;
        }

        // Display status messages from the worker
        worker.addEventListener('message', ({ data: message }) => {

            // ^ Decoding progress message
            if (message.type === 'progress' && message.total) {
                pageInfo.textContent = `Decoding NABTS stream... ${Math.round(100 * message.done / message.total)}%`;

                // ^ Done message; terminate the Worker and show the records
            } else if (message.type === 'done') {
                worker.terminate();
                resolve(message.records);

                // ^ Error message
            } else if (message.type === 'error') {
                worker.terminate();
                reject(new Error(message.message));
            }
        });

        // If the Worker script failed to either load or run, decode here instead
        worker.addEventListener('error', (event) => {
            event.preventDefault();
            worker.terminate();
            resolve(decodeOnMainThread());
        });

        // Send a copy of the bytes instead of duplicating it
        const bytesCopy = state.streamBytes.slice(0);
        worker.postMessage({ bytes: bytesCopy, grid: state.grid, font: state.font, pace: state.pace, reconstruct: state.reconstruct }, [bytesCopy]);
    });


    // & This will resolve to true when the sample has been decoded and the page list is ready
    const decodeStream = async () => {

        // Stop any animation of the previous page while decoding
        stopAnimation();
        pageInfo.textContent = 'Decoding NABTS stream...';
        const useWorker = CONFIG.workerURL && window.Worker && location.protocol !== 'file:';

        try {
            // Choose one of the 2 and wait for the result
            state.records = useWorker ? await decodeInWorker() : await decodeOnMainThread();

            // Fill in the page selection dropdown menu
            buildPageSelect();
            announce(`Sample loaded: ${state.records.filter((record) => record.page).length} pages.`);
            return true;
        } catch (error) {
            pageInfo.textContent = `The stream could not be decoded: ${error.message}`;
            return false;
        }
    };


    // & Build the page selection menu
    const buildPageSelect = () => {

        // Remove all existing options and apply 1 "optgroup" per channel
        pageSelect.textContent = '';
        const groupsByChannel = new Map();

        // Channel A00 has captions only, so it gets its own label
        state.records.forEach((record, index) => {
            // Pages salvaged without their header (decode-orc PR #328) are fragments with no page number: listed apart
            let channelLabel = record.channel === 0xA00 ? 'Channel A00 (captions)' : `Channel ${toHex3(record.channel)}`;
            if (record.identity_lost) channelLabel = `Channel ${toHex3(record.channel)}: fragments salvaged without a page number`;

            // If the first record, create its group
            if (!groupsByChannel.has(channelLabel)) {
                const optionGroup = document.createElement('optgroup');
                optionGroup.label = channelLabel;
                pageSelect.append(optionGroup);
                groupsByChannel.set(channelLabel, optionGroup);
            }

            // Create short label for records with short addresses (e.g. Page 007 v1) or use long address for non-page records
            let recordLabel = `${hasShortAddress(record) ? `Page ${record.addr_text}` : record.addr_text} v${record.version}`;

            // Pages updated during the recording without a new version number are listed once per edition
            if (record.editions > 1) recordLabel += ` (edition ${record.edition} of ${record.editions})`;
            if (record.identity_lost) recordLabel = `Fragment ${record.addr_text.replace('LOST', '')}`;

            // Page's first line
            let description = record.page ? firstTextLine(record) : (RECORD_TYPE_NAMES[record.type] || 'Record').toLowerCase();

            // Reserved records have their purpose at the front of the label
            if (record.purpose) description = `(${record.purpose}) ${description}`;
            let optionText = description ? `${recordLabel} - ${description}` : recordLabel;

            // Records kept although their address never arrived undamaged (decode-orc PR #328) are marked
            if (record.unconfirmed) optionText += ' (unconfirmed)';

            // Append record's position
            groupsByChannel.get(channelLabel).append(new Option(optionText, index));
        });

        // Disable the dropdown if no records are available
        pageSelect.disabled = !state.records.length;
    };

    // & Get record name index (e.g. 000-007-v1)
    const indexOfRecordName = (name) => state.records.findIndex((record) => NABTS.recordName(record) === name);

    // & Find page number for record when typed
    const findPageNumber = (pageNumber) => {
        pageNumber = String(pageNumber).toUpperCase().padStart(3, '0');
        const currentRecord = state.records[state.currentIndex];
        let firstMatch = -1;

        // Prefer the page on the channel being watched; otherwise the first match on any channel
        for (const [index, record] of state.records.entries()) {
            if (!hasShortAddress(record) || record.addr_text !== pageNumber) continue;
            if (currentRecord && record.channel === currentRecord.channel) return index;
            if (firstMatch < 0) firstMatch = index;
        }

        return firstMatch;
    };

    // & Decide which record to show first after loading the sample
    const openFirstRecord = (requestedPage) => {
        const hashName = decodeURIComponent(location.hash.slice(1));
        let index = hashName ? indexOfRecordName(hashName) : -1;
        if (index < 0 && requestedPage) index = findPageNumber(requestedPage);
        if (index < 0) index = state.records.findIndex((record) => record.page);
        showRecord(Math.max(0, index), true);
    };

    // & Get the position of the first record in list order
    const firstIndexOfEachPage = () => {

        // Remember which page keys have been seen and collect the positions
        const seenPages = new Set(), indexes = [];
        state.records.forEach((record, index) => {
            const key = pageKey(record);
            if (!seenPages.has(key)) {
                seenPages.add(key);
                indexes.push(index);
            }
        });
        return indexes;
    };

    // & The position of all versions (the subpages) of a page's record
    const subpageIndexesOf = (record) => {
        const key = pageKey(record);
        return state.records.flatMap((other, index) => (pageKey(other) === key ? [index] : []));
    };

    // & Move forward or backward 1 page
    const stepPage = (direction) => {
        if (!state.records.length) return;
        const pageStarts = firstIndexOfEachPage(), currentKey = pageKey(state.records[state.currentIndex]);
        const position = pageStarts.findIndex((index) => pageKey(state.records[index]) === currentKey);
        showRecord(pageStarts[(position + direction + pageStarts.length) % pageStarts.length]);
    };

    // & Move forward or backward 1 subpage
    const stepSubpage = (direction) => {
        if (!state.records.length) return;
        const subpages = subpageIndexesOf(state.records[state.currentIndex]);
        if (subpages.length < 2) { announce('This page has no other subpages.'); return; }
        const position = subpages.indexOf(state.currentIndex);
        showRecord(subpages[(position + direction + subpages.length) % subpages.length]);
    };

    // & Refresh the page number display above the keypad
    const updateEntryDisplay = () => {
        const record = state.records[state.currentIndex];
        if (state.typedDigits) entryDisplay.textContent = `${state.typedDigits.padEnd(3, '-')}`;
        else if (record) entryDisplay.textContent = pageNumberOf(record) ? `${pageNumberOf(record)}` : record.addr_text;
        else entryDisplay.textContent = '';

        // The mobile page number box shows the current page as its placeholder
        if (mobilePageInput) mobilePageInput.placeholder = record ? `P${pageNumberOf(record) || record.addr_text}` : 'P---';
    };

    // & Remove unfinished page number entry after 6 seconds
    const cancelEntry = () => {
        clearTimeout(state.entryTimeout);
        if (state.typedDigits) {
            state.typedDigits = '';
            updateEntryDisplay();
        }
    };

    // & Enter 1 digit as its typed (or pressed if using the keypad)
    const typeDigit = (digit) => {
        if (!state.records.length) return;
        clearTimeout(state.entryTimeout);
        state.typedDigits += digit;
        updateEntryDisplay();

        // If fewer than 3 digits are typed, wait at least 6 seconds for another input; if none, clear the display
        if (state.typedDigits.length < 3) {
            state.entryTimeout = setTimeout(cancelEntry, 6000);
            return;
        }
        const pageNumber = state.typedDigits;
        state.typedDigits = '';
        const index = findPageNumber(pageNumber);

        // If page is not in sample, show the number with an added question mark, alert screen readers, then clear the display
        if (index < 0) {
            entryDisplay.textContent = `${pageNumber} ?`;
            announce(`Page ${pageNumber} is not in this sample.`);
            state.entryTimeout = setTimeout(updateEntryDisplay, 1500);
            return;
        }
        showRecord(index);
    };

    // & Convert an application record's bytes into readable text and keep printable characters
    const applicationRecordText = (bytes) => bytes.map((byte) => {
        byte &= 0x7F;
        if (byte === 13) return '\n';
        if (byte >= 0x20 && byte < 0x7F) return String.fromCharCode(byte);
        return `<${byte.toString(16).toUpperCase().padStart(2, '0')}>`;
    }).join('');

    // & Build the record's name and its info line
    const describeRecord = (record, index) => {
        const subpages = subpageIndexesOf(record), subpageNumber = subpages.indexOf(index) + 1;
        const name = record.identity_lost ? `Fragment ${record.addr_text.replace('LOST', '')}`
            : pageNumberOf(record) ? `Page ${pageNumberOf(record)}` : `Record ${record.addr_text}`;
        const parts = [
            name + (record.channel ? ` on channel ${toHex3(record.channel)}` : ''),
            `version ${record.version}${subpages.length > 1 ? ` (subpage ${subpageNumber} of ${subpages.length})` : ''}`
        ];

        // Only name unusual types
        if (record.type !== 0) parts.push(RECORD_TYPE_NAMES[record.type] || `Type ${record.type}`);
        // Different pages were sent under this page number and version during the recording
        if (record.editions > 1) parts.push(`edition ${record.edition} of ${record.editions}: different contents were sent under this page number and version`);
        // Rebuilt from packets whose header was lost, so its page number is unknown and its start is missing
        if (record.identity_lost) parts.push('salvaged fragment: its header was lost, so its page number is unknown and its start is missing');
        if (record.bytes_salvaged && !record.identity_lost) parts.push(`${record.bytes_salvaged} missing bytes recovered from packets whose header was lost`);
        // Lost or damaged bytes rebuilt from the recording's other pages ("Reconstruct lost data")
        const rebuilt = record.reconstruction;
        if (rebuilt && record.rebuilt) {
            const done = [];
            if (rebuilt.filled) done.push(`${rebuilt.filled} of ${rebuilt.lost} lost bytes filled`);
            if (rebuilt.corrected) done.push(`${rebuilt.corrected} damaged bytes corrected`);
            if (rebuilt.inferred) done.push(`${rebuilt.inferred} lost shift${rebuilt.inferred === 1 ? '' : 's'} restored`);
            parts.push(`reconstructed from other pages: ${done.join(', ')}`);
        }
        // Address never arrived undamaged, but the page recurred under it with content of its own
        if (record.unconfirmed) parts.push('unconfirmed: its address was damaged every time it arrived');
        if (record.chain_pos) {
            parts.push(`continuation ${record.chain_pos} of page ${NABTS.addressText(record.chain_base)}, drawn over the pages before it`);
        }
        return { name, summary: `${parts.join(' · ')}.` };
    };

    // & Show all flags in the "Record Flags" list
    const showFlags = (record) => {

        // Keep set flags and convert them into readable text
        const flagDescriptions = Object.keys(FLAG_DESCRIPTIONS)
            .filter((flag) => record.flags[flag])
            .map((flag) => FLAG_DESCRIPTIONS[flag]);

        // Reserved purpose flags (e.g. "Support Record") go first
        if (record.purpose) flagDescriptions.unshift(record.purpose);
        const items = flagDescriptions.length ? flagDescriptions : ['None set'];

        // Replace the list's contents with 1 HTML "li" element per item
        pageFlagsList.replaceChildren(...items.map((text) => {
            const item = document.createElement('li');
            item.textContent = text;

            // If no flags set, turn the text color gray
            if (!flagDescriptions.length) item.className = 'text-body-secondary';
            return item;
        }));
    };

    // & Show record at current position
    const showRecord = (index, keepHash = false) => {
        const record = state.records[index];
        if (!record) return;
        state.currentIndex = index;
        state.typedDigits = '';
        pageSelect.value = String(index);

        // Put page number and version in address bar without adding a browser history entry or reloading the page
        if (!keepHash) history.replaceState?.(null, '', `${location.pathname}${location.search}#${NABTS.recordName(record)}`);

        // Info lines and flags
        const { name, summary } = describeRecord(record, index);
        pageInfo.textContent = summary;
        showFlags(record);

        // Display text in the "Text version..." section
        if (record.page) pageTextBox.textContent = record.text || '(This page has no text.)';
        else if (record.type === 2) {
            pageTextBox.textContent = `Application record (CEA-516 §7.2.2 functions), not a page:\n\n${applicationRecordText(record.data)}`;
        } else pageTextBox.textContent = 'This record has no data to display.';

        // Screen reader announcements
        const firstLine = firstTextLine(record);
        canvas.setAttribute('aria-label', record.page
            ? `NAPLPS screen, ${name}${firstLine ? `: ${firstLine}` : ''}`
            : `${name} has no page to display`);
        updateEntryDisplay();
        startPlayback();
    };

    // & Get how many seconds into the current page the viewer is in
    const playbackSeconds = () => (performance.now() - state.playbackStart) / 1000 * state.speed;

    // & Cancel next scheduled frame (if any)
    const stopAnimation = () => {
        if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
        state.animationFrameId = 0;
    };

    const continueFrom = (seconds) => { state.playbackStart = performance.now() - seconds * 1000 / state.speed; };

    // & Draw 1 frame
    const renderFrame = () => {

        // If frame is running, nothing is pending
        state.animationFrameId = 0;
        const player = state.player;

        // If no page is provided, there is nothing to draw
        if (!player) return;
        const seconds = playbackSeconds();

        // "null" shows blinking colors steady
        const blinkTime = blinkCheckbox.checked ? seconds : null;

        // Make the player draw every color-map change and blink the change due by now
        player.advance(seconds);

        // Current color of every ink as text, which changed when a blink flips
        const paletteKey = player.palette(blinkTime).join(';');

        // Only repaint the page if something new was drawn or if a color changed
        if (player.generation !== state.lastPaintedGeneration || paletteKey !== state.lastPaintedPalette) {
            state.lastPaintedGeneration = player.generation;
            state.lastPaintedPalette = paletteKey;

            // Fill the pixel buffer with the screen's colors, then copy it onto the canvas
            player.paintRGBA(state.frameImage.data, blinkTime);
            canvasContext.putImageData(state.frameImage, 0, 0);
        }

        // Progress bar and clock
        const totalSeconds = player.end || 0, shownSeconds = Math.min(seconds, totalSeconds);
        drawProgressBar.style.width = `${totalSeconds > 0 ? 100 * shownSeconds / totalSeconds : 100}%`;
        drawClock.textContent = `${shownSeconds.toFixed(1)} / ${totalSeconds.toFixed(1)} s`;
        const stillChanging = !player.done() || (blinkCheckbox.checked && player.animating());
        if (stillChanging && !document.hidden) {
            state.animationFrameId = requestAnimationFrame(renderFrame);
        }
    };

    // & Paint the whole canvas black
    const clearScreen = () => {
        canvasContext.fillStyle = '#383838';
        canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    };

    // & Start or restart drawing the current page from the beginning
    const startPlayback = () => {
        stopAnimation();
        const record = state.records[state.currentIndex];
        [canvas.width, canvas.height] = state.grid;

        // If there is no page to draw, show a blank screen with an empty progress
        if (!record?.page) {
            state.player = null;
            clearScreen();
            drawProgressBar.style.width = '0%';
            drawClock.textContent = '';
            return;
        }

        // Create a new player for current page at the chosen resolution and in the chosen font
        state.player = new NABTS.Player(record.page, state.grid, { font: state.font });
        state.frameImage = canvasContext.createImageData(canvas.width, canvas.height);

        // Forget what was previously painted before so the first frame is always painted
        state.lastPaintedGeneration = -1;
        state.lastPaintedPalette = '';
        let startSeconds = 0;

        // If the user unchecks the "Draw page" checkbox, don't draw the page. Display finished page only
        if (!drawInTimeCheckbox.checked) {
            state.player.advance(null);
            startSeconds = state.player.end;
        }

        continueFrom(startSeconds);
        renderFrame();
    };

    // & Functions for the "MORE" key seen on NABTS services
    const continuationOf = (record) => state.records.findIndex((other) =>
        other.page && other.chain_pos === record.chain_pos + 1
        && other.chain_base === record.chain_base
        && other.channel === record.channel
    );

    const pressMore = () => {
        const record = state.records[state.currentIndex];
        if (!record) return;
        const player = state.player;

        if (player) {
            const now = playbackSeconds();

            // The first pause of 2 seconds or more that hasn't finished yet. 0.05 seconds margin ignores a pause that just ended
            const pause = player.pauses(2).find(([, end]) => end > now + 0.05);

            if (pause) {

                // Jump to the end of that pause; anything that came after it is drawn on the next frame
                continueFrom(pause[1]);
                stopAnimation();
                renderFrame();
                announce('More.');
                return;
            }
        }

        // When there's no pause left, go to the continuation page if one is available
        const next = continuationOf(record);
        if (next >= 0) {
            showRecord(next);
            announce(`More: ${describeRecord(state.records[next], next).name}.`);
            return;
        }

        announce('There is no more for this page.');
    };

    // & Magazine, Index and M.Index, as on the Panasonic TU-1000x/TU-2000x remote (TNQ1470)
    // Pages that can be navigated to by number: a short address, a real page number (not a salvaged fragment)
    const isNumberedPage = (record) => hasShortAddress(record) && !record.identity_lost;
    const pageValueOf = (record) => parseInt(record.addr_text, 16);

    // A page's best-received version: the one seen most often (an older version may be badly damaged)
    const bestVersionOf = (index) => subpageIndexesOf(state.records[index])
        .reduce((best, other) => ((state.records[other].seen || 0) > (state.records[best].seen || 0) ? other : best), index);

    // The first page of a channel: its 000 if it has one, otherwise its lowest-numbered page
    const masterIndexOf = (channel) => {
        let best = -1;
        state.records.forEach((record, index) => {
            if (record.channel !== channel || !isNumberedPage(record)) return;
            if (best < 0 || pageValueOf(record) < pageValueOf(state.records[best])) best = index;
        });
        return best < 0 ? best : bestVersionOf(best);
    };

    // M.Index: the master index of the magazine (channel) being watched
    const pressMasterIndex = () => {
        const record = state.records[state.currentIndex];
        if (!record) return;
        const index = masterIndexOf(record.channel);
        if (index < 0) { announce('This channel has no master index.'); return; }
        showRecord(index);
        announce(`Master index: ${describeRecord(state.records[index], index).name}.`);
    };

    // Magazine: the next magazine (channel) in the sample, at its master index. Captions (A00) are not a magazine.
    const pressMagazine = () => {
        const record = state.records[state.currentIndex];
        if (!record) return;
        const channels = [...new Set(state.records.filter((other) => isNumberedPage(other) && other.channel !== 0xA00)
            .map((other) => other.channel))].sort((a, b) => a - b);
        if (channels.length < 2) { announce('This sample has only one magazine.'); return; }
        const next = channels[(channels.indexOf(record.channel) + 1) % channels.length];
        const index = masterIndexOf(next);
        if (index < 0) return;
        showRecord(index);
        announce(`Magazine ${toHex3(next)}: ${describeRecord(state.records[index], index).name}.`);
    };

    // The page numbers an index page lists: "13.Weekdays on WIVB" and "Gas Spill in Lancaster....p1". Every version
    // of the page is read, as one may be damaged where another isn't
    const listedPageNumbers = (record) => {
        const key = pageKey(record), listed = new Set();
        const text = state.records.filter((other) => pageKey(other) === key).map((other) => other.text || '').join('\n');
        for (const match of text.matchAll(/(?:^|[^0-9.])(\d{1,3})\s?\.(?=\s*[A-Za-z0-9"'])/gm)) listed.add(Number(match[1]));
        for (const match of text.matchAll(/\.{2,}\s*[pP]?\s*(\d{1,3})\b/g)) listed.add(Number(match[1]));
        return listed;
    };

    // Index: the index of the section being read. The page the service flagged as an index (a header flag few
    // services set), else the nearest lower-numbered page on the channel that lists this page's number, else M.Index
    const pressIndex = () => {
        const record = state.records[state.currentIndex];
        if (!record || !isNumberedPage(record)) { pressMasterIndex(); return; }
        const value = pageValueOf(record), number = Number(record.addr_text);
        const lower = firstIndexOfEachPage().filter((index) => {
            const other = state.records[index];
            return other.channel === record.channel && isNumberedPage(other) && pageValueOf(other) < value;
        }).sort((a, b) => pageValueOf(state.records[b]) - pageValueOf(state.records[a]));
        const anyFlagged = state.records.some((other) => other.channel === record.channel && other.flags?.index);
        let target = anyFlagged ? lower.find((index) => state.records[index].flags?.index) : undefined;
        if (target === undefined && Number.isFinite(number)) {
            target = lower.find((index) => listedPageNumbers(state.records[index]).has(number));
        }
        if (target === undefined) { pressMasterIndex(); return; }
        target = bestVersionOf(target);
        showRecord(target);
        announce(`Index: ${describeRecord(state.records[target], target).name}.`);
    };

    // The three buttons come from the HTML (data-command="magazine", "index", "master-index"); only if they're
    // missing are they added here, in a row under the More button
    const moreButton = document.querySelector('[data-command="more"]');
    if (moreButton && !document.querySelector('[data-command="magazine"]')) {
        const row = document.createElement('div');
        row.className = 'd-grid gap-2 mb-3';
        row.style.gridTemplateColumns = '1fr 1fr 1fr';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', 'Index keys');
        row.innerHTML = `
            <button type="button" class="btn btn-outline-secondary" data-command="magazine">Magazine</button>
            <button type="button" class="btn btn-outline-secondary" data-command="index">Index</button>
            <button type="button" class="btn btn-outline-secondary" data-command="master-index">M.Index</button>`;
        const help = byID('moreHelp');
        (help || moreButton).after(row);
    }

    // & Full screen toggle
    const toggleFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else screenElement.requestFullscreen?.();
    };

    // Keep the full screen button's pressed state to the right when full screen mode is exited
    document.addEventListener('fullscreenchange', () => {
        fullscreenButton.setAttribute('aria-pressed', String(document.fullscreenElement === screenElement));
    });

    // Each keypad digit button types the corresponding digit
    for (const digitButton of document.querySelectorAll('[data-digit]')) {
        digitButton.addEventListener('click', () => typeDigit(digitButton.dataset.digit));
    }

    // Keypad data commands
    const COMMANDS = {
        more: pressMore,
        magazine: pressMagazine,
        index: pressIndex,
        'master-index': pressMasterIndex,
        replay: () => startPlayback(),
        'prev-page': () => stepPage(-1),
        'next-page': () => stepPage(1),
        'prev-subpage': () => stepSubpage(-1),
        'next-subpage': () => stepSubpage(1),
        fullscreen: toggleFullscreen
    };

    // Connect every data command button to its corresponding function
    // * "?.()" has been added as a failsafe in case a button with an unknown command causes an error
    for (const commandButton of document.querySelectorAll('[data-command]')) {
        commandButton.addEventListener('click', () => COMMANDS[commandButton.dataset.command]?.());
    }

    // & Mobile page number input
    const goToTypedPage = () => {
        const pageNumber = mobilePageInput.value.trim().toUpperCase();
        if (!pageNumber || !state.records.length) return;
        const index = findPageNumber(pageNumber);

        // If page is not in sample, keep the number in the box so it can be corrected
        if (index < 0) {
            announce(`Page ${pageNumber.padStart(3, '0')} is not in this sample.`);
            mobilePageInput.select();
            return;
        }

        // Clear the box and close the on-screen keyboard
        mobilePageInput.value = '';
        mobilePageInput.blur();
        showRecord(index);
    };

    if (mobileGotoForm) {
        mobileGotoForm.addEventListener('submit', (event) => {
            event.preventDefault();
            goToTypedPage();
        });

        // Only digits and A-F (page numbers are hexadecimal, e.g. 06B); go to page once all 3 are typed
        mobilePageInput.addEventListener('input', () => {
            mobilePageInput.value = mobilePageInput.value.replace(/[^0-9a-f]/gi, '').slice(0, 3);
            if (mobilePageInput.value.length === 3) goToTypedPage();
        });
    }

    // Choosing page from dropdown menu will show that page
    pageSelect.addEventListener('change', () => showRecord(Number(pageSelect.value)));

    // Animate the pages if the dropdown box is checked
    drawInTimeCheckbox.addEventListener('change', startPlayback);
    blinkCheckbox.addEventListener('change', () => {
        state.lastPaintedPalette = '';
        stopAnimation();
        renderFrame();
    });

    // Change viewer aspect ratio based on checkbox (4x3 if checked)
    aspectCheckbox.addEventListener('change', () => screenElement.classList.toggle('aspect-ratio', aspectCheckbox.checked));

    // Change drawing speed based on selected option
    speedSelect.addEventListener('change', () => {

        // Keep current speed amount, then continue at the new speed
        const seconds = playbackSeconds();
        state.speed = Number(speedSelect.value) || 1;
        continueFrom(seconds);

        // If the animation has finished, nudge the animation to use the new speed. Otherwise, the animation is already running
        if (state.player && !state.animationFrameId) renderFrame();
    });

    // & Re-decode after a resolution or font change; stay on the same record
    const redecodeKeepingRecord = async () => {

        // If nothing has loaded, don't execute
        if (!state.streamBytes) return;

        // Remember the current record by name since positions can change after re-decoding
        const currentName = state.currentIndex >= 0 ? NABTS.recordName(state.records[state.currentIndex]) : null;

        // If the decoding failed, stop
        if (!(await decodeStream())) return;
        const index = currentName ? indexOfRecordName(currentName) : 0;
        showRecord(Math.max(0, index), true);
    };

    // & Receiver pace and reconstruction options, added beside the drawing speed (decode-orc PR #328)
    const PACE_STORAGE_KEY = 'nabtsViewer.pace', RECONSTRUCT_STORAGE_KEY = 'nabtsViewer.reconstruct';
    try {
        const savedPace = localStorage.getItem(PACE_STORAGE_KEY), savedReconstruct = localStorage.getItem(RECONSTRUCT_STORAGE_KEY);
        if (['classic', 'ttx650', 'tu2000x', 'off'].includes(savedPace)) state.pace = savedPace;
        if (savedReconstruct !== null) state.reconstruct = savedReconstruct === 'true';
    } catch { /* storage unavailable: keep the defaults */ }
    // The options come from the HTML (#optPace, #optReconstruct); only if they're missing are they added here
    const speedRow = speedSelect.closest('.row');
    if (!byID('optPace') && speedRow) {
        const options = document.createElement('div');
        options.className = 'mt-2';
        options.innerHTML = `
            <label for="optPace" class="form-label small mb-1">Receiver drawing times</label>
            <select class="form-select form-select-sm" id="optPace">
                <option value="classic">Fast (original)</option>
                <option value="ttx650">Norpak TTX 650</option>
                <option value="tu2000x">Panasonic TU-2000x</option>
                <option value="off">Instant (no drawing time)</option>
            </select>
            <div class="form-check mt-2">
                <input type="checkbox" class="form-check-input" id="optReconstruct" />
                <label for="optReconstruct" class="form-check-label">Reconstruct lost data</label>
            </div>`;
        speedRow.after(options);
    }
    const paceSelect = byID('optPace'), reconstructCheckbox = byID('optReconstruct');
    if (paceSelect && reconstructCheckbox) {
        paceSelect.value = state.pace;
        reconstructCheckbox.checked = state.reconstruct;
        // Only the interpretation changes, so the records already read are run again on the page (no re-reading)
        const reinterpretKeepingRecord = () => {
            if (!state.records || !state.records.length) return;
            const currentName = state.currentIndex >= 0 ? NABTS.recordName(state.records[state.currentIndex]) : null;
            NABTS.interpret(state.records, state.grid, { font: state.font, pace: state.pace, reconstruct: state.reconstruct });
            const index = currentName ? indexOfRecordName(currentName) : 0;
            showRecord(Math.max(0, index), true);
        };
        paceSelect.addEventListener('change', () => {
            state.pace = paceSelect.value;
            try { localStorage.setItem(PACE_STORAGE_KEY, state.pace); } catch { /* not saved */ }
            reinterpretKeepingRecord();
            announce(`Drawing times: ${paceSelect.selectedOptions[0].textContent}.`);
        });
        reconstructCheckbox.addEventListener('change', () => {
            state.reconstruct = reconstructCheckbox.checked;
            try { localStorage.setItem(RECONSTRUCT_STORAGE_KEY, String(state.reconstruct)); } catch { /* not saved */ }
            reinterpretKeepingRecord();
            announce(`Reconstruct lost data ${state.reconstruct ? 'on' : 'off'}.`);
        });
    }

    // ^ Names under which the user's resolution and font choices are saved in their browser
    const RESOLUTION_STORAGE_KEY = 'nabtsViewer.resolution';
    const FONT_STORAGE_KEY = 'nabtsViewer.font';

    // & Save a choice; storage can be blocked (private windows, settings), so failures are ignored
    const remember = (key, value) => {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Storage unavailable
        }
    };
    const recall = (key) => {
        try {
            return localStorage.getItem(key) || '';
        } catch {
            return '';
        }
    };

    // & Set the resolution and show it in the receiver resolution menu
    // * Add an option if the menu does not have the specified size
    const setResolution = (grid) => {
        state.grid = grid;

        // Adds "x" to the resolution array (e.g. "[256, 200]" becomes "256x200")
        const value = grid.join('x');

        // Copy the menu's option list into an array that can be searched
        if (![...resolutionSelect.options].some((option) => option.value === value)) {
            resolutionSelect.append(new Option(`${grid[0]} × ${grid[1]}`, value));
        }

        resolutionSelect.value = value;
        remember(RESOLUTION_STORAGE_KEY, value);
    };

    // Choose a resolution, then decode the page at that resolution. The font stays as it is
    resolutionSelect.addEventListener('change', () => {
        setResolution(resolutionSelect.value.split('x').map(Number));
        redecodeKeepingRecord();
    });

    // ^ The fonts sets provided by the "NAPLPS Decoder Fonts" JS file; return empty object if font isn't loaded
    const decoderFonts = NABTS.decoderFonts();

    // Add 1 menu option per font set after the default option already in the HTML
    for (const [id, fontSet] of Object.entries(decoderFonts)) fontSelect.append(new Option(fontSet.label, id));

    // & Show font credits, with the resolution the typeface was drawn for as a suggestion only
    const showFontCredit = () => {
        const fontSet = decoderFonts[state.font];
        fontCredit.textContent = fontSet
            ? `${fontSet.credit} Drawn for ${fontSet.grid[0]} × ${fontSet.grid[1]}.`
            : 'Default font (X11 misc-fixed, public domain)';
    };

    // & Choose a font by ID; the resolution stays as the user set it
    const chooseFont = (id) => {
        state.font = decoderFonts[id] ? id : null;
        fontSelect.value = state.font || '';
        showFontCredit();
        remember(FONT_STORAGE_KEY, state.font || '');
    };

    // When selecting a new font, switch to that font, re-decode the page, and announce for screen readers
    fontSelect.addEventListener('change', () => {
        chooseFont(fontSelect.value);
        redecodeKeepingRecord();
        announce(`Font: ${fontSelect.selectedOptions[0].textContent}.`);
    });

    // On page load, restore the saved resolution and font (or the defaults)
    const savedResolution = recall(RESOLUTION_STORAGE_KEY);
    if (/^\d+x\d+$/.test(savedResolution)) setResolution(savedResolution.split('x').map(Number));
    chooseFont(recall(FONT_STORAGE_KEY));

    // Pause the animation while the tab is hidden and resume when it comes back
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopAnimation();
        else if (state.player && !state.animationFrameId) renderFrame();
    });

    // When the URL hash changes, such as using the browser's "Back" button, show that page
    window.addEventListener('hashchange', () => {
        const index = indexOfRecordName(decodeURIComponent(location.hash.slice(1)));
        if (index >= 0 && index !== state.currentIndex) showRecord(index, true);
    });

    // ^ Keyboard arrow shortcuts
    // * NOTE: The viewer must be in focus for these to work
    const SCREEN_KEYS = {
        ArrowUp: () => stepPage(1),
        ArrowDown: () => stepPage(-1),
        ArrowRight: () => stepSubpage(1),
        ArrowLeft: () => stepSubpage(-1),
        Enter: startPlayback,
        ' ': startPlayback
    };

    // Keyboard shortcuts for the whole page (focus viewer not required)
    document.addEventListener('keydown', (event) => {

        //  Do not use browser and system shortcuts
        if (event.ctrlKey || event.metaKey || event.altKey) return;

        // Determine which element has focus and which key was pressed
        const { target, key } = event;

        // Do not take key input while the user is typing in a textarea or using a menu
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName) || target?.isContentEditable) return;

        // Mark a key as handled so the browser doesn't also act on it
        const consume = () => event.preventDefault();

        // Regex for single digits (0-9)
        if (/^[0-9]$/.test(key)) { typeDigit(key); consume(); return; }

        // If using the standard backspace key (named differently on some computers), cancel a half-typed page number
        if (key === 'Escape' || key === 'Backspace' || key === 'Delete') {
            if (state.typedDigits) { cancelEntry(); consume(); }
            return;
        }

        // Standard keyboard shortcuts
        if (key === 'm' || key === 'M') { pressMore(); consume(); return; }
        if (key === '+' || key === '=') { stepPage(1); consume(); return; }
        if (key === '-' || key === '_') { stepPage(-1); consume(); return; }
        if (target === screenElement && SCREEN_KEYS[key]) {
            SCREEN_KEYS[key]();
            consume();
        }
    });

    // ---- Start ---------------------------------------------------------------------------
    screenElement.classList.toggle('aspect-ratio', aspectCheckbox.checked);
    clearScreen();
    loadSample();
})();