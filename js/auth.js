// ^ Sign-in links work for 15 minutes. Sessions last 30 days
const TOKEN_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// ^ Maximum sign-in emails per address within the 15-minute window
const MAX_LINKS_PER_WINDOW = 3;

// ^ Same 7-day "new" window used by "exportTable()"" in "Index" JS file"
const NEW_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const COOKIE_NAME = "nat_session";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ^ Letters (any language), numbers, spaces, and . ' & - ;
// * 2 to 60 characters
const NAME_PATTERN = /^[\p{L}\p{N} .'&-]{2,60}$/u;

// ^ 32 random bytes in base64url is always 43 characters
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// ^ Public credit used for contributors who choose to stay anonymous.
// * Nobody can pick it as their own contributor name, so "Anonymous" records never match a single account
const ANONYMOUS_CREDIT = "Anonymous";
const RESERVED_NAMES = ["anonymous", "unknown", "n/a", "none"];

// ^ Submission log limits including samples per form submission and the longest value kept for each field
const MAX_SAMPLES_PER_SUBMISSION = 50;
const SUBMISSION_FIELD_LIMITS = {
    network: 100, service: 100, date: 20, programTitle: 300, tapeType: 20, tapeSpeed: 20, fileName: 200
};
const SUBMISSION_STATUSES = ["received", "archived", "declined"];

// ^ Reference codes look like NAT-7KQ2M9XD (no 0/O or 1/I, so they're easy to read back)
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REF_PATTERN = /^NAT-[A-Z2-9]{8}$/;

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

// & Unguessable random string for sign-in tokens and session IDs
function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// & Hash tokens before storing them so a leaked database can't be used to log in
async function sha256(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// & JSON response that browsers and Cloudflare never cache (these answers are per-user)
function authJson(data, status = 200, setCookie = null) {
    const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });

    if (setCookie) headers.append("Set-Cookie", setCookie);
    return new Response(JSON.stringify(data), { status, headers });
}

function getCookie(request, name) {
    const header = request.headers.get("Cookie") || "";

    for (const part of header.split(";")) {
        const [key, ...value] = part.trim().split("=");
        if (key === name) return value.join("=");
    }

    return null;
}

/*
! HttpOnly: page: JS cannot read it.
! Secure: HTTPS only.
! SameSite=Lax: Not sent on cross-site POSTs
*/
function sessionCookie(value, maxAge, env) {
    // Secure everywhere the site runs on https (the live site). Left off only for local testing on http://localhost,
    // because Safari throws away Secure cookies there and sign-in would loop back to the start
    const secure = String(siteOrigins(env)[0] ?? "").startsWith("http://") ? "" : " Secure;";
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

function siteOrigins(env) {
    return String(env.SITE_ORIGIN || "").split(",").map(origin => origin.trim()).filter(Boolean);
}

// & Blocks other websites from submitting requests on a logged-in visitor's behalf
function isAllowedOrigin(request, env) {
    const origin = request.headers.get("Origin");
    return Boolean(origin) && siteOrigins(env).includes(origin);
}

// & Only accept JSON bodies
// * Cross-site forms can't send this content type without permission
async function readJson(request) {
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) return null;

    try {
        return await request.json();
    } catch {
        return null;
    }
}

function submissionRef() {
    // 32 letters divides 256 evenly so every character is equally likely
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return "NAT-" + [...bytes].map(byte => REF_ALPHABET[byte % REF_ALPHABET.length]).join("");
}

function cleanField(value, maxLength) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

// & The name shown publicly for this account's new submissions
function creditName(user) {
    return user.is_anonymous ? ANONYMOUS_CREDIT : user.name;
}

function isNewRecord(dateAdded, now) {
    if (dateAdded === null || dateAdded === undefined) return false;

    const added = new Date(dateAdded);
    if (Number.isNaN(added.getTime())) return false;

    const age = now - Math.floor(added.getTime() / 1000);
    return age >= 0 && age <= NEW_WINDOW_SECONDS;
}

