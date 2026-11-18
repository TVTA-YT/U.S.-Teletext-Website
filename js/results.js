(function () {
    const resultsEl = document.getElementById("results");

    function showError(message) {
        console.error("[results] " + message);
        if (resultsEl) {
            resultsEl.innerHTML =
                '<div class="alert alert-primary text-center" role="alert">' +
                '<i class="bi bi-exclamation-triangle-fill"></i> <strong>' + message + "</strong> " +
                'Choose a service from the <a href="services.html">Teletext Services</a> page.</div>';
        }
    }

    // If config is undefined
    if (typeof RESULTS_CONFIG === "undefined") {
        showError("Service settings didn't load (results-configs.js is missing).");
        return;
    }

    // If the function doesn't load
    if (typeof renderResults !== "function") {
        showError("The results renderer didn't load ('render-results.js' is missing).");
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const key = (params.get("service") || "").trim().toLowerCase();
    const config = Object.prototype.hasOwnProperty.call(RESULTS_CONFIG, key) ? RESULTS_CONFIG[key] : null;

    if (!config) {
        showError(key ? 'Unknown service "' + key + '".' : "No service was selected.");
        return;
    }

    // Title, heading and description
    document.title = config.pageTitle;
    const heading = document.querySelector(".page-title .visually-hidden");
    if (heading) heading.textContent = config.pageTitle;
    const metaDescription = document.querySelector('meta[name="description"]');
    if (metaDescription) metaDescription.setAttribute("content", config.description);

    // Banners
    const lightBanner = document.querySelector(".page-title .light-mode-image");
    const darkBanner = document.querySelector(".page-title .dark-mode-image");
    if (lightBanner) lightBanner.src = config.banner.light;
    if (darkBanner) darkBanner.src = config.banner.dark;

    // "Return to Form" goes back to that service's form
    const returnLink = document.querySelector("#return-to-form-button a");
    if (returnLink) returnLink.href = config.formPage || key + ".html";

    renderResults(config.render);
})();