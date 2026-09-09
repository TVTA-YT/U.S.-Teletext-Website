document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('gallery-container');
    const modalEl = document.getElementById('imageModal');
    const modalImg = document.getElementById('imageModalImg');
    const modalCaption = document.getElementById('imageModalCaption');
    const modalContributor = document.getElementById('imageModalContributor');

    const REQUEST_DELAY_MS = 500;

    const MONTH_NAMES = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
    ]

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

    function parseCaptionDate(caption) {
        const date = new Date(caption);
        return isNaN(date) ? null : date;
    }

    function buildAllText(item) {
        let text = item.caption || `Trivia page from ${item.year}`;
        if (item.contributor) {
            text += `\n(contributed by: ${item.contributor})`;
        }
        return text;
    }

    function renderGallery(items) {
        if (!Array.isArray(items) || items.length === 0) {
            container.innerHTML = '<p>No images available.</p>';
            return;
        }

        const byYear = items.reduce((acc, item) => {
            const year = item.year;
            if (!acc[year]) acc[year] = [];
            acc[year].push(item);
            return acc;
        }, {});

        Object.values(byYear).forEach(yearItems => {
            yearItems.sort((a, b) => {
                const dateA = parseCaptionDate(a.caption);
                const dateB = parseCaptionDate(b.caption);

                if (!dateA && !dateB) return 0;
                if (!dateA) return 1;
                if (!dateB) return -1;

                return dateA - dateB;
            });
        });

        const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);

        const fragment = document.createDocumentFragment();
        const pendingImages = [];

        years.forEach(year => {
            const heading = document.createElement('h2');
            heading.className = "mt-5 mb-3";
            heading.textContent = year;
            fragment.appendChild(heading);

            const row = document.createElement('div');
            row.className = 'row';

            byYear[year].forEach(item => {
                const col = document.createElement('div');
                col.className = 'col-3';

                const img = document.createElement('img');
                img.dataset.src = item.imageURL;
                img.dataset.year = item.year;
                img.dataset.caption = item.caption || '';
                img.dataset.contributor = item.contributor || '';
                img.alt = buildAllText(item);
                img.className = 'figure-img mw-100 border border-white rounded';
                img.setAttribute('data-bs-toggle', 'modal');
                img.setAttribute('data-bs-target', '#imageModal');

                col.appendChild(img);

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

    function queueImageLoads(images) {
        const queue = [];
        let releasing = false;

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

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    observer.unobserve(img);
                    queue.push(img);
                    if (!releasing) releaseNextImage();
                }
            });
        }, { rootMargin: '300px 0' });

        images.forEach(img => observer.observe(img));
    }

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