// & Look up the logged-in user from the session cookie; null if not logged in
export async function getSessionUser(request, env) {
    const sessionID = getCookie(request, COOKIE_NAME);
    if (!sessionID || !TOKEN_PATTERN.test(sessionID)) return null;

    return await env.DB.prepare(`
        SELECT u.id, u.email, u.name, u.name_status, u.is_anonymous, u.is_admin, s.created_at AS session_started
        FROM sessions AS s
        JOIN users AS u ON u.id = s.user_id
        WHERE s.id_hash = ? AND s.expires_at > ?
    `).bind(await sha256(sessionID), nowSeconds()).first();
}

// & Send the email
async function sendLoginEmail(env, to, link) {
    // Local testing only: print the link instead of emailing it (set DEV_LOG_LINKS=true in .dev.vars, never in production)
    if (env.DEV_LOG_LINKS === "true") {
        console.log(`Sign-in link for ${to}: ${link}`);
        return;
    }

    // Expiry time in Eastern Time, e.g. "3:15 AM ET". Makes each email's text different, so Gmail doesn't hide it as repeated
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toLocaleTimeString("en-US", {
        timeZone: "America/New_York", hour: "numeric", minute: "2-digit"
    });

    const subject = "Sign-in link for NATA";
    const text = `Use this link to sign in to the North American Teletext Archive:\n\n${link}\n\nThe link works once and expires at ${expiresAt} ET (15 minutes after it was sent). If you didn't request it, you can ignore this email.`;
    const html = `<p>Use this link to sign in to the North American Teletext Archive:</p>
<p><a href="${link}">Sign in to nateletext.com</a></p>
<p>The link works once and expires at ${expiresAt} ET (15 minutes after it was sent). If you didn't request it, you can ignore this email.</p>`;

    // A unique ID on every email stops Gmail from grouping sign-in emails into one conversation
    // and collapsing the newer ones (they'd look empty, with only a "..." button)
    const headers = { "X-Entity-Ref-ID": crypto.randomUUID() };

    // ^ Option 1: Cloudflare Email Service (send_email binding named "EMAIL")
    if (env.EMAIL) {
        await env.EMAIL.send({ from: env.EMAIL_FROM, to, subject, text, html, headers });
        return;
    }

    // ^ Option 2: Resend
    if (env.RESEND_API_KEY) {
        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, html, headers })
        });

        if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
        return;
    }

    throw new Error("No email sender is configured (add an EMAIL binding or a RESEND_API_KEY secret)");
}


