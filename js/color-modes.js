(() => {
  "use strict";

  const getStoredTheme = () => localStorage.getItem("theme");
  const setStoredTheme = (theme) => localStorage.setItem("theme", theme);

  const getPreferredTheme = () => {
    const storedTheme = getStoredTheme();
    if (storedTheme) return storedTheme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  };

  const setTheme = (theme) => {
    if (theme === "auto") {
      document.documentElement.setAttribute(
        "data-bs-theme",
        window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
      );
    } else {
      document.documentElement.setAttribute("data-bs-theme", theme);
    }
  };

  setTheme(getPreferredTheme()); // apply immediately, avoids flash on load

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const storedTheme = getStoredTheme();
      if (storedTheme !== "light" && storedTheme !== "dark") {
        setTheme(getPreferredTheme());
      }
    });

  const updateFabIcon = (theme) => {
    const icon = document.querySelector("#themeFab .theme-icon");
    if (icon)
      icon.innerHTML =
        theme === "auto"
          ? '<i class="bi bi-display-fill"></i>'
          : theme === "dark"
            ? '<i class="bi bi-moon-fill"></i>'
            : '<i class="bi bi-brightness-high-fill"></i>';
  };

  const markActiveChoice = (theme) => {
    document.querySelectorAll(".theme-choice").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.theme === theme);
    });
  };

  window.addEventListener("DOMContentLoaded", () => {
    const current = getPreferredTheme();
    updateFabIcon(current);
    markActiveChoice(current);

    const offcanvasEl = document.getElementById("themeOffcanvas");
    const offcanvas = bootstrap.Offcanvas.getOrCreateInstance(offcanvasEl);

    // Content lives in the DOM the whole time, so this only needs to run once
    document.querySelectorAll(".theme-choice").forEach((btn) => {
      btn.addEventListener("click", () => {
        const theme = btn.dataset.theme;
        setStoredTheme(theme);
        setTheme(theme);
        updateFabIcon(theme);
        markActiveChoice(theme);
        offcanvas.hide();
      });
    });
  });
})();
