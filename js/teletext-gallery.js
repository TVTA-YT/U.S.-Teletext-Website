(function () {
  'use strict';

  const MANIFEST_PATH_TEMPLATE = '../json/teletext-image-data/gallery-{stream}.json';
  const RECORD_PATTERN = /^Record-(\d+)-(\d+)-v([A-Za-z0-9]+)$/i;
  const PAGE_PATTERN = /^Page-(\d+)-(\d+)$/i;

  const IMAGES_PER_LOAD = 30;
  const SLOW_LOAD_TIMEOUT_MS = 10000;
  const THUMBNAIL_CONCURRENCY_LIMIT = 1;
  const THUMBNAIL_REQUEST_DELAY_MS = 750;
  const RETRY_DELAY_MS = 2000;

  let activeThumbnailLoads = 0;
  const thumbnailLoadQueue = [];
  let nextThumbnailRequestTime = 0;
  let thumbnailQueueTimer = null;

  function enqueueThumbnailLoad(img, src) {
    thumbnailLoadQueue.push({ img, src });
    pumpThumbnailQueue();
  }

  function scheduleThumbnailQueuePump(delay) {
    if (thumbnailQueueTimer !== null) {
      return;
    }
    thumbnailQueueTimer = setTimeout(() => {
      thumbnailQueueTimer = null;
      pumpThumbnailQueue();
    }, Math.max(0, delay));
  }

  function pumpThumbnailQueue() {
    if (activeThumbnailLoads >= THUMBNAIL_CONCURRENCY_LIMIT) return;
    if (thumbnailLoadQueue.length === 0) return;

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

  function onThumbnailLoadSettled() {
    activeThumbnailLoads = Math.max(0, activeThumbnailLoads - 1);
    pumpThumbnailQueue();
  }

  const els = {
    sampleTitle: document.getElementById('sample-title'),
    image: document.getElementById('teletext-image'),
    hiddenServiceName: document.getElementById('visually-hidden-service-name'),
    lightImageBanner: document.getElementById('light-image-banner'),
    darkImageBanner: document.getElementById('dark-image-banner'),
    contributor: document.getElementById('contributor-name'),
    pageCount: document.getElementById('page-count'),
    spinner: document.getElementById('spinner'),
    actualPageNumber: document.getElementById('actual-page-number'),
    prevBtn: document.getElementById('previous-image'),
    nextBtn: document.getElementById('next-image'),
    gotoForm: document.getElementById('page-form-input'),
    gotoInput: document.getElementById('input-number'),
    gotoError: document.getElementById('page-form-error'),
    loading: document.getElementById('loading'),
    loadError: document.getElementById('loading-error'),
    gallery: document.getElementById('teletext-image-gallery'),
    thumbnailGallery: document.getElementById('teletext-image-gallery-grid'),
    imageLoadAlert: document.getElementById('image-load-alert'),
    imageFallback: document.getElementById('image-fallback'),
    loadMoreBtn: document.getElementById('load-more-images')
  };

  let frames = [];
  let currentIndex = 0;
  let visibleFrameCount = 0;
  let streamId = null;
  let sampleTitle = '';
  let slowLoadTimeoutId = null;

  function ensureImageFallbackElements() {
    const positionedWrapper = els.image.closest('.position-relative') || els.image.parentNode;

    if (!els.imageLoadAlert) {
      const alertEl = document.createElement('div');
      alertEl.id = 'image-load-alert';
      alertEl.className = 'alert alert-warning small text-center d-none';
      alertEl.setAttribute('role', 'alert');
      positionedWrapper.parentNode.insertBefore(alertEl, positionedWrapper);
      els.imageLoadAlert = alertEl;
    }

    if (!els.imageFallback) {
      const fallbackEl = document.createElement('div');
      fallbackEl.id = 'image-fallback';
      fallbackEl.className = 'd-none align-items-center justify-content-center text-center p-4';
      fallbackEl.style.minHeight = '10px';
      positionedWrapper.parentNode.insertBefore(fallbackEl, positionedWrapper.nextSibling);
      els.imageFallback = fallbackEl;
    }
  }

  function clearSlowLoadTimer() {
    if (slowLoadTimeoutId !== null) {
      clearTimeout(slowLoadTimeoutId);
      slowLoadTimeoutId = null;
    }
  }

  function showSlowLoadAlert(frame, isHardFailure) {
    if (!els.imageLoadAlert) return;
    els.imageLoadAlert.textContent = isHardFailure
      ? 'This image failed to load — archive.org may be experiencing issues. Try again later or refresh the page.'
      : 'This image is taking longer than usual to load — archive.org may be slow right now. Still trying...';
    els.imageLoadAlert.classList.remove('d-none');
  }

  function hideSlowLoadAlert() {
    if (els.imageLoadAlert) els.imageLoadAlert.classList.add('d-none');
  }

  function showImageFallback(frame) {
    if (!els.imageFallback) return;
    els.imageFallback.textContent = els.image.alt || ('Page ' + frame.displayNumber);
    els.imageFallback.classList.remove('d-none');
    els.imageFallback.classList.add('d-flex');
    els.image.hidden = true;
  }

  function hideImageFallback() {
    if (els.imageFallback) {
      els.imageFallback.classList.add('d-none');
      els.imageFallback.classList.remove('d-flex');
    }
    els.image.hidden = false;
  }

  function hideThumbnailGallery() {
    if (els.thumbnailGallery) els.thumbnailGallery.hidden = true;
  }

  function showThumbnailGallery() {
    if (els.thumbnailGallery) els.thumbnailGallery.hidden = false;
  }

  function getStickyNavbarHeight() {
    const navbar = document.querySelector('.navbar.fixed-top');
    return navbar ? navbar.offsetHeight : 0;
  }

  function getQueryParams() {
    const params = new URLSearchParams(window.location.search);
    return { stream: params.get('stream'), page: params.get('page') };
  }

  function formatDate(dateString) {
    if (!dateString) return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString));
    if (!match) return String(dateString);
    const [, year, month, day] = match;
    const months = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
    const monthIndex = Number(month) - 1;
    if (monthIndex < 0 || monthIndex > 11) return String(dateString);
    return `${months[monthIndex]} ${Number(day)}, ${year}`;
  }

  function parseFilename(nameNoExt) {
    const recordMatch = RECORD_PATTERN.exec(nameNoExt);
    if (recordMatch) {
      return {
        kind: 'record',
        pageNumber: parseInt(recordMatch[2], 10),
        displayNumber: `${recordMatch[2]}-v${recordMatch[3]}`,
        subIndex: recordMatch[3],
        collapse: false
      };
    }
    const pageMatch = PAGE_PATTERN.exec(nameNoExt);
    if (pageMatch) {
      return {
        kind: 'page',
        pageNumber: parseInt(pageMatch[1], 10),
        displayNumber: `${pageMatch[1]}-${pageMatch[2]}`,
        subIndex: parseInt(pageMatch[2], 10),
        collapse: false
      };
    }
    return null;
  }

  function buildFrameList(rawImages) {
    const frames = [];
    rawImages.forEach((entry) => {
      const nameNoExt = entry.filename.replace(/\.[^.]+$/, '');
      const parsed = parseFilename(nameNoExt);
      if (!parsed) return;
      frames.push({
        kind: parsed.kind,
        pageNumber: parsed.pageNumber,
        displayNumber: parsed.displayNumber,
        subIndex: parsed.subIndex,
        filename: entry.filename,
        url: entry.url
      });
    });

    frames.sort((a, b) => a.pageNumber - b.pageNumber || a.subIndex - b.subIndex);

    let i = 0;
    while (i < frames.length) {
      let j = i;
      while (j < frames.length && frames[j].displayNumber === frames[i].displayNumber) j++;
      const groupSize = j - i;
      for (let k = i; k < j; k++) {
        frames[k].occurrenceIndex = k - i + 1;
        frames[k].occurrenceCount = groupSize;
      }
      i = j;
    }
    return frames;
  }

  function setStatus(message) {
    if (els.status) els.status.textContent = message;
  }

  function updateLoadMoreButton() {
    if (!els.loadMoreBtn) return;
    if (!visibleFrameCount) {
      els.loadMoreBtn.classList.add('d-none');
      return;
    }
    const remaining = frames.length - visibleFrameCount;
    if (remaining <= 0) {
      els.loadMoreBtn.classList.add('d-none');
      return;
    }
    const amountToLoad = Math.min(IMAGES_PER_LOAD, remaining);
    els.loadMoreBtn.textContent = `Load ${amountToLoad} more image${amountToLoad === 1 ? '' : 's'}`;
    els.loadMoreBtn.classList.remove('d-none');
  }

  let thumbnailRow = null;

  function buildThumbnailElement(frame, i) {
    const col = document.createElement('div');
    col.className = 'col-2 p-2';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tt-thumb-btn p-0 border-0 bg-transparent w-100';
    btn.dataset.index = String(i);
    btn.setAttribute('aria-label', 'Go to page ' + frame.displayNumber);
    btn.setAttribute('aria-current', i === currentIndex ? 'true' : 'false');

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = i === currentIndex ? 'mw-100 border border-primary rounded-2' : 'mw-100 border border-white rounded-2';

    const label = document.createElement('div');
    label.className = 'small text-center mt-1 invisible';
    label.textContent = frame.displayNumber;

    let retried = false;
    let retryTimer = null;

    img.onload = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      label.classList.remove('invisible');
      onThumbnailLoadSettled();
    };

    img.onerror = () => {
      if (!retried) {
        retried = true;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          img.src = frame.url;
        }, RETRY_DELAY_MS);
        return;
      }
      const fallback = document.createElement('div');
      fallback.className = img.className + ' d-flex align-items-center justify-content-center text-center p-2 small';
      fallback.style.aspectRatio = '4 / 3';
      fallback.textContent = 'Page ' + frame.displayNumber;
      img.replaceWith(fallback);
      label.remove();
      onThumbnailLoadSettled();
    };

    btn.appendChild(img);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      render(i);
      const anchor = els.sampleTitle || els.image;
      const navbarHeight = getStickyNavbarHeight();
      const targetY = anchor.getBoundingClientRect().top + window.pageYOffset - navbarHeight;
      window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
    });

    col.appendChild(btn);
    enqueueThumbnailLoad(img, frame.url);
    return col;
  }

  function appendThumbnailRange(startIndex, endIndex) {
    if (!els.thumbnailGallery || !thumbnailRow) return;
    for (let i = startIndex; i < endIndex; i++) {
      thumbnailRow.appendChild(buildThumbnailElement(frames[i], i));
    }
  }

  function renderThumbnails() {
    if (!els.thumbnailGallery) return;
    els.thumbnailGallery.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'row justify-content-center pt-3';
    els.thumbnailGallery.appendChild(row);
    thumbnailRow = row;
    appendThumbnailRange(0, visibleFrameCount);
  }

  function updateActiveThumbnail() {
    if (!els.thumbnailGallery) return;
    const buttons = els.thumbnailGallery.querySelectorAll('.tt-thumb-btn');
    buttons.forEach((btn, i) => {
      const isActive = i === currentIndex;
      const img = btn.querySelector('img');
      btn.setAttribute('aria-current', isActive ? 'true' : 'false');
      if (img) {
        img.classList.toggle('border-primary', isActive);
        img.classList.toggle('border-white', !isActive);
      }
    });
  }

  function refreshNavControls() {
    if (els.pageCount) {
      els.pageCount.textContent = `Image ${currentIndex + 1} out of ${frames.length}`;
    }
    els.prevBtn.disabled = currentIndex === 0;
    els.nextBtn.disabled = currentIndex === frames.length - 1;
  }

  function render(index) {
    if (!frames.length) return;

    currentIndex = Math.max(0, Math.min(index, frames.length - 1));
    const frame = frames[currentIndex];

    ensureFrameVisible(currentIndex + 1);

    refreshNavControls();

    if (els.spinner) els.spinner.hidden = false;

    ensureImageFallbackElements();
    clearSlowLoadTimer();
    hideSlowLoadAlert();
    hideImageFallback();
    hideThumbnailGallery();

    slowLoadTimeoutId = setTimeout(() => {
      showSlowLoadAlert(frame, false);
      showImageFallback(frame);
      if (els.spinner) els.spinner.hidden = true;
    }, SLOW_LOAD_TIMEOUT_MS);

    let mainImageRetried = false;

    els.image.onload = () => {
      clearSlowLoadTimer();
      hideSlowLoadAlert();
      hideImageFallback();
      showThumbnailGallery();
      if (els.spinner) els.spinner.hidden = true;
    };

    els.image.onerror = () => {
      if (!mainImageRetried) {
        mainImageRetried = true;
        setTimeout(() => {
          els.image.src = frame.url;
        }, RETRY_DELAY_MS);
        return;
      }
      clearSlowLoadTimer();
      if (els.spinner) els.spinner.hidden = true;
      showSlowLoadAlert(frame, true);
      showImageFallback(frame);
      setStatus(`This image failed to load (page ${frame.displayNumber}).`);
    };

    els.image.src = frame.url;
    els.image.alt = `Page ${frame.displayNumber}.`;
    els.image.dataset.bsCaption = `${sampleTitle} — Page ${frame.displayNumber}`;

    if (els.caption) {
      const captionParts = ['Page ' + frame.displayNumber];
      if (frame.occurrenceCount > 1) {
        captionParts.push('capture ' + frame.occurrenceIndex + ' of ' + frame.occurrenceCount);
      }
      if (frame.kind === 'record' && frame.subIndex) {
        captionParts.push('v' + frame.subIndex);
      }
      captionParts.push('image ' + (currentIndex + 1) + ' of ' + frames.length);
      els.caption.textContent = captionParts.join(' \u2014 ');
    }

    if (els.actualPageNumber) {
      els.actualPageNumber.textContent = frame.displayNumber;
    }

    els.gotoInput.value = currentIndex + 1;

    setStatus('Showing image ' + (currentIndex + 1) + ' of ' + frames.length + ', page ' + frame.displayNumber);

    updateActiveThumbnail();

    const params = new URLSearchParams(window.location.search);
    params.set('stream', streamId);
    params.set('page', String(currentIndex + 1));
    history.replaceState(null, '', '?' + params.toString());
  }

  function ensureFrameVisible(imageNumber) {
    if (imageNumber > visibleFrameCount && imageNumber <= frames.length) {
      const previousVisibleCount = visibleFrameCount;
      visibleFrameCount = Math.min(Math.ceil(imageNumber / IMAGES_PER_LOAD) * IMAGES_PER_LOAD, frames.length);
      appendThumbnailRange(previousVisibleCount, visibleFrameCount);
      updateLoadMoreButton();
      refreshNavControls();
    }
  }

  function goToSequence(imageNumber) {
    ensureFrameVisible(imageNumber);
    const index = imageNumber - 1;

    if (index < 0 || index >= frames.length) {
      if (els.gotoError) {
        els.gotoError.textContent = `No image numbered ${imageNumber}. Enter a number from 1 to ${frames.length}.`;
      }
      setStatus(`No image ${imageNumber}. Enter a number from 1 to ${frames.length}.`);
      return false;
    }

    if (els.gotoError) els.gotoError.textContent = '';
    render(index);
    return true;
  }

  function loadMoreImages() {
    if (visibleFrameCount >= frames.length) return;

    const previousVisibleCount = visibleFrameCount;
    visibleFrameCount = Math.min(visibleFrameCount + IMAGES_PER_LOAD, frames.length);

    appendThumbnailRange(previousVisibleCount, visibleFrameCount);

    showThumbnailGallery();
    updateActiveThumbnail();
    updateLoadMoreButton();
    refreshNavControls();

    setStatus(`Loaded ${visibleFrameCount} of ${frames.length} images.`);

    if (visibleFrameCount > previousVisibleCount) {
      const buttons = els.thumbnailGallery ? els.thumbnailGallery.querySelectorAll('.tt-thumb-btn') : null;
      if (buttons && buttons[previousVisibleCount]) {
        buttons[previousVisibleCount].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function showLoadError() {
    els.loading.hidden = true;
    els.loadError.hidden = false;
    els.gallery.setAttribute('aria-busy', 'false');
    if (els.loadMoreBtn) els.loadMoreBtn.classList.add('d-none');
  }

  async function init() {
    if (els.loadMoreBtn) els.loadMoreBtn.classList.add('d-none');

    const { stream, page } = getQueryParams();

    if (!stream) {
      showLoadError();
      els.loadError.textContent = 'No stream specified. This page expects a "stream" URL parameter.';
      return;
    }

    streamId = stream;
    const manifestUrl = MANIFEST_PATH_TEMPLATE.replace('{stream}', stream);

    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) throw new Error('Manifest request failed: ' + response.status);

      const manifest = await response.json();
      frames = buildFrameList(manifest.images || []);

      if (!frames.length) {
        showLoadError();
        els.loadError.textContent = 'This gallery has no images matching the expected filename pattern.';
        return;
      }

      visibleFrameCount = Math.min(IMAGES_PER_LOAD, frames.length);

      const service = manifest.service || '';
      const bannerService = service.replace(/\s+/g, '-');

      if (els.hiddenServiceName) els.hiddenServiceName.textContent = service;
      if (els.lightImageBanner) els.lightImageBanner.src = `../images/banners/light/${bannerService}_light.png`;
      if (els.darkImageBanner) els.darkImageBanner.src = `../images/banners/dark/${bannerService}.png`;

      const formattedDate = formatDate(manifest.date);
      sampleTitle = `${service} (${formattedDate})`;
      if (els.sampleTitle) els.sampleTitle.textContent = sampleTitle;
      document.title = sampleTitle;

      if (els.contributor) els.contributor.textContent = manifest.recovered_by || '';

      els.loading.hidden = true;
      els.gallery.setAttribute('aria-busy', 'false');

      renderThumbnails();
      updateLoadMoreButton();

      const requestedPage = page !== null ? parseInt(page, 10) : null;

      if (requestedPage !== null && !Number.isNaN(requestedPage)) {
        if (!goToSequence(requestedPage)) render(0);
      } else {
        render(0);
      }
    } catch (err) {
      console.error('Teletext gallery load error:', err);
      showLoadError();
    }
  }

  els.prevBtn.addEventListener('click', () => render(currentIndex - 1));
  els.nextBtn.addEventListener('click', () => render(currentIndex + 1));

  if (els.loadMoreBtn) {
    els.loadMoreBtn.addEventListener('click', loadMoreImages);
  }

  els.gotoForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = parseInt(els.gotoInput.value, 10);
    if (Number.isNaN(value)) {
      if (els.gotoError) els.gotoError.textContent = 'Enter a valid page number.';
      return;
    }
    goToSequence(value);
  });

  document.addEventListener('keydown', (event) => {
    if (document.activeElement === els.gotoInput) return;
    if (event.key === 'ArrowLeft' && !els.prevBtn.disabled) render(currentIndex - 1);
    if (event.key === 'ArrowRight' && !els.nextBtn.disabled) render(currentIndex + 1);
  });

  init();
})();