window.LetterReveal = (function () {
    const STEPS_MS = 55;
    const START_DELAY_MS = 500;

    function type(el, text) {
        const content = (text !== undefined ? text: el.textContent).trim();
        if (!content) return;

        el.setAttribute("aria-label", content);
        el.innerHTML = "";

        const reduceMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
        ).matches;

        if (reduceMotion) {
            el.textContent = content;
            return;
        }

        const letters = [];
        let wordWrap = null;

        content.split("").forEach((char) => {
            const span = document.createElement("span");
            span.className = "letter-reveal-char";
            span.setAttribute("aria-hidden", "true");

            if (char === " ") {
                span.classList.add("is-space");
                span.innerHTML = " ";
                el.appendChild(span);
                wordWrap = null;
            } else {
                if (!wordWrap) {
                    wordWrap = document.createElement("span");
                    wordWrap.className = "reveal-word";
                    el.appendChild(wordWrap);
                }
                span.textContent = char;
                wordWrap.appendChild(span);
            }
            letters.push(span);
        });

        const cursor = document.createElement("span");
        cursor.className = "type-cursor";
        cursor.setAttribute("aria-hidden", "true");
        letters[0].parentNode.insertBefore(cursor, letters[0]);

        letters.forEach((span, i) => {
            setTimeout(() => {
                span.classList.add("is-visible");
                span.after(cursor);
            }, START_DELAY_MS + i * STEPS_MS);
        });
    }

    function init(root) {
        (root || document)
        .querySelectorAll(".data-letter-reveal")
        .forEach((el) => type(el));
    }

    document.addEventListener("DOMContentLoaded", () => init());

    return { type, init };
})();