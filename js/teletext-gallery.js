(function () {
    "use strict";
    const API_BASE = "https://us-teletext-website.us-teletext-archive.workers.dev/api";
    const RECORD_PATTERN = /^Record-(\d+)-(\d+)(?:-(\d+))?-v([A-Za-z0-9]+)$/i;
    const PAGE_PATTERN = /^Page-(\d+)-(\d+)$/i;

    // Load 30 thumbnail images per requests
    const IMAGES_PER_LOAD = 30;

    // Timeout time: 10 seconds
    const SLOW_LOAD_TIMEOUT_MS = 10000;

    // Load only 1 thumbnail at a time to prevent excess requests
    const THUMBNAIL_CONCURRENCY_LIMIT = 1;

    // Send 1 requests every 750 ms
    const THUMBNAIL_REQUEST_DELAY_MS = 750;

    // If thumbnail fails to load, wait 2 seconds before retrying to prevent excess requests
    const RETRY_DELAY_MS = 2000;

    // Scroll to image once 60px have passed when using mouse wheel or trackpad
    const FS_WHEEL_THRESHOLD = 60;

    // Ignore further input after 450ms
    const FS_WHEEL_COOLDOWN_MS = 450;

    // When swiping on mobile, show next image once 50px has been reached
    const FS_SWIPE_THRESHOLD = 50;

    let activeThumbnailLoads = 0;
    const thumbnailLoadQueue = [];
    let nextThumbnailRequestTime = 0;
    let thumbnailQueueTimer = null;
    let slowLoadTimeoutId = null;
    let mainImageRetryTimer = null;


    // Put thumbnails in a queue before loading
    function enqueueThumbnailLoad(img, src) {
        thumbnailLoadQueue.push({ img, src });
        pumpThumbnailQueue();
    }

    // Schedule another attempt to load the thumbnail again after a delay
    function scheduleThumbnailQueuePump(delay) {
        if (thumbnailQueueTimer !== null) {
            return;
        }

        thumbnailQueueTimer = setTimeout(
            () => {
                thumbnailQueueTimer = null;
                pumpThumbnailQueue();
            },
            Math.max(0, delay),
        );
    }

    // Start requiting the thumbnail
    function pumpThumbnailQueue() {
        if (activeThumbnailLoads >= THUMBNAIL_CONCURRENCY_LIMIT) {
            return;
        }
        if (thumbnailLoadQueue.length === 0) {
            return;
        }

        const now = Date.now();

        if (now < nextThumbnailRequestTime) {
            scheduleThumbnailQueuePump(nextThumbnailRequestTime - now);
            return;
        }

        const job = thumbnailLoadQueue.shift();
        activeThumbnailLoads++;
        job.img.src = job.src;
        nextThumbnailRequestTime = Date.now() + THUMBNAIL_REQUEST_DELAY_MS;
    }

    // When the current thumbnail finishes loading, start loading another one
    function onThumbnailLoadSettled() {
        activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
        pumpThumbnailQueue();
    }

    const els = {
        sampleTitle: document.getElementById("sample-title"),
        image: document.getElementById("teletext-image"),
        hiddenServiceName: document.getElementById("visually-hidden-service-name"),
        lightImageBanner: document.getElementById("light-image-banner"),
        darkImageBanner: document.getElementById("dark-image-banner"),
        contributor: document.getElementById("contributor-name"),
        pageCount: document.getElementById("page-count"),
        spinner: document.getElementById("spinner"),
        actualPageNumber: document.getElementById("actual-page-number"),
        prevBtn: document.getElementById("previous-image"),
        nextBtn: document.getElementById("next-image"),
        gotoForm: document.getElementById("page-form-input"),
        gotoInput: document.getElementById("input-number"),
        gotoError: document.getElementById("page-form-error"),
        loading: document.getElementById("loading"),
        loadError: document.getElementById("loading-error"),
        gallery: document.getElementById("teletext-image-gallery"),
        thumbnailGallery: document.getElementById("teletext-image-gallery-grid"),
        imageLoadAlert: document.getElementById("image-load-alert"),
        imageFallback: document.getElementById("image-fallback"),
        loadMoreBtn: document.getElementById("load-more-images"),
    };

    let frames = [];
    let currentIndex = 0;
    let visibleFrameCount = 0;
    let streamId = null;
    let sampleTitle = "";

    // Display text or alerts depending on why the thumbnails or images fail to load
    function ensureImageFallbackElements() {
        const positionedWrapper = els.image.closest(".position-relative") || els.image.parentNode;

        // Create Bootstrap alert
        if (!els.imageLoadAlert) {
            const alertEl = document.createElement("div");
            alertEl.id = "image-load-alert";
            alertEl.className = "alert alert-warning small text-center d-none";
            alertEl.setAttribute("role", "alert");
            positionedWrapper.parentNode.insertBefore(alertEl, positionedWrapper);
            els.imageLoadAlert = alertEl;
        }

        // Display fallback image container
        if (!els.imageFallback) {
            const fallbackEl = document.createElement("div");
            fallbackEl.id = "image-fallback";
            fallbackEl.className = "d-none align-items-center justify-content-center text-center p-4";
            fallbackEl.style.minHeight = "10px";
            positionedWrapper.parentNode.insertBefore(fallbackEl, positionedWrapper.nextSibling);
            els.imageFallback = fallbackEl;
        }
    }

    // Cancel the slow timer if the image or thumbnail loads before the 10-second cutoff
    function clearSlowLoadTimer() {
        if (slowLoadTimeoutId !== null) {
            clearTimeout(slowLoadTimeoutId);
            slowLoadTimeoutId = null;
        }
    }

    // If the main image is still loading, but a user moves to the second image, cancel the loading retry
    function clearMainImageRetryTimer() {
        if (mainImageRetryTimer !== null) {
            clearTimeout(mainImageRetryTimer);
            mainImageRetryTimer = null;
        }
    }

    // Display the alert for why the images failed to load
    function showSlowLoadAlert(frame, isHardFailure) {
        if (!els.imageLoadAlert) {
            return;
        }

        // Get current page number
        const pageRef = frame ? ` (page ${frame.displayNumber})` : "";

        // Depending on the failure, display one of these in the alert
        els.imageLoadAlert.textContent = isHardFailure
            ? `Failed to load ${pageRef} — archive.org may be experiencing issues. Try again later or refresh the page.`
            : `${pageRef} is taking longer than usual to load — archive.org may be slow right now. Still trying...`;
        els.imageLoadAlert.classList.remove("d-none");
    }

    // If the images successfully load, hide the alert
    function hideSlowLoadAlert() {
        if (els.imageLoadAlert) {
            els.imageLoadAlert.classList.add("d-none");
        }
    }

    // If the images cannot be loaded, display the image's alt value
    function showImageFallback(frame) {
        if (!els.imageFallback) {
            return;
        }

        els.imageFallback.textContent = els.image.alt || "Page " + frame.displayNumber;
        els.imageFallback.classList.remove("d-none");
        els.imageFallback.classList.add("d-flex");
        els.image.hidden = true;
    }

    // If the images successfully load, hide the image fallback element
    function hideImageFallback() {
        if (els.imageFallback) {
            els.imageFallback.classList.add("d-none");
            els.imageFallback.classList.remove("d-flex");
        }

        els.image.hidden = false;
    }

    // Hide the image gallery during loading
    function hideThumbnailGallery() {
        if (els.thumbnailGallery) {
            els.thumbnailGallery.hidden = true;
        }
    }

    // If there is a successful connection and the main image loads, display the image gallery
    function showThumbnailGallery() {
        if (els.thumbnailGallery) {
            els.thumbnailGallery.hidden = false;
        }
    }

    // Get the height of the navbar
    /*
    * This is here because when a user clicks on an image in the image gallery,
    * the page will scroll back to the top to show the primary image viewer.
    *
    * When the page scrolls to the top, the sample title should still be visible
    * and not covered by the navbar.
    */
    function getStickyNavbarHeight() {
        const navbar = document.querySelector(".navbar.fixed-top");
        return navbar ? navbar.offsetHeight : 0;
    }

    // Read URL parameters
    function getQueryParams() {
        const params = new URLSearchParams(window.location.search);
        return {
            stream: params.get("stream"),
            page: params.get("page"),
        };
    }

    // Convert the stored date for each record (YYYY-MM-DD) to Mon. DD, YYYY)
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

    // Parse record file names
    function parseFilename(nameNoExt) {
        const recordMatch = RECORD_PATTERN.exec(nameNoExt);

        // This is used for CBS and NBC images (NABTS). These pages start with "Record"
        if (recordMatch) {
            const duplicateIndex = recordMatch[3] !== undefined ? parseInt(recordMatch[3], 10) : 0;

            return {
                kind: "record",
                pageNumber: parseInt(recordMatch[2], 10),
                displayNumber: `${recordMatch[2]}-v${recordMatch[4]}`,
                subIndex: recordMatch[4],
                duplicateIndex,
                collapse: false,
            };
        }

        const pageMatch = PAGE_PATTERN.exec(nameNoExt);

        // This is used for WST images (DaTaVizion, Electra, Keyfax, etc.). These pages start with "Page"
        if (pageMatch) {
            return {
                kind: "page",
                pageNumber: parseInt(pageMatch[1], 10),
                displayNumber: `${pageMatch[1]}-${pageMatch[2]}`,
                subIndex: parseInt(pageMatch[2], 10),
                collapse: false,
            };
        }

        return null;
    }

    // Convert the raw manifest images into useable images. Figure out where they belong, sort in order, find duplicates, then output completed list
    function buildFrameList(rawImages) {
        const frames = [];

        // Loop through each image and remove the file extension
        rawImages.forEach((entry) => {
            const nameNoExt = entry.filename.replace(/\.[^.]+$/, "");
            const parsed = parseFilename(nameNoExt);

            // Ignore non-understandable file names
            if (!parsed) return;

            // Create frame object
            frames.push({
                kind: parsed.kind,
                pageNumber: parsed.pageNumber,
                displayNumber: parsed.displayNumber,
                subIndex: parsed.subIndex,
                filename: entry.filename,
                url: entry.url,
            });
        });

        // Sort images in order by page number, by page number and subpage number, or by index if page numbers are identical
        frames.sort((a, b) => a.pageNumber - b.pageNumber || a.subIndex - b.subIndex) || (a.duplicateIndex ?? 0) - (b.duplicateIndex ?? 0);

        let i = 0;

        // Examine each frame, find matching page numbers, calculate the group size, label each duplicate, then return completed list
        while (i < frames.length) {
            let j = i;

            while (j < frames.length && frames[j].displayNumber === frames[i].displayNumber) {
                j++;
            }

            const groupSize = j - i;

            for (let k = i; k < j; k++) {
                frames[k].occurrenceIndex = k - i + 1;
                frames[k].occurrenceCount = groupSize;
            }
            i = j;
        }

        return frames;
    }

    // Update status if needed
    function setStatus(message) {
        if (els.status) {
            els.status.textContent = message;
        }
    }

    // Show or hide the "Load X more images" button depending on how many images are left to load
    function updateLoadMoreButton() {
        if (!els.loadMoreBtn) {
            return;
        }

        if (!visibleFrameCount) {
            els.loadMoreBtn.classList.add("d-none");
            return;
        }

        const remaining = frames.length - visibleFrameCount;

        if (remaining <= 0) {
            els.loadMoreBtn.classList.add("d-none");
            return;
        }

        const amountToLoad = Math.min(IMAGES_PER_LOAD, remaining);
        els.loadMoreBtn.textContent = `Load ${amountToLoad} more image${amountToLoad === 1 ? "" : "s"}`;
        els.loadMoreBtn.classList.remove("d-none");
    }

    let thumbnailRow = null;

    // Build each thumbnail image one at a time
    function buildThumbnailElement(frame, i) {
        const col = document.createElement("div");
        col.className = "col-2 p-2";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "thumbnail-button p-0 border-0 bg-transparent w-100";
        btn.dataset.index = String(i);
        btn.setAttribute("aria-label", "Go to page " + frame.displayNumber);
        btn.setAttribute("aria-current", i === currentIndex ? "true" : "false");
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.className = i === currentIndex ? "mw-100 border border-primary rounded-2" : "mw-100 border border-white rounded-2";
        const label = document.createElement("div");
        label.className = "small text-center mt-1 invisible";
        label.textContent = frame.displayNumber;
        let retried = false;
        let retryTimer = null;

        // If image loads successfully, clear the retry timer and show the image
        img.onload = () => {
            if (retryTimer !== null) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }

            label.classList.remove("invisible");
            onThumbnailLoadSettled();
        };

        // If it doesn't try it again
        img.onerror = () => {
            if (!retried) {
                retried = true;

                retryTimer = setTimeout(() => {
                    retryTimer = null;
                    img.src = frame.url;
                }, RETRY_DELAY_MS);

                return;
            }

            // Replace image with the fallback container if it fails to load
            const fallback = document.createElement("div");
            fallback.className = img.className + " d-flex align-items-center justify-content-center text-center p-2 small";
            fallback.style.aspectRatio = "4 / 3";
            fallback.textContent = "Page " + frame.displayNumber;
            img.replaceWith(fallback);
            label.remove();
            onThumbnailLoadSettled();
        };

        btn.appendChild(img);
        btn.appendChild(label);

        // When an image in the gallery is clicked, scroll to the image viewer at the top of the page
        btn.addEventListener("click", () => {
            render(i);
            const anchor = els.sampleTitle || els.image;
            const navbarHeight = getStickyNavbarHeight();
            const targetY = anchor.getBoundingClientRect().top + window.pageYOffset - navbarHeight;

            window.scrollTo({
                top: Math.max(0, targetY),
                behavior: "smooth",
            });
        });

        col.appendChild(btn);
        enqueueThumbnailLoad(img, frame.url)
        return col;
    }

    // Create thumbnail ranges (30 images at a time)
    function appendThumbnailRange(startIndex, endIndex) {
        if (!els.thumbnailGallery || !thumbnailRow) {
            return;
        }

        for (let i = startIndex; i < endIndex; i++) {
            thumbnailRow.appendChild(buildThumbnailElement(frames[i], i));
        }
    }

    // Create the thumbnail gallery
    function renderThumbnails() {
        if (!els.thumbnailGallery) {
            return;
        }

        els.thumbnailGallery.innerHTML = "";
        const row = document.createElement("div");
        row.className = "row justify-content-center pt-3";
        els.thumbnailGallery.appendChild(row);
        thumbnailRow = row;
        appendThumbnailRange(0, visibleFrameCount);
    }
    // Mark the current thumbnail image with a border
    function updateActiveThumbnail() {
        if (!els.thumbnailGallery) {
            return;
        }

        const buttons = els.thumbnailGallery.querySelectorAll(".thumbnail-button");

        buttons.forEach((btn, i) => {
            const isActive = i === currentIndex;
            const img = btn.querySelector("img");
            btn.setAttribute("aria-current", isActive ? "true" : "false");

            if (img) {
                img.classList.toggle("border-primary", isActive);
                img.classList.toggle("border-white", !isActive);
            }
        });
    }

    // Disable previous and next button when viewing the first or last image
    function refreshNavControls() {
        if (els.pageCount) {
            els.pageCount.textContent = `Image ${currentIndex + 1} out of ${frames.length}`;
        }

        els.prevBtn.disabled = currentIndex === 0;
        els.nextBtn.disabled = currentIndex === frames.length - 1;

        //
        if (fullscreenOpen) {
            renderFullscreenChrome();
        }
    }

    // ! Render everything
    function render(index) {
        // Return any images
        if (!frames.length) {
            return;
        }

        /*
        * Clamp array index.
        * Get selected frame.
        * Make the thumbnails visible if scrolling into ones that haven't been displayed.
        * Refresh navigation controls
        */
        currentIndex = Math.max(0, Math.min(index, frames.length - 1));
        const frame = frames[currentIndex];
        ensureFrameVisible(currentIndex + 1);
        refreshNavControls();

        // Show spinner for loading images
        if (els.spinner) {
            els.spinner.hidden = false;
        }

        // Call fallback functions
        ensureImageFallbackElements();
        clearSlowLoadTimer();
        clearMainImageRetryTimer();
        hideSlowLoadAlert();
        hideImageFallback();
        hideThumbnailGallery();

        // Start 10-second load timer
        slowLoadTimeoutId = setTimeout(() => {
            showSlowLoadAlert(frame, false);
            showImageFallback(frame);

            if (els.spinner) {
                els.spinner.hidden = true;
            }
        }, SLOW_LOAD_TIMEOUT_MS);

        let mainImageRetried = false;

        // Handlers for successful image load
        els.image.onload = () => {
            clearSlowLoadTimer();
            clearMainImageRetryTimer();
            hideSlowLoadAlert();
            hideImageFallback();
            showThumbnailGallery();

            if (els.spinner) {
                els.spinner.hidden = true;
            }
        };

        // Handlers for failed image load
        els.image.onerror = () => {
            if (!mainImageRetried) {
                mainImageRetried = true;

                mainImageRetryTimer = setTimeout(() => {
                    mainImageRetryTimer = null;
                    els.image.src = frame.url;
                }, RETRY_DELAY_MS);

                return;
            }

            clearSlowLoadTimer();

            if (els.spinner) {
                els.spinner.hidden = true;
            }

            showSlowLoadAlert(frame, true);
            showImageFallback(frame);
            setStatus(`This image failed to load (page ${frame.displayNumber}).`);
        };

        // Request image, update alt value, and set Bootstrap caption
        els.image.src = frame.url;
        els.image.alt = `Page ${frame.displayNumber}.`;
        els.image.dataset.bsCaption = `${sampleTitle} — Page ${frame.displayNumber}`;

        // Create caption
        if (els.caption) {
            const captionParts = ["Page " + frame.displayNumber];

            if (frame.occurrenceCount > 1) {
                captionParts.push("capture " + frame.occurrenceIndex + " of " + frame.occurrenceCount);
            }

            // If the image begins with "record," push the version number to the image name
            if (frame.kind === "record" && frame.subIndex) {
                captionParts.push("v" + frame.subIndex);
            }

            captionParts.push("image " + (currentIndex + 1) + " of " + frames.length);
            els.caption.textContent = captionParts.join(" — ");
        }

        // Update page number
        if (els.actualPageNumber) {
            els.actualPageNumber.textContent = frame.displayNumber;
        }

        // Update page number input and update active thumbnail
        els.gotoInput.value = frame.pageNumber;
        setStatus("Showing image " + (currentIndex + 1) + " of " + frames.length + ", page " + frame.displayNumber);
        updateActiveThumbnail();

        // Update the URL with the new parameters
        const params = new URLSearchParams(window.location.search);
        params.set("stream", streamId);
        params.set("page", String(frame.pageNumber));
        history.replaceState(null, "", "?" + params.toString());

        // Run function only when full screen mode is enabled
        if (fullscreenOpen) {
            renderFullscreenFrame(currentIndex);
        }
    }

    // !
    function ensureFrameVisible(imageNumber) {
        if (imageNumber > visibleFrameCount && imageNumber <= frames.length) {
            const previousVisibleCount = visibleFrameCount;
            visibleFrameCount = Math.min(Math.ceil(imageNumber / IMAGES_PER_LOAD) * IMAGES_PER_LOAD, frames.length);
            appendThumbnailRange(previousVisibleCount, visibleFrameCount);
            updateLoadMoreButton();
            refreshNavControls();
        }
    }

    // Find an image based on the actual teletext page number, not the overall image number
    function goToPage(pageNumber) {
        const index = frames.findIndex((frame) => frame.pageNumber === pageNumber);

        if (index === -1) {
            if (els.gotoError) {
                els.gotoError.textContent = `No page ${pageNumber} was found in this gallery.`;
            }

            setStatus(`No page ${pageNumber} was found in this gallery.`);
            return false;
        }

        ensureFrameVisible(index + 1);

        if (els.gotoError) {
            els.gotoError.textContent = "";
        }

        render(index);
        return true;
    }

    // Load more thumbnail images if a user requests it
    function loadMoreImages() {
        if (visibleFrameCount >= frames.length) {
            return;
        }

        const previousVisibleCount = visibleFrameCount;
        visibleFrameCount = Math.min(visibleFrameCount + IMAGES_PER_LOAD, frames.length);
        appendThumbnailRange(previousVisibleCount, visibleFrameCount);
        showThumbnailGallery();
        updateActiveThumbnail();
        updateLoadMoreButton();
        refreshNavControls();
        setStatus(`Loaded ${visibleFrameCount} of ${frames.length} images.`);

        if (visibleFrameCount > previousVisibleCount) {
            const buttons = els.thumbnailGallery ? els.thumbnailGallery.querySelectorAll(".thumbnail-button") : null;

            if (buttons && buttons[previousVisibleCount]) {
                buttons[previousVisibleCount].scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                });
            }
        }
    }

    // If the image or thumbnails couldn't be loaded, show an error and hide the image gallery
    function showLoadError() {
        els.loading.hidden = true;
        els.loadError.hidden = false;
        els.gallery.setAttribute("aria-busy", "false");

        if (els.loadMoreBtn) {
            els.loadMoreBtn.classList.add("d-none");
        }
    }

    // Full screen variables
    let fullscreenOpen = false;
    let fullscreenWheelAccumulator = 0;
    let fullscreenWheelCooldown = false;
    let fullscreenTouchStartX = null;
    let fullscreenTouchStartY = null;
    let fullscreenLastFocused = null;
    let fullscreenHintTimer = null;

    // Empty object for full screen elements
    const fullscreenElements = {};

    // & Build the full screen viewer
    function buildFullscreenViewer() {
        const overlay = document.createElement("div");
        overlay.id = "fullscreen-image-viewer";
        overlay.className = "fullscreen-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Full screen image viewer");
        overlay.hidden = true;

        // ^ Close button
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "fullscreen-close";
        closeBtn.setAttribute("aria-label", "Close full screen viewer");
        closeBtn.innerHTML = "&times;";
        closeBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            closeFullscreen();
        });

        // ^ Images
        const imgWrap = document.createElement("div");
        imgWrap.className = "fullscreen-image-wrap";

        const img = document.createElement("img");
        img.className = "fullscreen-image";
        img.alt = "";
        img.draggable = false;

        // ^ Loading spinner
        const spinner = document.createElement("div");
        spinner.className = "fullscreen-spinner spinner-border text-primary";
        spinner.setAttribute("role", "status");
        spinner.hidden = true;

        imgWrap.appendChild(img);
        imgWrap.appendChild(spinner);

        // ^ Image caption
        const caption = document.createElement("div");
        caption.className = "fullscreen-image-caption";
        caption.setAttribute("aria-live", "polite");

        // ^ Viewer hint
        const hint = document.createElement("div");
        hint.className = "fullscreen-hint";
        hint.textContent = "Scroll or click to browse images \u2022 Press Escape to close";

        overlay.appendChild(closeBtn);
        overlay.appendChild(imgWrap);
        overlay.appendChild(caption);
        overlay.appendChild(hint);

        document.body.appendChild(overlay);

        fullscreenElements.overlay = overlay;
        fullscreenElements.closeBtn = closeBtn;
        fullscreenElements.imgWrap = imgWrap;
        fullscreenElements.img = img;
        fullscreenElements.spinner = spinner;
        fullscreenElements.caption = caption;
        fullscreenElements.hint = hint;

        // ^ Go to next or previous image
        overlay.addEventListener("click", (event) => {
            const rect = overlay.getBoundingClientRect();
            const relativeX = event.clientX - rect.left;
            fullscreenImageNavigate(relativeX > rect.width / 2 ? 1 : -1);
        });

        // ^ Listen for mouse wheel, trackpad, and touch scrolls.
        // * First "passive" is false to prevent the browser's default scrolling behavior
        overlay.addEventListener("wheel", onFullscreenWheel, { passive: false });
        overlay.addEventListener("touchstart", onFullscreenTouchStart, { passive: true });
        overlay.addEventListener("touchend", onFullscreenTouchEnd, { passive: true });
    }

    // & Open the full screen viewer
    function openFullscreen(index) {
        if (!frames.length) return;

        // Show overlay and lock the body behind the overlay to prevent it from scrolling
        fullscreenLastFocused = document.activeElement;
        fullscreenOpen = true;
        fullscreenElements.overlay.hidden = false;
        document.body.classList.add("fullscreen-lock");

        // Load selected image inside the viewer
        renderFullscreenFrame(index);

        // For keyboards, focus the close button
        fullscreenElements.closeBtn.focus();

        // Show hint when viewer is first opened; close it after 3 seconds
        fullscreenElements.hint.classList.add("fullscreen-hint-visible");
        clearTimeout(fullscreenHintTimer);
        fullscreenHintTimer = setTimeout(() => {
            fullscreenElements.hint.classList.remove("fullscreen-hint-visible");
        }, 3000);
    }

    // & Close the full screen viewer
    function closeFullscreen() {
        if (!fullscreenOpen) return;

        // Remove overlay and unlock the body
        fullscreenOpen = false;
        fullscreenElements.overlay.hidden = true;
        document.body.classList.remove("fullscreen-lock");

        // Remove keyboard focus from close button and put it back where it originally was
        if (fullscreenLastFocused && typeof fullscreenLastFocused.focus === "function") {
            fullscreenLastFocused.focus();
        }
    }

    // & Change the images inside the overlay
    function fullscreenImageNavigate(delta) {
        const target = currentIndex + delta;

        // !
        if (target < 0 || target > frames.length - 1) return;
        render(target);
    }

    /*
    ! This function does nothing if there are loaded images with captions.
    ! This is merely here as a safety check to prevent the overlay from loading if both aren't present.
    */
    function renderFullscreenChrome() {
        if (!fullscreenElements.caption || !frames[currentIndex]) return;
    }

    // & Render the full screen image
    function renderFullscreenFrame(index) {

        // Load whatever image the user clicks on
        const frame = frames[index];
        if (!frame || !fullscreenElements.img) return;

        // Show loading spinner and temporarily set image opacity to 0
        fullscreenElements.spinner.hidden = false;
        fullscreenElements.img.style.opacity = "0";

        // This is used later; this checks to see of an image retry has been used
        let retriedImage = false;

        // Show the image on load if successful
        fullscreenElements.img.onload = () => {
            fullscreenElements.spinner.hidden = true;
            fullscreenElements.img.style.opacity = "1";
        };

        // If unsuccessful, wait 2 seconds before trying again
        fullscreenElements.img.onerror = () => {

            // If the image load is unsuccessful the first time, try loading it again.
            if (!retriedImage) {
                retriedImage = true;
                setTimeout(() => {
                    fullscreenElements.img.src = frame.url;
                }, RETRY_DELAY_MS);
                return;
            }

            // If a retry fails a second time, stop retrying and hide the spinner
            fullscreenElements.spinner.hidden = true;
        };

        // Assign images
        fullscreenElements.img.src = frame.url;
        fullscreenElements.img.alt = `Page ${frame.displayNumber}.`;

        // Build image caption
        const parts = ["Page " + frame.displayNumber];

        // Differentiate different versions of the same page if needed
        if (frame.occurrenceCount > 1) {
            parts.push("capture " + frame.occurrenceIndex + " of " + frame.occurrenceCount);
        }

        // Differentiate versions of different "record" pages (NABTS pages use "Record" instead of "Page")
        if (frame.kind === "record" && frame.subIndex) {
            parts.push("v" + frame.subIndex);
        }

        // Add image positions
        parts.push((index + 1) + " of " + frames.length);
        fullscreenElements.caption.textContent = parts.join(" - ");
    }

    // & This will handle mouse wheen and trackpad scrolling
    function onFullscreenWheel(event) {

        // Do not scroll body behind the overlay
        event.preventDefault();
        if (fullscreenWheelCooldown) return;

        // Take current scroll movement in pixels and add it to accumulated amount
        fullscreenWheelAccumulator += event.deltaY;

        // If the scroll movement meets the threshold, reset the threshold count, disable another nav scroll, then go forward 1 image
        if (fullscreenWheelAccumulator > FS_WHEEL_THRESHOLD) {
            fullscreenWheelAccumulator = 0;
            fullscreenWheelCooldown = true;
            fullscreenImageNavigate(1);

            // Enable navigation again after the cooldown period
            setTimeout(() => {
                fullscreenWheelCooldown = false;
            }, FS_WHEEL_COOLDOWN_MS);

            // Do the same as the code above,but go back 1 image
        } else if (fullscreenWheelAccumulator < -FS_WHEEL_THRESHOLD) {
            fullscreenWheelAccumulator = 0;
            fullscreenWheelCooldown = true;
            fullscreenImageNavigate(-1);
            setTimeout(() => {
                fullscreenWheelCooldown = false;
            }, FS_WHEEL_COOLDOWN_MS);
        }
    }

    // & This will handle mobile swiping; calculates where the swiping begins (finger touch)
    function onFullscreenTouchStart(event) {
        const touch = event.touches[0];
        fullscreenTouchStartX = touch.clientX;
        fullscreenTouchStartY = touch.clientY;
    }

    // & This will handle mobile swiping; calculates where the swiping ends (finger lift)
    function onFullscreenTouchEnd(event) {
        if (fullscreenTouchStartX === null) return;

        const touch = event.changedTouches[0];
        const deltaX = fullscreenTouchStartX - touch.clientX;
        const deltaY = fullscreenTouchStartY - touch.clientY;

        // If the swipe is vertical and meets the threshold requirement, it is a navigation gesture
        if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > FS_SWIPE_THRESHOLD) {
            fullscreenImageNavigate(deltaY > 0 ? 1 : -1);

            // Otherwise, handle horizontal swiped
        } else if (Math.abs(deltaX) > FS_SWIPE_THRESHOLD) {
            fullscreenImageNavigate(deltaX > 0 ? 1 : -1)
        }

        fullscreenTouchStartX = null;
        fullscreenTouchStartY = null;
    }

    // ! Initialize the gallery
    async function init() {
        if (els.loadMoreBtn) {
            els.loadMoreBtn.classList.add("d-none");
        }

        const { stream, page } = getQueryParams();

        if (!stream) {
            showLoadError();
            els.loadError.textContent = 'No stream specified. This page expects a "stream" URL parameter.';
            return;
        }

        // Construct API URL for the gallery manifest
        streamId = stream;
        const manifestUrl = `${API_BASE}/gallery/${encodeURIComponent(stream)}`;

        try {
            const response = await fetch(manifestUrl);

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error("This gallery hasn't been generated yet.");
                }
                throw new Error("Manifest request failed: " + response.status);
            }

            const manifest = await response.json();
            frames = buildFrameList(manifest.images || []);

            // Show error if the filename pattern is incorrect
            if (!frames.length) {
                showLoadError();
                els.loadError.textContent = "This gallery has no images matching the expected filename pattern.";
                return;
            }

            // Show first 30 thumbnails on successful load
            visibleFrameCount = Math.min(IMAGES_PER_LOAD, frames.length);
            const service = manifest.service || "";
            const bannerService = service.replace(/\s+/g, "-");

            if (els.hiddenServiceName) {
                els.hiddenServiceName.textContent = service;
            }

            // Depending on the service, fetch and display the necessary image heading banner; this is for light mode. The bottom "if" is for dark mode
            if (els.lightImageBanner) {
                els.lightImageBanner.src = `../images/banners/light/${bannerService}_light.png`;
            }

            if (els.darkImageBanner) {
                els.darkImageBanner.src = `../images/banners/dark/${bannerService}.png`;
            }

            // Format the date from the JSON and display it and the service name as the page title
            const formattedDate = formatDate(manifest.date);
            sampleTitle = `${service} (${formattedDate})`;

            if (els.sampleTitle) {
                els.sampleTitle.textContent = sampleTitle;
            }

            // Update the HTML "title" tag as needed
            document.title = sampleTitle;

            // Show name of contributor or nothing if a contributor name is not available
            if (els.contributor) {
                els.contributor.textContent = manifest.recovered_by || "";
            }

            // Hide loading state
            els.loading.hidden = true;
            els.gallery.setAttribute("aria-busy", "false");
            renderThumbnails();
            updateLoadMoreButton();

            const requestedPage = page !== null ? parseInt(page, 10) : null;

            // Determine the page to show
            if (requestedPage !== null && !Number.isNaN(requestedPage)) {
                if (!goToPage(requestedPage)) {
                    render(0);
                }
            } else {
                render(0);
            }
        } catch (err) {
            console.error("Teletext gallery load error:", err);
            showLoadError();
            if (els.loadError && err && err.message) {
                els.loadError.textContent = err.message;
            }
        }
    }

    // Previous and Next buttons
    els.prevBtn.addEventListener("click", () => render(currentIndex - 1));
    els.nextBtn.addEventListener("click", () => render(currentIndex + 1));

    if (els.loadMoreBtn) {
        els.loadMoreBtn.addEventListener("click", loadMoreImages);
    }

    // If a user enter a specific page number in the input field, show that page (image)
    els.gotoForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = parseInt(els.gotoInput.value, 10);

        if (Number.isNaN(value)) {
            if (els.gotoError) {
                els.gotoError.textContent = "Enter a valid page number.";
            }

            return;
        }

        goToPage(value);
    });

    els.image.classList.add("expandable-image");
    els.image.setAttribute("role", "button");
    els.image.setAttribute("tabindex", "0");
    els.image.setAttribute("aria-label", "View this image full screen");
    els.image.addEventListener("click", () => openFullscreen(currentIndex));
    els.image.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openFullscreen(currentIndex);
        }
    });

    buildFullscreenViewer();

    // Keyboard functions
    document.addEventListener("keydown", (event) => {
        if (fullscreenOpen) {
            if (event.key === "Escape") {
                closeFullscreen();
            } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                fullscreenImageNavigate(1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                fullscreenImageNavigate(-1)
            }

            return;
        }

        if (document.activeElement === els.gotoInput) {
            return;
        }

        if (event.key === "ArrowLeft" && !els.prevBtn.disabled) {
            render(currentIndex - 1);
        }

        if (event.key === "ArrowRight" && !els.nextBtn.disabled) {
            render(currentIndex + 1);
        }
    });

    init();
})();