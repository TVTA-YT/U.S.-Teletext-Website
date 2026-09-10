document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('gallery-container');
    const modalEl = document.getElementById('imageModal');
    const modalImg = document.getElementById('imageModalImg');
    const modalCaption = document.getElementById('imageModalCaption');
    const modalContributor = document.getElementById('imageModalContributor');

    // Delay requests by 500 ms
    const REQUEST_DELAY_MS = 500;

    fetch('../json/electra-trivia.json')
        .then(res => {
            if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
            return res.json();
        })
        .then(renderGallery)
        .catch(err => {
            console.error('Failed to load gallery data:', err);
            container.innerHTML = '<p class="text-center text-danger">Unable to load images. There may be an issue somewhere.</p>';
        });

    // Turn the caption value in the JSON into a JS Date
    function parseCaptionDate(caption) {
        const date = new Date(caption);
        return isNaN(date) ? null : date;
    }

    // Create image alt text
    function buildAltText(item) {
        let text = item.caption || `Trivia page from ${item.year}`;
        if (item.contributor) {
            text += `\n(contributed by: ${item.contributor})`;
        }
        return text;
    }

    // ! Create image gallery
    function renderGallery(items) {
        if (!Array.isArray(items) || items.length === 0) {
            container.innerHTML = '<p>No images available.</p>';
            return;
        }

        // Group images by year
        const byYear = items.reduce((acc, item) => {
            const year = item.year;
            if (!acc[year]) acc[year] = [];
            acc[year].push(item);
            return acc;
        }, {});

        // Sort the images
        Object.values(byYear).forEach(yearItems => {
            yearItems.sort((a, b) => {
                // Sort based on date
                const dateA = parseCaptionDate(a.caption);
                const dateB = parseCaptionDate(b.caption);

                if (!dateA && !dateB) return 0;
                if (!dateA) return 1;
                if (!dateB) return -1;

                return dateA - dateB;
            });
        });

        // Sort the years chronologically
        const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);

        // Build everything in a temporary fragment to prevent consistent modifying of the webpage
        const fragment = document.createDocumentFragment();
        const pendingImages = [];

        // Create each section
        years.forEach(year => {
            const heading = document.createElement('h2');
            heading.className = "mt-5 mb-3";
            heading.textContent = year;
            fragment.appendChild(heading);

            const row = document.createElement('div');
            row.className = 'row';

            // Create each image column
            byYear[year].forEach(item => {
                const col = document.createElement('div');
                col.className = 'col-3';

                // Creating the image and its metadata
                const img = document.createElement('img');
                img.dataset.src = item.imageURL;
                img.dataset.year = item.year;
                img.dataset.caption = item.caption || '';
                img.dataset.contributor = item.contributor || '';
                img.alt = buildAltText(item);
                img.className = 'figure-img mw-100 border border-white rounded';
                img.setAttribute('data-bs-toggle', 'modal');
                img.setAttribute('data-bs-target', '#imageModal');

                col.appendChild(img);

                // Add date cation underneath each image
                const yearLabel = document.createElement('p');
                yearLabel.className = 'text-center';
                yearLabel.textContent = item.caption;
                col.appendChild(yearLabel);

                row.appendChild(col);
                pendingImages.push(img);
            });

            fragment.appendChild(row);

            const divider = document.createElement('hr');
            fragment.appendChild(divider);
        });

        container.appendChild(fragment);
        queueImageLoads(pendingImages);
    }

    // Only load images when they are close to the user's viewport. Do not start all downloads simultaneously
    function queueImageLoads(images) {
        const queue = [];
        let releasing = false;

        // Take the next image out of the queue and load it
        function releaseNextImage() {
            if (queue.length === 0) {
                releasing = false;
                return;
            }
            releasing = true;
            const img = queue.shift();
            loadImage(img);
            setTimeout(releaseNextImage, REQUEST_DELAY_MS);
        }

        // Start loading the image
        function loadImage(img) {
            const src = img.dataset.src;
            if (!src) return;
            img.src = src;
            img.addEventListener('load', () => img.classList.remove('loading'), { once: true });
            img.addEventListener('error', () => {
                img.classList.remove('loading');
                img.classList.add('load-error');
            }, { once: true });
        }

        // Watch all images on the page
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {

                // If the image has entered the viewport, get the image, stop observing it, and put it in the queue
                if (entry.isIntersecting) {
                    const img = entry.target;
                    observer.unobserve(img);
                    queue.push(img);

                    // If the image has been queued and it isn't currently running, start the queue
                    if (!releasing) releaseNextImage();
                }
            });

            // An image will start loading if it's within 300px of the viewport
        }, { rootMargin: '300px 0px' });

        images.forEach(img => observer.observe(img));
    }

    // Bootstrap modal
    modalEl.addEventListener('show.bs.modal', (event) => {
        const trigger = event.relatedTarget;
        if (!trigger) return;

        modalImg.src = trigger.dataset.src || trigger.src;
        modalImg.alt = trigger.alt;
        modalCaption.textContent = trigger.dataset.caption;

        if (trigger.dataset.contributor) {
            modalContributor.textContent = `Contributed by ${trigger.dataset.contributor}`;
            modalContributor.classList.remove('d-none');
        } else {
            modalContributor.textContent = '';
            modalContributor.classList.add('d-none');
        }
    });
});