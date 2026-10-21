document.addEventListener("DOMContentLoaded", async () => {
    const { post, getMe, safeNextPage } = window.NatAccount;

    const steps = {
        email: document.getElementById("email-step"),
        confirm: document.getElementById("confirm-step"),
        sent: document.getElementById("sent-step"),
        name: document.getElementById("name-step"),
        pending: document.getElementById("pending-step")
    };

    const statusEl = document.getElementById("login-status");
    const emailForm = document.getElementById("email-form");
    const emailInput = document.getElementById("email");
    const nameForm = document.getElementById("name-form");
    const nameInput = document.getElementById("contributor-name");
    const sentEmailEl = document.getElementById("sent-email");
    const resentBtn = document.getElementById("resend-btn");

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    const requestedNext = safeNextPage(params.get("next"));

    function showStep(name) {
        Object.entries(steps).forEach(([key, section]) => { section.hidden = key !== name });
        const heading = steps[name].querySelector("h2");
        if (heading) heading.focus();
    }

    function showStatus(message, type = "info") {
        statusEl.className = message ? `alert alert-${type} mt-3` : "";
        statusEl.textContent = message;
    }

    function setBusy(form, busy) {
        form.querySelectorAll("button, input").forEach(control => { control.disabled = busy });
    }

    function finish(me) {
        window.location.href = requestedNext ?? (me?.isAdmin ? "admin.html" : "my-submissions.html");
    }

    function route(me) {
        if (!me.loggedIn) return showStep("email");
        if (me.nameStatus === "none") return showStep("name");

        if (me.nameStatus === "pending") {
            document.getElementById("pending-name").textContent = me.name;
            return showStep("pending");
        }

        finish(me);
    }

    async function requestLink(email) {
        showStatus("");
        const result = await post("/api/auth/request-link", { email, next: requestedNext });

        if (!result.ok) {
            showStatus(result.error || "Something went wrong. Please try again.", "danger");
            return false;
        }

        sentEmailEl.textContent = email;
        showStep("sent");
        return true;
    }

    emailForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!emailInput.reportValidity()) return;
        setBusy(emailForm, true);
        await requestLink(emailInput.value.trim());
        setBusy(emailForm, false);
    });

    resentBtn.addEventListener("click", async () => {
        resentBtn.disabled = true;
        const sent = await requestLink(sentEmailEl.textContent);
        if (sent) showStatus("A new login link has been sent. Use only the newest link if more than 1 is received.", "success");
        resentBtn.disabled = false;
    });

    document.getElementById("different-email-btn").addEventListener("click", () => {
        showStatus("");
        showStep("email");
        emailInput.focus();
    });

    nameForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!nameInput.reportValidity()) return;
        setBusy(nameForm, true);
        showStatus("");
        const result = await post("/api/auth/name", {
            name: nameInput.value.trim(),
            anonymous: document.getElementById("anonymous-credit").checked
        });
        setBusy(nameForm, false);

        if (!result.ok) {
            showStatus(result.error || "Something went wrong. Please try again.", "danger");
            return;
        }

        route({
            loggedIn: true,
            name: result.name,
            nameStatus: result.nameStatus
        });
    });

    document.querySelectorAll(".sign-out-btn").forEach(button => {
        button.addEventListener("click", async () => {
            await window.NatAccount.signOut();
            showStatus("You've been signed out.", "info");
            showStep("email");
        });
    });

    // Arriving from an email link: wait for a click before using the one-time code.
    // Email security scanners open links (some even run the page's scripts) but don't click buttons,
    // so they can no longer use the link up before the person does
    if (token) {
        window.history.replaceState(null, "", window.location.pathname + (requestedNext ? `?next=${requestedNext}` : ""));

        // Already signed in here (e.g. the link was opened twice in this browser): no need to use it again
        const current = await getMe();
        if (current.loggedIn) {
            route(current);
            return;
        }

        const confirmBtn = document.getElementById("confirm-sign-in-btn");
        showStep("confirm");

        confirmBtn.addEventListener("click", async () => {
            confirmBtn.disabled = true;
            showStatus("Signing you in...", "info");

            const result = await post("/api/auth/verify", { token });

            if (!result.ok) {
                // A link used a moment ago in this same browser still counts as signed in
                const me = await getMe();
                if (me.loggedIn) {
                    showStatus("");
                    route(me);
                    return;
                }

                showStatus((result.error || "This sign-in link didn't work.") +
                    " If you opened the link in another app or browser first, sign in from there, or enter your email below for a new link.", "danger");
                showStep("email");
                return;
            }

            showStatus("");
            route(await getMe());
        });

        return;
    }

    route(await getMe());
});