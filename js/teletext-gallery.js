(function () {
  'use strict';

  const MANIFEST_PATH_TEMPLATE = '../json/teletext-image-data/gallery-{stream}.json';
  const RECORD_PATTERN = /^Record-(\d+)-(\d+)-v([A-Za-z0-9]+)$/i;
  const PAGE_PATTERN = /^Page-(\d+)-(\d+)$/i;

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
    gallery: document.getElementById('teletext-image-gallery')
  };

  let frames = [];
  let currentIndex = 0;
  let streamId = null;
  let sampleTitle = '';

  function getQueryParams() {
    const params = new URLSearchParams(window.location.search);

    return {
      stream: params.get('stream'),
      page: params.get('page')
    };
  }

  //Convert YYYY-MM-DD to Mon. DD, YYYY.
  function formatDate(dateString) {
    if (!dateString) return '';

    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString));

    if (!match) {
      return String(dateString);
    }

    const [, year, month, day] = match;

    const months = [
      'Jan.',
      'Feb.',
      'Mar.',
      'Apr.',
      'May',
      'June',
      'July',
      'Aug.',
      'Sept.',
      'Oct.',
      'Nov.',
      'Dec.'
    ];

    const monthIndex = Number(month) - 1;

    if (monthIndex < 0 || monthIndex > 11) {
      return String(dateString);
    }

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

  // Sort by the number encoded in the filename,
  // then by version/subpage number.
  frames.sort((a, b) => {
    return a.pageNumber - b.pageNumber || a.subIndex - b.subIndex;
  });

  // Record where each occurrence falls within a repeated
  // display-number group.
  let i = 0;

  while (i < frames.length) {
    let j = i;

    while (
      j < frames.length &&
      frames[j].displayNumber === frames[i].displayNumber
    ) {
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

  function setStatus(message) {
    if (els.status) {
      els.status.textContent = message;
    }
  }

  function render(index) {
  if (!frames.length) return;

  currentIndex = Math.max(0, Math.min(index, frames.length - 1));
  const frame = frames[currentIndex];

  if (els.pageCount) {
    els.pageCount.textContent =
      `Image ${currentIndex + 1} out of ${frames.length}`;
  }

  if (els.spinner) els.spinner.hidden = false;

  els.image.onload = () => {
    if (els.spinner) els.spinner.hidden = true;
  };

  els.image.onerror = () => {
    if (els.spinner) els.spinner.hidden = true;

    setStatus(
      'This image failed to load (page ' + frame.displayNumber + ').'
    );
  };

  els.image.src = frame.url;
  els.image.alt = 'Decoded teletext frame, page ' + frame.displayNumber;
  els.image.dataset.bsCaption = `${sampleTitle} — Page ${frame.displayNumber}`;

  if (els.caption) {
    const captionParts = [
      'Page ' + frame.displayNumber
    ];

    if (frame.occurrenceCount > 1) {
      captionParts.push(
        'capture ' +
        frame.occurrenceIndex +
        ' of ' +
        frame.occurrenceCount
      );
    }

    if (frame.kind === 'record' && frame.subIndex) {
      captionParts.push('v' + frame.subIndex);
    }

    captionParts.push(
      'image ' + (currentIndex + 1) + ' of ' + frames.length
    );

    els.caption.textContent =
      captionParts.join(' \u2014 ');
  }

  if (els.actualPageNumber) {
      els.actualPageNumber.textContent = frame.displayNumber;
  }

  els.prevBtn.disabled = currentIndex === 0;
  els.nextBtn.disabled = currentIndex === frames.length - 1;

  // The form represents the image's position, not the
  // displayNumber encoded in the filename.
  els.gotoInput.value = currentIndex + 1;

  setStatus(
    'Showing image ' +
    (currentIndex + 1) +
    ' of ' +
    frames.length +
    ', page ' +
    frame.displayNumber
  );

  const params = new URLSearchParams(window.location.search);
  params.set('stream', streamId);
  params.set('page', String(currentIndex + 1));

  history.replaceState(
    null,
    '',
    '?' + params.toString()
  );
}


  function goToSequence(imageNumber) {
  const index = imageNumber - 1;

  if (index < 0 || index >= frames.length) {
    if (els.gotoError) {
      els.gotoError.textContent =
        `No image numbered ${imageNumber}. Enter a number from 1 to ${frames.length}.`;
    }

    setStatus(
      `No image ${imageNumber}. Enter a number from 1 to ${frames.length}.`
    );

    return false;
  }

  if (els.gotoError) {
    els.gotoError.textContent = '';
  }

  render(index);
  return true;
}


  function showLoadError() {
    els.loading.hidden = true;
    els.loadError.hidden = false;
    els.gallery.setAttribute(
      'aria-busy',
      'false'
    );
  }

  async function init() {
    const { stream, page } = getQueryParams();

    if (!stream) {
      showLoadError();

      els.loadError.textContent =
        'No stream specified. This page expects a "stream" URL parameter.';

      return;
    }

    streamId = stream;

    const manifestUrl =
      MANIFEST_PATH_TEMPLATE.replace(
        '{stream}',
        stream
      );

    try {
      const response = await fetch(manifestUrl);

      if (!response.ok) {
        throw new Error(
          'Manifest request failed: ' +
          response.status
        );
      }

      const manifest = await response.json();

      frames = buildFrameList(
        manifest.images || []
      );

      if (!frames.length) {
        showLoadError();

        els.loadError.textContent =
          'This gallery has no images matching the expected filename pattern.';

        return;
      }

      // Set the service name and banner images.
      const service = manifest.service || '';

      // Converts "NBC Teletext" -> "NBC-Teletext"
      const bannerService =
        service.replace(/\s+/g, '-');

      if (els.hiddenServiceName) {
        els.hiddenServiceName.textContent =
          service;
      }

      if (els.lightImageBanner) {
        els.lightImageBanner.src =
          `../images/banners/light/${bannerService}_light.png`;
      }

      if (els.darkImageBanner) {
        els.darkImageBanner.src =
          `../images/banners/dark/${bannerService}.png`;
      }

      // Format the date for display.
      const formattedDate =
        formatDate(manifest.date);

      sampleTitle = `${service} (${formattedDate})`;

      if (els.sampleTitle) {
        els.sampleTitle.textContent =
          sampleTitle;
      }

      // Update the browser tab title.
      document.title = sampleTitle;

      if (els.contributor) {
        els.contributor.textContent =
          manifest.recovered_by || '';
      }

      els.loading.hidden = true;

      els.gallery.setAttribute(
        'aria-busy',
        'false'
      );

      const requestedPage =
        page !== null
          ? parseInt(page, 10)
          : null;

      if (
        requestedPage !== null &&
        !Number.isNaN(requestedPage)
      ) {
        if (!goToSequence(requestedPage)) {
          render(0);
        }
      } else {
        render(0);
      }

    } catch (err) {
      console.error(
        'Teletext gallery load error:',
        err
      );

      showLoadError();
    }
  }

  els.prevBtn.addEventListener(
    'click',
    () => render(currentIndex - 1)
  );

  els.nextBtn.addEventListener(
    'click',
    () => render(currentIndex + 1)
  );

  els.gotoForm.addEventListener(
    'submit',
    (event) => {
      event.preventDefault();

      const value = parseInt(
        els.gotoInput.value,
        10
      );

      if (Number.isNaN(value)) {
        if (els.gotoError) {
          els.gotoError.textContent =
            'Enter a valid page number.';
        }

        return;
      }

      goToSequence(value);
    }
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (
        document.activeElement ===
        els.gotoInput
      ) {
        return;
      }

      if (
        event.key === 'ArrowLeft' &&
        !els.prevBtn.disabled
      ) {
        render(currentIndex - 1);
      }

      if (
        event.key === 'ArrowRight' &&
        !els.nextBtn.disabled
      ) {
        render(currentIndex + 1);
      }
    }
  );

  init();
})();