// & Route handlers
// & Step 1: A visitor types their email and a sign-in link is sent
async function requestLink(request, env) {
    const body = await readJson(request);
    const email = String(body?.email ?? "").trim().toLowerCase();

    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
        return authJson({ error: "Enter a valid email address." }, 400);
    }

    const now = nowSeconds();

    // Rate limit so the form can't be used to flood someone's inbox
    const recent = await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM login_tokens WHERE email = ? AND created_at > ?
    `).bind(email, now - TOKEN_TTL_SECONDS).first();

    if ((recent?.count ?? 0) >= MAX_LINKS_PER_WINDOW) {
        return authJson({ error: "Too many sign-in links were requested for this address. Wait 15 minutes and try again." }, 429);
    }

    const token = randomToken();

    await env.DB.batch([
        // Clean out expired links while here
        env.DB.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).bind(now),
        env.DB.prepare(`
            INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)
        `).bind(await sha256(token), email, now + TOKEN_TTL_SECONDS, now)
    ]);

    // * Optional page to return to after signing in; only plain page names like "submissions.html" are allowed
    const next = /^[a-z0-9-]+\.html$/i.test(String(body?.next ?? "")) ? `&next=${body.next}` : "";

    // * The link opens the login page, which then POSTs the token (see the note on email scanners)
    const link = `${siteOrigins(env)[0]}${env.LOGIN_PAGE || "/html/login.html"}?token=${token}${next}`;
    await sendLoginEmail(env, email, link);

    // * Same answer whether or not an account exists, so the form can't be used to check who is registered
    return authJson({ ok: true });
}

// & Step 2: visitor clicks the link; the login page sends the token here
async function verifyLink(request, env) {
    const body = await readJson(request);
    const token = String(body?.token ?? "");

    if (!TOKEN_PATTERN.test(token)) return authJson({ error: "This sign-in link is invalid." }, 400);

    const now = nowSeconds();

    // * Delete and read in one statement so the same link can never be used twice
    const row = await env.DB.prepare(`
        DELETE FROM login_tokens WHERE token_hash = ? RETURNING email, expires_at
    `).bind(await sha256(token)).first();

    if (!row || row.expires_at < now) {
        return authJson({ error: "This sign-in link has expired or was already used. Request a new one." }, 400);
    }

    // * First sign-in creates the account
    await env.DB.prepare(`INSERT INTO users (email) VALUES (?) ON CONFLICT (email) DO NOTHING`).bind(row.email).run();
    const user = await env.DB.prepare(`SELECT id, name, name_status FROM users WHERE email = ?`).bind(row.email).first();

    const sessionID = randomToken();

    await env.DB.batch([
        env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now),
        env.DB.prepare(`
            INSERT INTO sessions (id_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)
        `).bind(await sha256(sessionID), user.id, now + SESSION_TTL_SECONDS, now),
        env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).bind(user.id)
    ]);

    return authJson({ ok: true, needsName: user.name_status === "none" }, 200, sessionCookie(sessionID, SESSION_TTL_SECONDS, env));
}

// & Do this if the name already appear in the "Recovered_By" column anywhere on the site
async function isExistingContributor(db, tables, name) {
    const statements = Object.values(tables).map(config => db.prepare(`
        SELECT 1 AS found FROM ${config.table}
        WHERE LOWER(TRIM(CAST(Recovered_By AS TEXT))) = LOWER(?)
        LIMIT 1
    `).bind(name));

    const results = await db.batch(statements);
    return results.some(result => result.results?.length);
}

// & First-time setup: the user picks the name that gets credited on their submissions
async function setName(request, env, tables) {
    const user = await getSessionUser(request, env);
    if (!user) return authJson({ error: "You're not signed in." }, 401);

    // Once confirmed, names can only be changed by the admin, since it's tied to credited records
    if (user.name_status === "active") {
        return authJson({ error: "Your name is already set. Contact us to change it." }, 409);
    }

    const body = await readJson(request);
    const name = String(body?.name ?? "").replace(/\s+/g, " ").trim();

    if (!NAME_PATTERN.test(name)) {
        return authJson({ error: "Names can be 2 to 60 characters: letters, numbers, spaces, and . ' & -" }, 400);
    }

    // "Anonymous" is the public credit for anonymous contributors, not a name anyone can own
    if (RESERVED_NAMES.includes(name.toLowerCase())) {
        return authJson({ error: `Please choose a name or moniker. To stay anonymous, check "Credit my submissions as Anonymous" instead.` }, 400);
    }

    const taken = await env.DB.prepare(`SELECT id FROM users WHERE name = ? AND id != ?`).bind(name, user.id).first();
    if (taken) return authJson({ error: "That name is already used by another account." }, 409);

    // If this name is already credited in the archive, an admin confirms the person really is that contributor
    const nameStatus = await isExistingContributor(env.DB, tables, name) ? "pending" : "active";
    const isAnonymous = body?.anonymous === true ? 1 : 0;

    await env.DB.prepare(`UPDATE users SET name = ?, name_status = ?, is_anonymous = ? WHERE id = ?`)
        .bind(name, nameStatus, isAnonymous, user.id).run();

    return authJson({ ok: true, name, nameStatus, anonymous: Boolean(isAnonymous) });
}

// & Turn "stay anonymous" on or off. Only affects submissions sent afterward
async function setAnonymous(request, env) {
    const user = await getSessionUser(request, env);
    if (!user) return authJson({ error: "You're not signed in." }, 401);

    const body = await readJson(request);
    if (typeof body?.anonymous !== "boolean") return authJson({ error: "Missing anonymous setting." }, 400);

    await env.DB.prepare(`UPDATE users SET is_anonymous = ? WHERE id = ?`).bind(body.anonymous ? 1 : 0, user.id).run();

    const updated = { ...user, is_anonymous: body.anonymous ? 1 : 0 };
    return authJson({ ok: true, anonymous: body.anonymous, creditName: creditName(updated) });
}

async function logout(request, env) {
    const sessionID = getCookie(request, COOKIE_NAME);

    if (sessionID && TOKEN_PATTERN.test(sessionID)) {
        await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sha256(sessionID)).run();
    }

    // Max-Age=0 tells the browser to delete the cookie
    return authJson({ ok: true }, 200, sessionCookie("", 0, env));
}

// & Used by the submission form (auto-fill) and the site header (signed in / signed out)
async function me(request, env) {
    const user = await getSessionUser(request, env);
    if (!user) return authJson({ loggedIn: false });

    return authJson({
        loggedIn: true,
        email: user.email,
        name: user.name,
        nameStatus: user.name_status,
        anonymous: Boolean(user.is_anonymous),
        // What the submission form should fill in: "Anonymous" or the contributor name
        creditName: creditName(user),
        // Only used to show an "Admin dashboard" link; every admin route checks this again on the server
        isAdmin: user.is_admin === 1
    });
}

// & Called by the submission form right before it sends everything to Formspree.
// * Rows start as "uploading" and stay hidden until the form confirms Formspree accepted the upload,
// * so a refused or interrupted upload never shows up as "Received" on My Samples or the admin dashboard
async function logSubmission(request, env) {
    const user = await getSessionUser(request, env);
    if (!user) return authJson({ error: "You're not signed in." }, 401);
    if (user.name_status !== "active") return authJson({ error: "Your contributor name hasn't been confirmed yet." }, 403);

    const body = await readJson(request);
    const samples = Array.isArray(body?.samples) ? body.samples : [];

    if (samples.length === 0 || samples.length > MAX_SAMPLES_PER_SUBMISSION) {
        return authJson({ error: `Send between 1 and ${MAX_SAMPLES_PER_SUBMISSION} samples.` }, 400);
    }

    const ref = submissionRef();
    const limits = SUBMISSION_FIELD_LIMITS;

    // Decided here from the account setting, not taken from the form, so it can't be changed in the browser
    const credit = creditName(user);

    // Clear out this account's uploads that never finished (browser closed mid-upload) more than a day ago
    const cleanup = env.DB.prepare(`
        DELETE FROM submissions WHERE user_id = ? AND status = 'uploading' AND submitted_at < datetime('now', '-1 day')
    `).bind(user.id);

    // One row per sample, all written together
    const statements = samples.map(sample => env.DB.prepare(`
        INSERT INTO submissions (ref, user_id, credit_as, network, service, sample_date, program_title, tape_type, tape_speed, file_name, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')
    `).bind(
        ref,
        user.id,
        credit,
        cleanField(sample?.network, limits.network),
        cleanField(sample?.service, limits.service),
        cleanField(sample?.date, limits.date),
        cleanField(sample?.programTitle, limits.programTitle),
        cleanField(sample?.tapeType, limits.tapeType),
        cleanField(sample?.tapeSpeed, limits.tapeSpeed),
        cleanField(sample?.fileName, limits.fileName)
    ));

    await env.DB.batch([cleanup, ...statements]);
    return authJson({ ok: true, ref, name: user.name, creditName: credit });
}

// & After Formspree accepts the upload: "uploading" -> "received" (now visible on My Samples and the admin dashboard).
// & After Formspree refuses it: the rows are removed.
async function finishSubmission(request, env, accepted) {
    const user = await getSessionUser(request, env);
    if (!user) return authJson({ error: "You're not signed in." }, 401);

    const body = await readJson(request);
    const ref = String(body?.ref ?? "").trim().toUpperCase();
    if (!REF_PATTERN.test(ref)) return authJson({ error: "Invalid reference code" }, 400);

    // Only this account's own rows, and only while still "uploading", so finished submissions can't be changed here
    const statement = accepted
        ? env.DB.prepare(`UPDATE submissions SET status = 'received' WHERE ref = ? AND user_id = ? AND status = 'uploading' RETURNING id`)
        : env.DB.prepare(`DELETE FROM submissions WHERE ref = ? AND user_id = ? AND status = 'uploading' RETURNING id`);

    const { results } = await statement.bind(ref, user.id).all();
    if (!results?.length) return authJson({ error: "No upload in progress with that reference code" }, 404);

    return authJson({ ok: true, ref, samples: results.length });
}

async function getUserSubmissions(db, userID) {
    const { results } = await db.prepare(`
        SELECT ref, submitted_at, credit_as, network, service, sample_date, program_title, tape_type, tape_speed, file_name, status
        FROM submissions
        WHERE user_id = ? AND status != 'uploading'
        ORDER BY submitted_at DESC, id ASC
    `).bind(userID).all();

    return results ?? [];
}

// & Logged submissions, plus every record across every dataset whose "Recovered_By" matches the user's name
async function mySamples(request, env, tables) {
    const user = await getSessionUser(request, env);
    if (!user) return authJson({ error: "You're not signed in." }, 401);

    const submissions = await getUserSubmissions(env.DB, user.id);

    const anonymous = Boolean(user.is_anonymous);

    if (user.name_status !== "active") {
        return authJson({ name: user.name, email: user.email, nameStatus: user.name_status, anonymous, submissions, total: 0, datasets: [] });
    }

    const entries = Object.entries(tables);

    // One query per dataset, all sent to D1 in a single batch
    const statements = entries.map(([, config]) => {
        const columns = config.columns.map(column => `t.${column}`).join(", ");
        const dateField = config.dateField || "Date";

        return env.DB.prepare(`
            SELECT ${columns}
            FROM ${config.table} AS t
            WHERE LOWER(TRIM(CAST(t.Recovered_By AS TEXT))) = LOWER(?)
            ORDER BY t.Year, t.${dateField}
        `).bind(user.name);
    });

    const results = await env.DB.batch(statements);
    const now = nowSeconds();

    // Re-decode list, only shown here on each contributor's own page.
    // Loaded separately so a database without the redecode_queue table (e.g. staging before the migration) still loads the page
    let redecodeRows = [];
    try {
        redecodeRows = (await env.DB.prepare(`SELECT dataset_table, record_id FROM redecode_queue`).all()).results ?? [];
    } catch (err) {
        console.warn("Re-decode list unavailable (run migration-redecode.sql on this database):", err.message);
    }

    // IDs are UUIDs: compared as text, ignoring case and stray spaces
    const redecodeKey = (table, id) => `${table}:${String(id ?? "").trim().toLowerCase()}`;
    const needsRedecode = new Set(redecodeRows.map(entry => redecodeKey(entry.dataset_table, entry.record_id)));

    // Same row shape as /api/<dataset>, so results-renderer.js can render each group unchanged
    const datasets = entries
        .map(([key, config], index) => ({
            dataset: key,
            table: config.table,
            type: config.type,
            rows: (results[index].results ?? []).map(row => ({
                ...row,
                isNew: isNewRecord(row.Date_Added, now),
                needsRedecode: needsRedecode.has(redecodeKey(config.table, row[config.idField || "ID"]))
            }))
        }))
        .filter(group => group.rows.length > 0);

    const total = datasets.reduce((sum, group) => sum + group.rows.length, 0);
    // Archive matches use the private contributor name, never "Anonymous", so records credited "Anonymous" aren't listed here;
    // those samples show up in "submissions" instead, with their review status
    return authJson({ name: user.name, email: user.email, nameStatus: user.name_status, anonymous, isAdmin: user.is_admin === 1, submissions, total, datasets });
}

// & Admin: confirm a pending name (same ?key= pattern as the gallery generation routes)
async function approveName(url, env) {
    if (url.searchParams.get("key") !== env.ADMIN_KEY) return authJson({ error: "Forbidden" }, 403);

    const email = String(url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!email) return authJson({ error: "Missing email" }, 400);

    const result = await env.DB.prepare(`
        UPDATE users SET name_status = 'active' WHERE email = ? AND name_status = 'pending' RETURNING email, name
    `).bind(email).first();

    if (!result) return authJson({ error: "No pending name for that email" }, 404);
    return authJson({ ok: true, ...result });
}

// & Admin: mark every sample under a reference code as archived, declined, or back to received
async function setSubmissionStatus(url, env) {
    if (url.searchParams.get("key") !== env.ADMIN_KEY) return authJson({ error: "Forbidden" }, 403);

    const ref = String(url.searchParams.get("ref") ?? "").trim().toUpperCase();
    const status = String(url.searchParams.get("status") ?? "").trim().toLowerCase();

    if (!REF_PATTERN.test(ref)) return authJson({ error: "Invalid reference code" }, 400);
    if (!SUBMISSION_STATUSES.includes(status)) return authJson({ error: `Status must be one of: ${SUBMISSION_STATUSES.join(", ")}` }, 400);

    const { results } = await env.DB.prepare(`UPDATE submissions SET status = ? WHERE ref = ? AND status != 'uploading' RETURNING id`).bind(status, ref).all();
    if (!results?.length) return authJson({ error: "No submission with that reference code" }, 404);

    return authJson({ ok: true, ref, status, samplesUpdated: results.length });
}

export async function handleAuth(request, env, tables) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
        if (request.method === "POST") {
            if (!isAllowedOrigin(request, env)) return authJson({ error: "Forbidden" }, 403);

            if (path === "/api/auth/request-link") return await requestLink(request, env);
            if (path === "/api/auth/verify") return await verifyLink(request, env);
            if (path === "/api/auth/name") return await setName(request, env, tables);
            if (path === "/api/auth/logout") return await logout(request, env);
            if (path === "/api/auth/submissions") return await logSubmission(request, env);
            if (path === "/api/auth/anonymous") return await setAnonymous(request, env);
            if (path === "/api/auth/submissions/confirm") return await finishSubmission(request, env, true);
            if (path === "/api/auth/submissions/cancel") return await finishSubmission(request, env, false);
        }

        if (request.method === "GET") {
            if (path === "/api/auth/me") return await me(request, env);
            if (path === "/api/auth/my-submissions") return await mySamples(request, env, tables);
            if (path === "/api/auth/admin/approve-name") return await approveName(url, env);
            if (path === "/api/auth/admin/submission-status") return await setSubmissionStatus(url, env);
        }

        return null;
    } catch (error) {
        console.error(`Auth route ${path} failed:`, error);
        return authJson({ error: "Something went wrong. Please try again." }, 500);
    }
}

/*
* ADMIN DASHBOARD
* Routes (only for signed-in accounts with users.is_admin = 1):
*
*   GET  /api/admin/overview                         -> counts for the dashboard header
*   GET  /api/admin/submissions?status=received      -> submissions grouped by reference code (received | archived | declined | all)
*   POST /api/admin/submissions/status { ref, status } -> mark a submission archived, declined, or back to received
*   GET  /api/admin/names                            -> contributor names waiting for confirmation
*   POST /api/admin/names/decision { email, approve } -> approve a pending name, or reject it so they choose another
*/

// ^ Admin pages ask for a fresh sign-in once a day, even though contributor sessions last 30 days
const ADMIN_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

// ^ Most reference codes listed at once
const ADMIN_SUBMISSION_LIMIT = 200;

// & Every admin route starts here. Returns { user } or { response } to send back
async function requireAdmin(request, env) {
    const user = await getSessionUser(request, env);

    if (!user) return { response: authJson({ error: "You're not signed in.", reauth: true }, 401) };
    if (user.is_admin !== 1) return { response: authJson({ error: "This page is only for archive admins." }, 403) };

    if (nowSeconds() - Number(user.session_started ?? 0) > ADMIN_SESSION_MAX_AGE_SECONDS) {
        return { response: authJson({ error: "For security, please sign in again to use the admin dashboard.", reauth: true }, 401) };
    }

    return { user };
}

async function adminOverview(env) {
    const [received, pendingNames] = await env.DB.batch([
        env.DB.prepare(`SELECT COUNT(DISTINCT ref) AS count FROM submissions WHERE status = 'received'`),
        env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE name_status = 'pending'`)
    ]);

    return authJson({
        awaitingReview: Number(received.results?.[0]?.count ?? 0),
        pendingNames: Number(pendingNames.results?.[0]?.count ?? 0)
    });
}

