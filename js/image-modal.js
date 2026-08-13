// ~ Bootstrap image modal.

let modal = new bootstrap.Modal(document.getElementById("imageModal"));

document.addEventListener("click", (event) => {
  const item = event.target.closest(
    ".figure-img, .teletext-preview",
  );
  if (!item) return;

  const src = item.getAttribute("src");
  const caption = item.getAttribute("data-bs-caption") || "Default caption.";

  document.getElementById("modalImage").src = src;
  document.getElementById("modalCaption").innerText = caption;

  modal.show();
});
