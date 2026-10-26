document.addEventListener("DOMContentLoaded", async () => {
    const { get, signOut, el } = window.NatAccount;

    const accountEl = document.getElementById("account-summary");
    const submissionsEl = document.getElementById("submissions-list");
    const archiveEl = document.getElementById("archive-list");
    const archiveCountEl = document.getElementById("archive-count");

    const DATASET_LABELS = {
        abcPlus: "ABC PLUS",
        acquire: "Acquire",
        datavizion: "DaTaVizion",
        edutel: "Edutel",
        electra: "Electra",
        extravision: "ExtraVision",
        iptvAgids: "Iowa Public Television AGIDS",
        kcet: "KCET",
        ketAgtext: "KET AgText",
        keyfax: "Keyfax",
        nbcTeletext: "NBC Teletext",
        penntext: "PENNTEXT",
        sssTeletext: "SSS Teletext",
        starsight: "StarSight",
        virtext: "Virtext",
        wisconsinInfotextText: "Wisconsin Infotext (Text)",
        wisconsinInfotextTeletext: "Wisconsin Infotext (Teletext)"
    };

    // Banner image base names in images/banners/light/<name>_light.png and images/banners/dark/<name>.png
    // Services not listed here keep a plain text heading
    const DATASET_BANNERS = {
        abcPlus: "ABC-PLUS",
        datavizion: "DaTaVizion",
        edutel: "Edutel",
        electra: "Electra",
        extravision: "CBS-ExtraVision",
        iptvAgids: "IPTV-AGIDS",
        kcet: "KCET",
        ketAgtext: "KET",
        keyfax: "Keyfax",
        nbcTeletext: "NBC-Teletext",
        penntext: "PENNTEXT",
        sssTeletext: "SSS-Teletext",
        starsight: "StarSight",
        virtext: "Virtext",
        wisconsinInfotextText: "WISINFOTEXT",
        wisconsinInfotextTeletext: "WISINFOTEXT"
    };

    const STAUTS_LABELS = {
        received: {
            text: "Received, awaiting review",
            badge: "text-bg-secondary"
        },
        archived: {
            text: "Submitted",
            badge: "text-bg-success"
        },
        declined: {
            text: "Not added",
            badge: "text-bg-danger"
        }
    };

    function hasRealValue(value) {
        const text = String(value ?? "").trim().toLowerCase();
        return text !== "" && text !== "null" && text !== "n/a";
    }

    function formatSubmittedAt(value) {
        const date = new Date(String(value).replace(" ", "T") + "Z");
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US", { dateStyle: "medium" });
    }

    // "Show A | Show B (partial)" -> each title on its own line.
    // A hidden comma between titles makes screen readers pause instead of running them together
    function programTitleCell(value) {
        if (!hasRealValue(value)) return "-";

        const titles = String(value).split("|").map(title => title.trim()).filter(Boolean);
        if (titles.length < 2) return titles[0] ?? "-";

        return titles.map((title, index) => el("span", { className: "d-block my-submissions-multiple-titles" }, [
            title,
            index < titles.length - 1 ? el("span", { className: "visually-hidden", text: "," }) : null
        ]));
    }

    /* SAMPLE LINKS */

    // Spoken description of a record for link text, e.g. "Braves vs. Cubs, 1984-05-01"
    function recordDescription(row) {
        const title = String(row.Program_Title ?? "").split("|").map(t => t.trim()).filter(Boolean).join(", ");
        const date = row.Date ?? row.Record_Date;
        return [title, hasRealValue(date) ? date : ""].filter(Boolean).join(", ") || "this sample";
    }

    // A link whose visible text is short ("View") but whose full meaning is read to screen readers
    function contextLink(href, visibleText, spokenText, newTab = false) {
        return el("a", {
            href,
            ...(newTab ? { target: "_blank", rel: "noopener" } : {})
        }, [
            visibleText,
            el("span", { className: "visually-hidden", text: ` ${spokenText}${newTab ? " (opens in a new tab)" : ""}` })
        ]);
    }

    // NABTS datasets are the ones whose rows include an "NABTS_Stream" column (Edutel, ExtraVision, NBC Teletext)
    function isNabtsRow(row) {
        return Object.prototype.hasOwnProperty.call(row, "NABTS_Stream");
    }

    // On-site viewer link: wst-viewer.html or nabts-viewer.html, only if the stream file is in R2
    function viewerLink(datasetKey, row, viewable) {
        if (!hasRealValue(row.IA_ID)) return "-";

        const nabts = isNabtsRow(row);

        // Same matching the Worker uses: WST files are named by IA ID, NABTS files by the NABTS_Stream value
        const fileID = nabts
            ? String(row.NABTS_Stream ?? "").trim().replace(/\.t33$/i, "").toLowerCase()
            : String(row.IA_ID).trim().toLowerCase();

        // viewable is null when the list couldn't be loaded; show the link rather than hide it
        if (viewable && (!fileID || !viewable.has(fileID))) return "-";

        const page = nabts ? "nabts-viewer.html" : "wst-viewer.html";
        // Dataset key exactly as the Worker names it (e.g. "sssTeletext"), matching the viewer links used elsewhere on the site
        const params = new URLSearchParams({ service: datasetKey, sample: String(row.IA_ID).trim() });

        return contextLink(
            `${page}?${params}`,
            el("img", {
                src: "../images/teletext-icon.png",
                class: "mw-100",
                alt: "",
                "aria-hidden": "true",
                role: "presentation",
            }),
            `View ${recordDescription(row)} in the ${nabts ? "NABTS" : "WST"} viewer`
        );
    }

    // Internet Archive link: "Download_Link" if it's a full address, otherwise built from the IA ID
    function archiveOrgLink(row) {
        const stored = String(row.Download_Link ?? "").trim();
        const url = /^https?:\/\//i.test(stored)
            ? stored
            : hasRealValue(row.IA_ID) ? `https://archive.org/details/${encodeURIComponent(String(row.IA_ID).trim())}` : "";

        if (!url) return "-";
        return contextLink(
            url,
            el("i", { className: "bi bi-file-zip-fill", "aria-hidden": "true" }),
            `Download ${recordDescription(row)} from the Internet Archive`,
            true
        );
    }

    // Text service pages stored as "files/ABC-PLUS/1993/ABC_1993-05-18_T1.html" (served by the Worker at /files/...)
    function siteFileLink(value, visibleText, spokenText) {
        const path = String(value ?? "").trim();
        if (!hasRealValue(path)) return "-";

        // Full web addresses are used as-is; anything else with a scheme (e.g. "javascript:") is refused
        if (/^https?:\/\//i.test(path)) return contextLink(path, visibleText, spokenText, true);
        if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "-";

        // Root-relative, so it works from /html/my-submissions.html whether stored as "files/...", "/files/..." or "../files/..."
        return contextLink(`/${path.replace(/^(\.\.\/|\.\/|\/)+/, "")}`, visibleText, spokenText);
    }

    // Bootstrap HTML file icon for text page links. Hidden from screen readers; the link's hidden text describes it
    function htmlIcon() {
        return el("i", { className: "bi bi-filetype-html", "aria-hidden": "true" });
    }

    // StarSight guide link: starsight-data.html?json=%2Ffiles%2FStarSight%2FMTV_1996-04-28.json
    // Accepts the JSON path stored as "StarSight/MTV_1996-04-28.json", "/files/StarSight/...", "files/StarSight/...",
    // or just "MTV_1996-04-28" (the "StarSight/" folder and ".json" are added when missing)
    function starsightLink(row) {
        const stored = [row.Data, row.Dataset_Name].map(value => String(value ?? "").trim()).find(hasRealValue);
        if (!stored || /^[a-z][a-z0-9+.-]*:/i.test(stored)) return "-";

        let key = stored.replace(/^(\.\.\/|\.\/|\/)+/, "").replace(/^files\//i, "");
        if (!key.includes("/")) key = `StarSight/${key}`;
        if (!/\.json$/i.test(key)) key = `${key}.json`;

        const params = new URLSearchParams({ json: `/files/${key}` });

        return contextLink(
            `starsight-data.html?${params}`,
            el("i", { className: "bi bi-calendar-week text-black", "aria-hidden": "true" }),
            `View StarSight listings for ${recordDescription(row)}`
        );
    }

    // Link columns for each kind of service: { headers, cells(row) }
    function linkColumns(group, viewable) {
        const sampleRow = group.rows[0] ?? {};

        // Teletext (WST and NABTS): on-site viewer + Internet Archive download
        if (group.type === "teletext") {
            return {
                headers: ["View", "ZIP"],
                cells: row => [viewerLink(group.dataset, row, viewable), archiveOrgLink(row)]
            };
        }

        // Text services with two pages (ABC PLUS, IPTV AGIDS, PENNTEXT, Wisconsin Infotext Text)
        if ("TEXT1" in sampleRow || "TEXT2" in sampleRow) {
            return {
                headers: ["Text 1", "Text 2"],
                cells: row => [
                    siteFileLink(row.TEXT1, htmlIcon(), `View text page 1 for ${recordDescription(row)}`),
                    siteFileLink(row.TEXT2, htmlIcon(), `View text page 2 for ${recordDescription(row)}`)
                ]
            };
        }

        // Text services with a single page (KCET, KET AgText)
        if ("HTML_Link" in sampleRow) {
            return {
                headers: ["View"],
                cells: row => [siteFileLink(row.HTML_Link, htmlIcon(), `View text pages for ${recordDescription(row)}`)]
            };
        }

        // StarSight EPG listings
        if (group.type === "epg") {
            return {
                headers: ["View"],
                cells: row => [starsightLink(row)]
            };
        }

        // Anything else: no link columns
        return { headers: [], cells: () => [] };
    }

    // Which samples in each teletext dataset can be opened in a viewer (same list the results pages use)
    async function loadViewableSamples(datasets) {
        const teletext = datasets.filter(group => group.type === "teletext");
        const lists = await Promise.all(teletext.map(group => get(`/api/teletext/${encodeURIComponent(group.dataset)}`)));
        const viewable = new Map();

        teletext.forEach((group, index) => {
            const result = lists[index];
            viewable.set(group.dataset, result.ok && Array.isArray(result.ids)
                ? new Set(result.ids.map(id => String(id).toLowerCase()))
                : null);
        });

        return viewable;
    }

    // Tables taller than this scroll inside their box instead of stretching the page
    const TABLE_MAX_HEIGHT = "300px";

    // Fixed widths for specific columns, by heading text. Longer text wraps onto more lines
    const COLUMN_WIDTHS = {
        Program: "450px",
        "Date Added": "150px",
        Tape: "150px",
        Network: "150px"
    };

    function buildTable(caption, headers, rows) {
        // "table-responsive" scrolls sideways on narrow screens; max-height + overflow-y scrolls up and down.
        // tabindex, role, and aria-label let keyboard users focus the box and scroll it with the arrow keys
        return el("div", {
            className: "table-responsive mb-4",
            style: `max-height: ${TABLE_MAX_HEIGHT}; overflow-y: auto;`,
            tabindex: "0",
            role: "region",
            "aria-label": caption
        }, [
            el("table", {
                className: "table table-primary table-striped table-bordered align-middle text-center mb-0"
            }, [
                el("caption", {
                    className: "visually-hidden",
                    text: caption
                }),
                // "sticky-top" keeps the column headings visible while the rows scroll
                el("thead", { className: "sticky-top" }, el("tr", {}, headers.map(header => el("th", {
                    scope: "col",
                    text: header,
                    className: "align-middle",
                    // min-width stops the column from being squeezed narrower on small screens
                    style: COLUMN_WIDTHS[header] ? `width: ${COLUMN_WIDTHS[header]}; min-width: ${COLUMN_WIDTHS[header]};` : null
                })))),
                // A row is either a list of cells, or { cells, className } when the row needs a color (e.g. re-decoding)
                el("tbody", {}, rows.map(row => {
                    const cells = Array.isArray(row) ? row : row.cells;
                    return el("tr", { className: Array.isArray(row) ? null : row.className }, cells.map(cell => el("td", {}, cell)));
                }))
            ])
        ]);
    }

    function renderAccount(data) {
        const signOutBtn = el("button", {
            type: "button",
            className: "btn btn-outline-secondary btn-sm ms-2"
        }, "Sign out");

        signOutBtn.addEventListener("click", async () => {
            await signOut();
            window.location.href = "login.html";
        });

        accountEl.replaceChildren(
            el("p", { className: "mb-2" }, [
                "Signed in as ",
                el("strong", { text: data.name ?? data.email }),
                data.name ? ` (${data.email})` : "",
                signOutBtn
            ]),
            // Only admin accounts see this; the dashboard checks again on the server
            ...(data.isAdmin
                ? [el("p", { className: "mb-2" }, el("a", { href: "admin.html" }, [
                    el("i", { className: "bi bi-speedometer2 me-1", "aria-hidden": "true" }),
                    "Admin dashboard"
                ]))]
                : [])
        );
    }

    // "Submit Samples" button, shown under the "Your submissions" section
    function submitButton() {
        return el("a", {
            href: "submissions.html",
            className: "btn submission-button w-100 mt-2"
        }, "Submit Samples");
    }

    function renderSubmissions(submissions) {
        if (!submissions.length) {
            submissionsEl.replaceChildren(
                el("p", { className: "text-muted" },
                    "There is nothing here yet. Samples you submit while signed in will appear here so you can follow their review."
                ),
                submitButton()
            );
            return;
        }

        const rows = submissions.map(item => {
            const status = STAUTS_LABELS[item.status] ?? {
                text: item.status,
                badge: "text-bg-secondary"
            };

            const tape = [item.tape_type, item.tape_speed].filter(hasRealValue).join(" ");

            return [
                el("code", { text: item.ref }),
                formatSubmittedAt(item.submitted_at),
                [item.network, item.service].filter(hasRealValue).join(" - ") || "-",
                hasRealValue(item.sample_date) ? item.sample_date : "-",
                programTitleCell(item.program_title),
                tape || "-",
                hasRealValue(item.file_name) ? item.file_name : "-",
                el("span", {
                    className: `badge ${status.badge}`,
                    text: status.text
                })
            ];
        });

        submissionsEl.replaceChildren(
            buildTable(
                "Your submissions",
                [
                    "Reference", "Submitted", "Network / Service", "Date",
                    "Program", "Tape", "File", "Status"
                ],
                rows
            ),
            submitButton()
        );
    }

    function render(data, viewableSamples = new Map()) {
        // Count next to the "In the archive" heading (if the page has that element)
        if (archiveCountEl) archiveCountEl.textContent = data.total === 1 ? "1" : `${data.total}`;

        if (!data.datasets.length) {
            archiveEl.replaceChildren(el("p", { className: "text-muted" },
                `No records are credited to "${data.name}" yet. Once a submissions is added to the site, it will show up here.`
            ));
            return;
        }

        const sections = data.datasets.map(group => {
            const label = DATASET_LABELS[group.dataset] ?? group.table;
            const links = linkColumns(group, viewableSamples.get(group.dataset) ?? null);
            const rows = group.rows.map(row => {
                const date = row.Date ?? row.Record_Date;
                const tape = [row.Tape_Type, row.Tape_Speed].filter(hasRealValue).join(" ");

                const cells = [
                    hasRealValue(date) ? date : "-",
                    programTitleCell(row.Program_Title),
                    [row.Network, row.Affiliate].filter(hasRealValue).join(" / ") || "-",
                    tape || "-",
                    hasRealValue(row.Date_Added)
                        ? [row.Date_Added, row.isNew
                            ? el("span", {
                                className: "badge text-bg-success ms-2",
                                text: "New"
                            })
                            : null
                        ]
                        : "-",
                    ...links.cells(row)
                ];

                // Being re-decoded: color the row and add spoken text for screen readers
                if (row.needsRedecode === true) {
                    cells[0] = [
                        cells[0],
                        el("span", { className: "visually-hidden", text: ". Being re-decoded with an updated decoder" })
                    ];
                    return { className: "redecode-row-bg", cells };
                }

                return cells;
            });

            const headingID = `dataset-${group.dataset}`;
            const banner = DATASET_BANNERS[group.dataset];
            const countText = group.rows.length === 1 ? "Submissions: 1" : `Submissions: ${group.rows.length}`;

            const heading = banner
                // Banner: screen readers hear the hidden text, the images are decoration
                ? [
                    el("h3", {
                        id: headingID,
                        className: "mt-4 mb-1"
                    }, [
                        el("span", {
                            className: "visually-hidden",
                            text: `${label}, ${countText}`
                        }),
                        el("img", {
                            src: `../images/banners/light/${banner}_light.png`,
                            alt: "",
                            className: "mw-100 light-mode-image",
                            "aria-hidden": "true",
                            role: "presentation"
                        }),
                        el("img", {
                            src: `../images/banners/dark/${banner}.png`,
                            alt: "",
                            className: "mw-100 dark-mode-image",
                            "aria-hidden": "true",
                            role: "presentation"
                        })
                    ]),
                    el("p", {
                        className: "text-center mt-4 fs-3",
                        "aria-hidden": "true",
                        text: countText
                    })
                ]
                // No banner: plain text heading
                : [
                    el("h3", {
                        id: headingID,
                        className: "h5 mt-3"
                    }, [
                        label, el("span", {
                            className: "text-muted fw-normal",
                            text: ` - ${countText}`
                        })
                    ])
                ];

            // Each service is one column: two side by side on large screens, stacked on phones and tablets
            return el("section", {
                "aria-labelledby": headingID,
                className: "col-12 col-lg-6"
            }, [
                ...heading,

                buildTable(`${label} records credited to you`, [
                    "Date", "Program", "Network",
                    "Tape", "Date Added", ...links.headers
                ], rows)
            ]);
        });

        // Explains the color, only when at least one of this contributor's records is flagged
        const anyRedecode = data.datasets.some(group => group.rows.some(row => row.needsRedecode === true));
        const redecodeNote = anyRedecode
            ? [el("p", {
                className: "alert alert-warning",
                text: "Highlighted samples are being re-decoded with an updated decoder. Their pages may change once that's done."
            })]
            : [];

        archiveEl.replaceChildren(
            ...redecodeNote,
            el("div", { className: "row" }, sections)
        );
    }

    const data = await get("/api/auth/my-submissions");

    if (data.status === 401) {
        window.location.href = "login.html?next=my-submissions.html";
        return;
    }

    if (!data.ok) {
        archiveEl.replaceChildren(el("div", {
            className: "alert alert-danger",
            role: "alert"
        }, data.error || "Your samples could not be loaded. Please try again."));
        submissionsEl.replaceChildren();
        return;
    }

    if (data.nameStatus !== "active") {
        window.location.href = "login.html?next=my-submissions.html";
        return;
    }

    renderAccount(data);
    renderSubmissions(data.submissions ?? []);
    render(data, await loadViewableSamples(data.datasets ?? []));
});