// & Submissions grouped by reference code, newest first, with who sent them
async function adminSubmissions(url, env) {
    const status = String(url.searchParams.get("status") ?? "received").trim().toLowerCase();
    if (status !== "all" && !SUBMISSION_STATUSES.includes(status)) {
        return authJson({ error: `Status must be all or one of: ${SUBMISSION_STATUSES.join(", ")}` }, 400);
    }

    // "All" still leaves out uploads that never finished; those files never reached Formspree
    const filter = status === "all" ? "WHERE s.status != 'uploading'" : "WHERE s.status = ?";

    // Pick the newest reference codes first, then load every sample under them
    const { results } = await env.DB.prepare(`
        WITH refs AS (
            -- MAX(id) breaks ties between submissions sent in the same second
            SELECT ref, MIN(submitted_at) AS first_at, MAX(id) AS last_id
            FROM submissions AS s
            ${filter}
            GROUP BY ref
            ORDER BY first_at DESC, last_id DESC
            LIMIT ${ADMIN_SUBMISSION_LIMIT}
        )
        SELECT s.id, s.ref, s.submitted_at, s.status, s.credit_as, s.network, s.service, s.sample_date,
               s.program_title, s.tape_type, s.tape_speed, s.file_name,
               u.email, u.name AS contributor_name
        FROM submissions AS s
        JOIN refs ON refs.ref = s.ref
        JOIN users AS u ON u.id = s.user_id
        ORDER BY refs.first_at DESC, refs.last_id DESC, s.id ASC
    `).bind(...(status === "all" ? [] : [status])).all();

    const groups = new Map();

    for (const row of results ?? []) {
        if (!groups.has(row.ref)) {
            groups.set(row.ref, {
                ref: row.ref,
                submittedAt: row.submitted_at,
                contributorName: row.contributor_name,
                email: row.email,
                creditAs: row.credit_as,
                statuses: new Set(),
                samples: []
            });
        }

        const group = groups.get(row.ref);
        group.statuses.add(row.status);
        group.samples.push({
            network: row.network,
            service: row.service,
            date: row.sample_date,
            programTitle: row.program_title,
            tapeType: row.tape_type,
            tapeSpeed: row.tape_speed,
            fileName: row.file_name,
            status: row.status
        });
    }

    // Status of the whole submission; "mixed" only if samples were ever set separately
    const submissions = [...groups.values()].map(({ statuses, ...group }) => ({
        ...group,
        status: statuses.size === 1 ? [...statuses][0] : "mixed"
    }));

    return authJson({ status, submissions });
}

