/*
* Admin dashboard (admin.html)
* Pending contributor names and submissions waiting for review.
* Every action is checked again by the Worker; this page only shows the controls.
*/
document.addEventListener("DOMContentLoaded", async () => {
    const { get, post, getMe, signOut, el } = window.NatAccount;

    const accountEl = document.getElementById("admin-account");
    const overviewEl = document.getElementById("admin-overview");
    const namesEl = document.getElementById("pending-names");
    const submissionsEl = document.getElementById("admin-submissions");
    const filterEl = document.getElementById("status-filter");
    const statusEl = document.getElementById("admin-status");

    // Same wording contributors see on My Samples
    const STATUS_LABELS = {
        received: { text: "Received, awaiting review", badge: "text-bg-secondary" },
        archived: { text: "Submitted", badge: "text-bg-success" },
        declined: { text: "Not added", badge: "text-bg-danger" },
        mixed: { text: "Mixed", badge: "text-bg-warning" }
    };

    // Buttons offered for each status (never the one it already has)
    const STATUS_ACTIONS = [
        { status: "archived", text: "Mark as added", className: "btn-success", confirm: null },
        { status: "declined", text: "Decline", className: "btn-outline-danger", confirm: "Mark this submission as not added? The contributor will see \"Not added\" on My Samples." },
        { status: "received", text: "Back to review", className: "btn-outline-secondary", confirm: null }
    ];

    function hasRealValue(value) {
        const text = String(value ?? "").trim().toLowerCase();
        return text !== "" && text !== "null" && text !== "n/a";
    }

    function show(value) {
        return hasRealValue(value) ? String(value) : "-";
    }

    // D1 stores "2026-10-19 17:40:00" in UTC; show it in the admin's own time zone
    function formatDateTime(value) {
        const date = new Date(String(value).replace(" ", "T") + "Z");
        return Number.isNaN(date.getTime()) ? show(value) : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    }

    // "Show A | Show B" -> one title per line, with a hidden comma so screen readers pause between them
    function programTitleCell(value) {
        const titles = String(value ?? "").split("|").map(title => title.trim()).filter(Boolean);
        if (titles.length < 2) return titles[0] ?? "-";

        return titles.map((title, index) => el("span", { className: "d-block" }, [
            title,
            index < titles.length - 1 ? el("span", { className: "visually-hidden", text: "," }) : null
        ]));
    }

    function statusBadge(status) {
        const label = STATUS_LABELS[status] ?? { text: status, badge: "text-bg-secondary" };
        return el("span", { className: `badge ${label.badge}`, text: label.text });
    }

    // Messages are announced by screen readers through the live region
    function announce(message, type = "success") {
        statusEl.className = message ? `alert alert-${type} text-center` : "";
        statusEl.textContent = message;
    }

    // Expired or too-old admin session: send them to sign in, then back here
    function handleAuthError(result) {
        if (result.status === 401 && result.reauth) {
            announce(result.error, "warning");
            setTimeout(() => { window.location.href = "login.html?next=admin.html"; }, 1500);
            return true;
        }
        return false;
    }

    function buildTable(caption, headers, rows) {
        return el("div", { className: "table-responsive" }, [
            el("table", { className: "table table-striped table-bordered table-primary align-middle text-center mb-0" }, [
                el("caption", { className: "visually-hidden", text: caption }),
                el("thead", {}, el("tr", {}, headers.map(header => el("th", { scope: "col", text: header })))),
                el("tbody", {}, rows.map(cells => el("tr", {}, cells.map(cell => el("td", {}, cell)))))
            ])
        ]);
    }

    // A button whose visible text is short but whose full meaning is read to screen readers
    function actionButton(text, spokenText, className, onClick) {
        const button = el("button", { type: "button", className: `btn btn-sm ${className}` }, [
            text,
            el("span", { className: "visually-hidden", text: ` ${spokenText}` })
        ]);
        button.addEventListener("click", () => onClick(button));
        return button;
    }

    // Copies the "Recovered By" credit so it can be pasted into the dataset table
    function copyButton(value) {
        const button = el("button", { type: "button", className: "btn btn-sm btn-outline-primary ms-2" }, [
            el("i", { className: "bi bi-clipboard", "aria-hidden": "true" }),
            el("span", { className: "visually-hidden", text: `Copy credit "${value}"` })
        ]);

        button.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(value);
                announce(`Copied "${value}".`, "info");
            } catch {
                announce(`Couldn't copy automatically. The credit is "${value}".`, "warning");
            }
        });

        return button;
    }


    /* OVERVIEW */

    async function loadOverview() {
        const result = await get("/api/admin/overview");
        if (!result.ok) return;

        overviewEl.replaceChildren(
            el("div", { className: "col-6" }, el("div", { className: "border rounded p-3 text-center h-100" }, [
                el("div", { className: "fs-2 fw-bold", text: String(result.awaitingReview) }),
                el("div", { text: result.awaitingReview === 1 ? "submission awaiting review" : "submissions awaiting review" })
            ])),
            el("div", { className: "col-6" }, el("div", { className: "border rounded p-3 text-center h-100" }, [
                el("div", { className: "fs-2 fw-bold", text: String(result.pendingNames) }),
                el("div", { text: result.pendingNames === 1 ? "name awaiting confirmation" : "names awaiting confirmation" })
            ]))
        );
    }


    /* PENDING NAMES */

    async function decideName(person, approve, button) {
        if (!approve && !window.confirm(`Reject "${person.name}" for ${person.email}? They'll be asked to choose a different name the next time they sign in.`)) return;

        button.disabled = true;
        const result = await post("/api/admin/names/decision", { email: person.email, approve });

        if (handleAuthError(result)) return;
        if (!result.ok) {
            button.disabled = false;
            announce(result.error || "There was an error. Please try again.", "danger");
            return;
        }

        announce(approve ? `Approved "${person.name}" for ${person.email}.` : `Rejected "${person.name}". ${person.email} will choose a new name.`);
        await Promise.all([loadNames(), loadOverview()]);
    }

    async function loadNames() {
        const result = await get("/api/admin/names");
        if (handleAuthError(result)) return;

        if (!result.ok) {
            namesEl.replaceChildren(el("p", { className: "text-danger", text: result.error || "Pending names couldn't be loaded." }));
            return;
        }

        if (!result.names.length) {
            namesEl.replaceChildren(el("p", { className: "text-muted", text: "No names are waiting for confirmation." }));
            return;
        }

        const rows = result.names.map(person => [
            person.email,
            el("strong", { text: person.name }),
            formatDateTime(person.createdAt),
            String(person.creditedRecords),
            el("div", { className: "d-flex flex-wrap gap-2" }, [
                actionButton("Approve", `${person.name} for ${person.email}`, "btn-success", button => decideName(person, true, button)),
                actionButton("Reject", `${person.name} for ${person.email}`, "btn-outline-danger", button => decideName(person, false, button))
            ])
        ]);

        namesEl.replaceChildren(
            el("p", { className: "text-muted" },
                "These names already exist. Approve one only if you're sure the account belongs to that contributor, since approving links their existing records to it."),
            buildTable("Names awaiting confirmation", ["Email", "Name", "Signed up", "Credited records", "Actions"], rows)
        );
    }


    /* SUBMISSIONS */

    async function setStatus(submission, action, button) {
        if (action.confirm && !window.confirm(action.confirm)) return;

        button.disabled = true;
        const result = await post("/api/admin/submissions/status", { ref: submission.ref, status: action.status });

        if (handleAuthError(result)) return;
        if (!result.ok) {
            button.disabled = false;
            announce(result.error || "There was an error. Please try again.", "danger");
            return;
        }

        const sampleText = result.samplesUpdated === 1 ? "1 sample" : `${result.samplesUpdated} samples`;
        announce(`${submission.ref} is now "${STATUS_LABELS[action.status].text}" (${sampleText}).`);
        await Promise.all([loadSubmissions(), loadOverview()]);
    }

    function submissionCard(submission) {
        const headingID = `submission-${submission.ref}`;
        const sampleCount = submission.samples.length === 1 ? "1 sample" : `${submission.samples.length} samples`;

        const rows = submission.samples.map(sample => [
            [sample.network, sample.service].filter(hasRealValue).join(" - ") || "-",
            show(sample.date),
            programTitleCell(sample.programTitle),
            [sample.tapeType, sample.tapeSpeed].filter(hasRealValue).join(" ") || "-",
            show(sample.fileName)
        ]);

        const actions = STATUS_ACTIONS
            .filter(action => action.status !== submission.status)
            .map(action => actionButton(action.text, submission.ref, action.className, button => setStatus(submission, action, button)));

        return el("section", { className: "card mb-3", "aria-labelledby": headingID }, [
            el("div", { className: "card-header d-flex flex-wrap justify-content-between align-items-center gap-2" }, [
                el("h3", { id: headingID, className: "h6 mb-0" }, [
                    el("code", { text: submission.ref }),
                    el("span", { className: "text-muted fw-normal", text: ` · ${formatDateTime(submission.submittedAt)} · ${sampleCount}` })
                ]),
                statusBadge(submission.status)
            ]),
            el("div", { className: "card-body" }, [
                el("p", { className: "mb-1" }, [
                    el("strong", { text: "From: " }),
                    `${show(submission.contributorName)} (${submission.email})`
                ]),
                el("p", { className: "mb-3" }, [
                    el("strong", { text: "Credit as (Recovered By): " }),
                    show(submission.creditAs),
                    hasRealValue(submission.creditAs) ? copyButton(submission.creditAs) : null
                ]),
                buildTable(`Samples in ${submission.ref}`, ["Network / Service", "Date", "Program", "Tape", "File"], rows),
                el("div", { className: "d-flex flex-wrap gap-2 mt-3" }, actions)
            ])
        ]);
    }

    async function loadSubmissions() {
        const status = filterEl.value;
        submissionsEl.setAttribute("aria-busy", "true");

        const result = await get(`/api/admin/submissions?status=${encodeURIComponent(status)}`);
        submissionsEl.removeAttribute("aria-busy");

        if (handleAuthError(result)) return;

        if (!result.ok) {
            submissionsEl.replaceChildren(el("p", { className: "text-danger", text: result.error || "Submissions couldn't be loaded." }));
            return;
        }

        if (!result.submissions.length) {
            const emptyText = {
                received: "Nothing is waiting for review.",
                archived: "No submissions have been marked as added yet.",
                declined: "No submissions have been declined.",
                all: "No one has submitted while signed in yet."
            }[status];

            submissionsEl.replaceChildren(el("p", { className: "text-muted", text: emptyText }));
            return;
        }

        submissionsEl.replaceChildren(...result.submissions.map(submissionCard));
    }


    /* START */

    const me = await getMe();

    if (!me.loggedIn) {
        window.location.href = "login.html?next=admin.html";
        return;
    }

    if (!me.isAdmin) {
        document.getElementById("admin-content").replaceChildren(
            el("div", { className: "alert alert-warning text-center", role: "alert" }, [
                "This page is only for admins. ",
                el("a", { href: "my-submissions.html" }, "Go to My Submissions")
            ])
        );
        return;
    }

    const signOutBtn = el("button", { type: "button", className: "btn btn-outline-secondary btn-sm ms-2" }, "Sign out");
    signOutBtn.addEventListener("click", async () => {
        await signOut();
        window.location.href = "login.html";
    });

    accountEl.replaceChildren(el("p", { className: "mb-0" }, [
        "Signed in as ",
        el("strong", { text: me.name ?? me.email }),
        " (admin). ",
        el("a", { href: "my-submissions.html" }, "My Submissions"),
        signOutBtn
    ]));

    filterEl.addEventListener("change", loadSubmissions);

    await Promise.all([loadOverview(), loadNames(), loadSubmissions()]);
});