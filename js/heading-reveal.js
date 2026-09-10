
window.LetterReveal = (function () {
    // Each letter appears after 55ms. Start the animation after half a second
    const STEPS_MS = 55;
    const START_DELAY_MS = 500;

    // ! Main animation function
    function type(el, text) {
        // If "text" is not undefined, use that. Otherwise, use whatever is in the H1
        const content = (text !== undefined ? text : el.textContent).trim();
        // Do not animate empty text
        if (!content) return;

        // For screen readers, read the full value before the animation (if needed)
        el.setAttribute("aria-label", content);
        el.innerHTML = "";

        // Check the user's motion preference. Do not animate the heading if the user prefers reduced motion
        const reduceMotion = window.matchMedia(
            "(prefers-reduced-motion: reduce)"
        ).matches;

        if (reduceMotion) {
            el.textContent = content;
            return;
        }

        const letters = [];
        let wordWrap = null;

        // Split the text into individual characters
        content.split("").forEach((char) => {
            // Assign a "span" element and the "letter-reveal-char" class for each character. Hide for screen readers
            const span = document.createElement("span");
            span.className = "letter-reveal-char";
            span.setAttribute("aria-hidden", "true");

            // Put spaces in their own "span" elements
            if (char === " ") {
                span.classList.add("is-space");
                span.innerHTML = " ";
                el.appendChild(span);
                wordWrap = null;
            } else {
                // Create a wrapper for each word
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

        // Create the animated cursor
        const cursor = document.createElement("span");
        cursor.className = "type-cursor";
        cursor.setAttribute("aria-hidden", "true");
        // Put the crusoe at the beginning of the heading
        letters[0].parentNode.insertBefore(cursor, letters[0]);

        // Schedule each letter to appear
        letters.forEach((span, i) => {
            setTimeout(() => {

                // CSS class that triggers visibility of each letter
                span.classList.add("is-visible");

                // Move the cursor after each character
                span.after(cursor);
            }, START_DELAY_MS + i * STEPS_MS);
        });
    }

    // Find all H1 elements with the "data-letter-reveal" class and apply the animation to those elements
    function init(root) {
        (root || document)
            .querySelectorAll(".data-letter-reveal")
            .forEach((el) => type(el));
    }

    document.addEventListener("DOMContentLoaded", () => init());

    return { type, init };
})();