async function adminSetSubmissionStatus(request, env) {
    const body = await readJson(request);
    const ref = String(body?.ref ?? "").trim().toUpperCase();
    const status = String(body?.status ?? "").trim().toLowerCase();

    if (!REF_PATTERN.test(ref)) return authJson({ error: "Invalid reference code" }, 400);
    if (!SUBMISSION_STATUSES.includes(status)) return authJson({ error: `Status must be one of: ${SUBMISSION_STATUSES.join(", ")}` }, 400);

    const { results } = await env.DB.prepare(`UPDATE submissions SET status = ? WHERE ref = ? AND status != 'uploading' RETURNING id`).bind(status, ref).all();
    if (!results?.length) return authJson({ error: "No submission with that reference code" }, 404);

    return authJson({ ok: true, ref, status, samplesUpdated: results.length });
}

// & Names waiting for confirmation, with how many archive records already use each one
async function adminPendingNames(env, tables) {
    const { results } = await env.DB.prepare(`
        SELECT email, name, created_at, last_login_at
        FROM users
        WHERE name_status = 'pending'
        ORDER BY created_at ASC
    `).all();

    const pending = results ?? [];
    const configs = Object.values(tables);

    // One count query per dataset for each pending name, sent together
    const statements = pending.flatMap(user => configs.map(config => env.DB.prepare(`
        SELECT COUNT(*) AS count FROM ${config.table}
        WHERE LOWER(TRIM(CAST(Recovered_By AS TEXT))) = LOWER(?)
    `).bind(user.name)));

    const counts = statements.length ? await env.DB.batch(statements) : [];

    const names = pending.map((user, index) => {
        const start = index * configs.length;
        const records = counts.slice(start, start + configs.length)
            .reduce((sum, result) => sum + Number(result.results?.[0]?.count ?? 0), 0);

        return { email: user.email, name: user.name, createdAt: user.created_at, lastLoginAt: user.last_login_at, creditedRecords: records };
    });

    return authJson({ names });
}

