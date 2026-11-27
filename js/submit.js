// ^ Allowed file extensions
const ALLOWED_EXTENSIONS = ["t33", "t34", "png", "html", "htm", "zip"];

// ^ Size limits (same as the "Add New Form" JS)
const MB = 1024 * 1024;
const MAX_FILE_BYTES = 25 * MB;
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 95 * MB;

// ^ File types allowed *inside* a ZIP
const ALLOWED_IN_ZIP = ["t33", "t34", "t42", "png", "svg", "json", "html", "htm"];

// ^ Skips unnecessary junk OSes add to ZIPs - do not rejecct these
const ZIP_JUNK = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/i, /(^|\/)desktop\.ini$/i];

// ^ Max entries inside a ZIP file
const MAX_ZIP_ENTRIES = 5000;

// ^ First bytes of each binary type. If an EXE is renamed to an accepted file type, it is rejected
const MAGIC_BYTES = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    zip: [0x50, 0x4b, 0x03, 0x04]
};

// & The "Add New Form" JS reads an error or error messages from the reply and shows it
function reply(status, error = "") {
    return new Response(JSON.stringify(error ? { error } : {}), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function allowedOrigin(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = (env.SITE_ORIGIN || "").split(",").map(o => o.trim());
    return origin && allowed.includes(origin);
}

async function looksLikeItsExtension(file, ext) {
    const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());

    if (MAGIC_BYTES[ext]) {
        return MAGIC_BYTES[ext].every((byte, i) => head[i] === byte);
    }

    if (ext === "svg") {
        return new TextDecoder().decode(head).toLowerCase().includes("<svg");
    }

    // HTML exports should start with a doctype or an <html> tag (after any whitespace or byte order mark)
    if (ext === "html" || ext === "htm") {
        const start = new TextDecoder().decode(head).replace(/^\uFEFF/, "").trimStart().toLowerCase();
        return start.startsWith("<!doctype html") || start.startsWith("<html") || start.startsWith("<!--");
    }

    // T33/T34 files contain raw teletext packets; these do not have a header to check
    return true;
}

// & Read list of file names store at the end of a ZIP without unpacking. Returns null or error message
async function checkZipContents(file) {
    const fail = `"${file.name}"`;

    // EOCD record is in the last 22 bytes or 64 KB earlier if comment is present
    const tailStart = Math.max(0, file.size - (22 + 0xffff));
    const tail = new DataView(await file.slice(tailStart).arrayBuffer());

    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (tail.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }

    if (eocd < 0) return `${fail} couldn't be read as a ZIP file.`;

    const entryCount = tail.getUint16(eocd + 10, true);
    const dirSize = tail.getUint32(eocd + 12, true);
    const dirOffset = tail.getUint32(eocd + 16, true);

    // ZIP64 archives mark these fields as 0xFFFF or 0xFFFFFFFF (if over 4 GB)
    if (entryCount === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
        return `${fail} uses the ZIP64 format, which isn't supported. Please re-zip it to a conventional ZIP.`;
    }

    if (entryCount === 0) return `${fail} is empty.`;
    if (entryCount > MAX_ZIP_ENTRIES) return `${fail} has too many files (up to ${MAX_ZIP_ENTRIES}).`;
    if (dirOffset + dirSize > tailStart + eocd) return `${fail} couldn't be read as a ZIP file.`;

    const dir = new DataView(await file.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
    const decoder = new TextDecoder();
    const notAllowed = [];
    let pos = 0;
    let realFiles = 0;

    for (let n = 0; n < entryCount; n++) {
        if (pos + 46 > dir.byteLength || dir.getUint32(pos, true) !== 0x02014b50) {
            return `${fail} couldn't be read as a ZIP file.`;
        }

        const flags = dir.getUint16(pos + 8, true);
        const nameLength = dir.getUint16(pos + 28, true);
        const extraLength = dir.getUint16(pos + 30, true);
        const commentLength = dir.getUint16(pos + 32, true);
        const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + pos + 46, nameLength));
        pos += 46 + nameLength + extraLength + commentLength;

        if (name.endsWith("/") || ZIP_JUNK.some(re => re.test(name))) continue;

        // Encrypted files cannot be checked
        if (flags & 0x1) return `${fail} is password-protected. Please resubmit without a password.`;

        const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
        
        if (!ALLOWED_IN_ZIP.includes(ext)) {
            notAllowed.push(name.split("/").pop());
        }

        realFiles++;
    }

    if (realFiles === 0) return `${fail} has no included files inside it.`;

    if (notAllowed.length) {
        const shown = notAllowed.slice(0, 3).join(", ") + (notAllowed.length > 3 ? `, and ${notAllowed.length - 3} more` : "");
        return `${fail} contains files that aren't accepted (${shown}). Accepted inside a ZIP: ${ALLOWED_IN_ZIP.map(e => "." + e).join(", ")}`;
    }

    return null;
}

export async function handleSubmit(request, env) {
    if (request.method !== "POST") {
        return reply(405, "method not allowed.");
    }

    // Blocks script posting from other sites
    if (!allowedOrigin(request, env)) {
        return reply(403, "Submissions are only accepted from nateletext.com.");
    }

    const length = Number(request.headers.get("Content-Length") || 0);
    if (length > 100 * MB) {
        return reply(413);
    }

    let form;
    try {
        form = await request.formData();
    } catch {
        return reply(400, "The submission couldn't be read.");
    }

    const ip = request.headers.get("CF-Connecting-IP") || "";

    // Honeypot that will only affect bots. Pretend this works so bots do not adapt
    if (form.get("_gotcha")) {
        return reply(200);
    }

    // Turnstile. Token is single-use and inly valid for a few minutes
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET,
            response: form.get("cf-turnstile-response") || "",
            remoteip: ip,
        }),
    })
    .then(r => r.json())
    .catch(() => ({ success: false }));

    // An empty messages will make the "Add New Form" JS show its own "anti-spam check didn't pass" text
    if (!verify.success) return reply(403);

    // Files
    const files = form.getAll("submissionFile[]").filter(f => f instanceof File && f.size > 0);
    if (files.length === 0) {
        return reply(400, "No file was attached.");
    }

    if (files.length > MAX_FILES) {
        return reply(400, `Up to ${MAX_FILES} files can be sent at once.`);
    }

    let total = 0;

    for (const file of files) {
        const ext = file.name.split(".").pop().toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            return reply(400, `"${file.name}" isn't an accepted file type.`);
        }

        if (file.size > MAX_FILE_BYTES) {
            return reply(413);
        }

        if (!(await looksLikeItsExtension(file, ext))) {
            return reply(400, `"${file.name}" doesn't look like a real .${ext} file.`);
        }

        if (ext === "zip") {
            const problem = await checkZipContents(file);
            if (problem) {
                return reply(400, problem);
            }
        }

        total += file.size;
    }

    if (total > MAX_TOTAL_BYTES) {
        return reply(413);
    }

    // Forward to Formspree (only after every file has passed)
    form.delete("cf-turnstile-response");
    form.delete("_gotcha");
    form.set("submitterIP", ip); // * This will show in emails from Formspree

    const res = await fetch(`https://formspree.io/f/${env.FORMSPREE_ID}`, {
        method: "POST",
        body: form,
        headers: { Accept: "application/json" },
    });

    return new Response(await res.text(), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
    });
}