// & Approve: the name becomes active. Reject: the name is cleared and they're asked to choose another next time they sign in
async function adminNameDecision(request, env) {
    const body = await readJson(request);
    const email = String(body?.email ?? "").trim().toLowerCase();

    if (!email) return authJson({ error: "Missing email" }, 400);
    if (typeof body?.approve !== "boolean") return authJson({ error: "Missing decision" }, 400);

    const sql = body.approve
        ? `UPDATE users SET name_status = 'active' WHERE email = ? AND name_status = 'pending' RETURNING email, name`
        : `UPDATE users SET name = NULL, name_status = 'none' WHERE email = ? AND name_status = 'pending' RETURNING email`;

    const result = await env.DB.prepare(sql).bind(email).first();
    if (!result) return authJson({ error: "No pending name for that email" }, 404);

    return authJson({ ok: true, approved: body.approve, ...result });
}

// & Router for /api/admin/*. Returns a Response, or null if the path isn't an admin route
export async function handleAdmin(request, env, tables) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
        // Same protections as the sign-in routes: changes only from this site, as JSON
        if (request.method === "POST" && !isAllowedOrigin(request, env)) return authJson({ error: "Forbidden" }, 403);

        const { response } = await requireAdmin(request, env);
        if (response) return response;

        if (request.method === "GET") {
            if (path === "/api/admin/overview") return await adminOverview(env);
            if (path === "/api/admin/submissions") return await adminSubmissions(url, env);
            if (path === "/api/admin/names") return await adminPendingNames(env, tables);
        }

        if (request.method === "POST") {
            if (path === "/api/admin/submissions/status") return await adminSetSubmissionStatus(request, env);
            if (path === "/api/admin/names/decision") return await adminNameDecision(request, env);
        }

        return null;
    } catch (error) {
        console.error(`Admin route ${path} failed:`, error);
        return authJson({ error: "Something went wrong. Please try again." }, 500);
    }
}