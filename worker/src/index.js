// Show new records for 7 days
const NEW_WINDOW_DAYS = 7;
const NEW_WINDOW_SECONDS = NEW_WINDOW_DAYS * 24 * 60 * 60;

// Dataset configurations
const tables = {
    abcPlus: {
        table: "ABC_PLUS",
        idField: "ID",
        type: "nonTeletext",
        sampleCondition: `TEXT1 IS NOT NULL AND TRIM(CAST(TEXT1 AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Affiliate", "Program_Title", "Tape_Type", "Tape_Speed", "TEXT1", "TEXT2", "Network", "Service_Name", "Notes", "Recovered_By", "Date_Added"]
    },
    datavizion: {
        table: "DaTaVizion",
        idField: "ID",
        type: "teletext",
        sampleCondition: `Download_Link IS NOT NULL AND TRIM(CAST(Download_Link AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Program_Title", "Tape_Type", "Tape_Speed", "Download_Link", "Thumbnail", "Network", "Service_Name", "Notes", "Date_Added", "Recovered_By", "IA_ID"]
    },
    electra: {
        table: "Electra",
        idField: "ID",
        type: "teletext",
        sampleCondition: `Download_Link IS NOT NULL AND TRIM(CAST(Download_Link AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Program_Title", "Tape_Type", "Tape_Speed", "Download_Link", "Thumbnail", "Network", "Service_Name", "Notes", "Date_Added", "Recovered_By", "IA_ID"]
    },
    extravision: {
        table: "ExtraVision",
        idField: "ID",
        type: "teletext",
        sampleCondition: `Download_Link IS NOT NULL AND TRIM(CAST(Download_Link AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Affiliate", "Program_Title", "Tape_Type", "Tape_Speed", "Download_Link", "Thumbnail", "Network", "Service_Name", "Notes", "Date_Added", "Recovered_By", "IA_ID"]
    },
    iptvAgids: {
        table: "IPTV_AGIDS",
        idField: "ID",
        type: "nonTeletext",
        sampleCondition: `TEXT1 IS NOT NULL AND TRIM(CAST(TEXT1 AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Program_Title", "Tape_Type", "Tape_Speed", "TEXT1", "TEXT2", "Network", "Service_Name", "Notes", "Recovered_By", "Date_Added"]
    },
    ketAgtext: {
        table: "KET_AgText",
        idField: "ID",
        type: "nonTeletext",
        sampleCondition: `HTML_Link IS NOT NULL AND TRIM(CAST(HTML_Link AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Program_Title", "Tape_Type", "Tape_Speed", "HTML_Link", "Network", "Service_Name", "Notes", "Recovered_By", "Date_Added"]
    },
    keyfax: {
        table: "Keyfax",
        idField: "ID",
        type: "teletext",
        sampleCondition: `Download_Link IS NOT NULL AND TRIM(CAST(Download_Link AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Program_Title", "Tape_Type", "Tape_Speed", "Download_Link", "Thumbnail", "Network", "Service_Name", "Notes", "Date_Added", "Recovered_By", "IA_ID"]
    },
    nbcTeletext: {
        table: "NBC_Teletext",
        idField: "ID",
        type: "teletext",
        sampleCondition: `Download_Link IS NOT NULL AND TRIM(CAST(Download_Link AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Affiliate", "Program_Title", "Tape_Type", "Tape_Speed", "Download_Link", "Thumbnail", "Network", "Service_Name", "Notes", "Date_Added", "Recovered_By", "IA_ID"]
    },
    sssTeletext: {
        table: "SSS_Teletext",
        idField: "ID",
        type: "teletext",
        sampleCondition: `Download_Link IS NOT NULL AND TRIM(CAST(Download_Link AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Program_Title", "Tape_Type", "Tape_Speed", "Download_Link", "Thumbnail", "Network", "Service_Name", "Notes", "Date_Added", "Recovered_By", "IA_ID"]
    },
    wisconsinInfotext: {
        table: "Wis_Infotext",
        idField: "ID",
        type: "nonTeletext",
        sampleCondition: `TEXT1 IS NOT NULL AND TRIM(CAST(TEXT1 AS TEXT)) != ''`,
        columns: ["ID", "Year", "Month", "Date", "Program_Title", "Tape_Type", "Tape_Speed", "TEXT1", "TEXT2", "Network", "Service_Name", "Notes", "Recovered_By", "Date_Added"]
    }
};


/* RESPONSE HELPER FUNCTIONS */

// Let any website make requests to the API
function corsHeader() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json; charset=utf-8"
    };
}

// Convert the data to JSON, set HTTP status, set JSON content type, and add CORS headers
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: corsHeader() });
}

// Error response
function errorResponse(message, status = 500) {
    return jsonResponse({ error: message }, status);
}


/* FINDING THE DATASET */

// Recognize the URL-safe name or actual table name
function getDatasetConfig(datasetName) {
    const normalizedName = String(datasetName ?? "").trim().toLowerCase();

    const entry = Object.entries(tables).find(
        ([key, config]) => key.toLowerCase() === normalizedName || config.table.toLowerCase() === normalizedName
    );

    return entry ? entry[1] : null;
}


/* EXPORT INDIVIDUAL DATASET */

// Build dynamic SQL query
async function exportTable(db, config) {
    const now = Math.floor(Date.now() / 1000);
    const columns = config.columns.map(column => `t.${column}`).join(", ");

    // SQL statement
    const sql = `
        SELECT ${columns}
        FROM ${config.table} AS t
        ORDER BY t.Year, t.Date
    `;

    const result = await db.prepare(sql).all();

    // Loop over each row to see if it's new
    return result.results.map(row => {
        let isNew = false;

        // If date exists and is valid, create JavaScript Date object
        if (row.Date_Added !== null && row.Date_Added !== undefined) {
            const dateAdded = new Date(row.Date_Added);

            // Make sure the date is valid
            if (!Number.isNaN(dateAdded.getTime())) {

                // Convert the date to UNIX seconds by converting JS Date object to use seconds
                const dateAddedSeconds = Math.floor(dateAdded.getTime() / 1000);

                // Calculate the age of the record and determine if its within the 7-day "new" period
                const age = now - dateAddedSeconds;
                isNew = age >= 0 && age <= NEW_WINDOW_SECONDS;
            }
        }

        return { ...row, isNew };
    });
}


/* ELECTRA/KEYFAX TRIVIA */

// Function for Electra/Keyfax trivia pages
async function getElectraKeyfaxTrivia(db) {
    const { results } = await db.prepare(`
        SELECT
            IA_ID AS iaID,
            Year AS year,
            Date_Caption AS caption,
            Contributor AS contributor,
            Image_URL AS imageURL
        FROM Electra_Keyfax_Trivia
        ORDER BY Date_Caption ASC
        `).all();

    return results;
}


/* DATASET COUNTS */

// Calculate statistics for every dataset
async function getAllCounts(db) {
    const entries = Object.entries(tables);

    // Each query only needs to return two numbers: total records and available samples.
    const statements = entries.map(([, config]) => db.prepare(`
        SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ${config.sampleCondition} THEN 1 ELSE 0 END), 0) AS availableSamples
        FROM ${config.table}
    `));

    const results = await db.batch(statements);
    const counts = {};

    entries.forEach(([datasetName], index) => {
        const row = results[index].results[0];
        counts[datasetName] = {
            total: Number(row?.total ?? 0),
            availableSamples: Number(row?.availableSamples ?? 0)
        };
    });

    // Calculate total number of teletext and text samples
    function sumByType(type) {
        return entries.reduce((totals, [datasetName, config]) => {

            // Make sure the current dataset falls within teletext or text (e.g. "ABC PLUS" shouldn't be a teletext service)
            if (config.type !== type) return totals;
            const dataset = counts[datasetName];

            /*
            - Add totals from all teletext and text tables
            - NOTE: " ?. " is optional chaining. Basically, if a dataset exists, return the total. Otherwise, do not crash
            - Nullish coalescing operator ( ?? ): if value is null or undefined, use 0
            */
            totals.total += dataset?.total ?? 0;

            // Add available samples
            totals.availableSamples += dataset?.availableSamples ?? 0;
            return totals;
        }, { total: 0, availableSamples: 0 });
    }

    return {
        teletext: sumByType("teletext"),
        nonTeletext: sumByType("nonTeletext"),
        datasets: counts
    };
}


/* RECENT ADDITIONS */

// Find recently added records
async function getRecentFromDataset(db, config) {

    // The homepage widget only needs Date, Date_Added, and (when present) IA_ID
    // Text service tables do not have an IA ID, so it's only added when "config.columns" actually lists it
    const selectColumns = ["Date", "Date_Added"];
    if (config.columns.includes("IA_ID")) selectColumns.push("IA_ID");

    const columns = selectColumns.map(column => `t.${column}`).join(", ");

    const sql = `
        SELECT ${columns}
        FROM ${config.table} AS t
        WHERE t.Date_Added IS NOT NULL
            AND TRIM(CAST(t.Date_Added AS TEXT)) != ''
            AND LOWER(TRIM(CAST(t.Date_Added AS TEXT))) != 'null'
            AND LOWER(TRIM(CAST(t.Date_Added AS TEXT))) != 'n/a'
        ORDER BY t.Date_Added DESC
        LIMIT 10
    `;

    const result = await db.prepare(sql).all();
    return result.results;
}

// Figure out the 10 newest records across all datasets
async function getRecentAdditions(db) {
    const entries = Object.entries(tables);

    // Run the queries concurrently
    const datasetResults = await Promise.all(entries.map(async ([datasetName, config]) => {
        const rows = await getRecentFromDataset(db, config);
        return rows.map(row => ({ ...row, __dataset: datasetName }));
    }));

    const allRecentRows = datasetResults.flat();

    // Sort by Date_Added
    allRecentRows.sort((a, b) => new Date(b.Date_Added).getTime() - new Date(a.Date_Added).getTime());

    // Return the 10 newest additions
    return allRecentRows.slice(0, 10).map(row => {
        delete row.__dataset;
        return row;
    });
}


/* R2 GALLERY MANIFEST */

// Generate Cloudflare R2 object path
function galleryKey(identifier) {
    return `gallery/gallery-${identifier}.json`;
}

// Get gallery manifests
async function getGalleryManifest(env, identifier) {
    const object = await env.GALLERY.get(galleryKey(identifier));
    if (!object) return null;
    return await object.json();
}

// Only these tables will have manifests. First regex is used to control acceptable images. Second regex looks for the ZIP file
const GALLERY_TABLES = ["DaTaVizion", "Electra", "ExtraVision", "Keyfax", "NBC_Teletext", "SSS_Teletext"];
const GALLERY_FILE_PATTERN = /^(?:Record-\d+-\d+(?:-\d+)?-v[A-Za-z0-9]+|Page-\d+-\d+)\.(?:png|jpg|jpeg|gif)$/i;
const GALLERY_ZIP_PATTERN = /\.zip$/i;

// Get metadata from IA
async function fetchIaMetadata(identifier) {
    const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error(`Internet Archive metadata returned HTTP ${response.status}`);

    const data = await response.json();

    if (!data || !Array.isArray(data.files)) throw new Error(`Malformed Internet Archive metadata for ${identifier}`);

    return data;
}

// Query all tables to find IA ID
async function getGalleryIdentifiers(db) {
    const statements = GALLERY_TABLES.map(table => db.prepare(`
        SELECT DISTINCT IA_ID FROM ${table}
        WHERE IA_ID IS NOT NULL AND TRIM(CAST(IA_ID AS TEXT)) != ''
    `));

    const results = await db.batch(statements);
    // Create an empty unique collection. Eliminate duplicates
    const identifiers = new Set();

    // Go through each database query result one at a time
    for (const result of results) {

        // Go through each row from each table. Return empty array if nothing exists
        for (const row of result.results ?? []) {

            // If no ID, return an empty string
            const identifier = String(row.IA_ID ?? "").trim();

            // If identifier exists, add it
            if (identifier) identifiers.add(identifier);
        }
    }

    // Spread values fom "Set()" into a new array
    return [...identifiers];
}

// Look through each table for IA ID
async function getGalleryDatabase(db, identifier) {
    for (const table of GALLERY_TABLES) {
        // Retrieve values from these columns
        const result = await db.prepare(`
            SELECT Recovered_By, Program_Title, Date, Service_Name, Network
            FROM ${table}
            WHERE IA_ID = ?
            LIMIT 1
        `).bind(identifier).all();

        if (result.results?.length) return result.results[0];
    }

    return { Recovered_By: null, Program_Title: null, Date: null, Service_Name: null, Network: null };
}

// Building the image URL
function buildZipEntryUrl(identifier, zipFilename, entryPath) {
    const segments = entryPath.split("/").map(segment => encodeURIComponent(segment));
    return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(zipFilename)}/${segments.join("/")}`;
}

// Download specific byte range
async function fetchByteRange(url, start, end) {
    const response = await fetch(url, { headers: { "Range": `bytes=${start}-${end}` } });

    if (response.status !== 206) throw new Error(`Range requests failed: HTTP ${response.status} (${start}-${end})`);

    // Return raw binary response
    return new Uint8Array(await response.arrayBuffer());
}

// Get the file size of the ZIP
async function fetchRemoteFileSize(url) {
    const response = await fetch(url, { headers: { "Range": "bytes=0-0" } });

    if (response.status !== 206) throw new Error(`Range probe failed: HTTP ${response.status}`);

    const contentRange = response.headers.get("Content-Range");
    if (!contentRange) throw new Error("No Content-Range header returned");

    const match = contentRange.match(/\/(\d+)$/);
    if (!match) throw new Error(`Could not parse Content-Range: ${contentRange}`);

    return Number(match[1]);
}


/* LOCATING AND PARSING ZIP */

// Find the ZIP's End of Central Directory (EOCD) record and extract information about the Central Directory
function locateEocd(buffer) {

    // Hexadecimal bytes that identify the EOCD record
    const signature = [0x50, 0x4b, 0x05, 0x06];

    // Search backwards through the buffer. Minimum EOCD structure is 22.
    for (let i = buffer.length - 22; i >= 0; i--) {

        // These four bytes must match the EOCD hexadecimal values
        if (buffer[i] === signature[0] && buffer[i + 1] === signature[1] && buffer[i + 2] === signature[2] && buffer[i + 3] === signature[3]) {

            // Interpret specific bytes as numbers
            const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

            // Return number of files in the ZIP, the number of bytes in the Central Directory, and where it starts in the ZIP
            return {
                entryCount: view.getUint16(i + 10, true),
                cdSize: view.getUint32(i + 12, true),
                cdOffset: view.getUint32(i + 16, true)
            };
        }
    }

    return null;
}

// Read the Central Directory and extract the filename of every file in the ZIP
function parseCentralDirectoryFilenames(buffer, entryCount) {
    const decoder = new TextDecoder();
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const filenames = [];
    let offset = 0;

    for (let i = 0; i < entryCount; i++) {
        if (offset + 46 > buffer.length) break;

        // Check to see if valid Central Directory entry
        const signature = view.getUint32(offset, true);
        if (signature !== 0x02014b50) break;

        /*
        - Get how many bytes long the filename is.
        - Look for additional metadata and its length.
        - Look for comments and their length.
        - Filename starts 46 bytes after the beginning of the Central Directory entry.
        - Calculate where filename ends
        */
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const nameStart = offset + 46;
        const nameEnd = nameStart + nameLength;

        // Turn bytes into string
        filenames.push(decoder.decode(buffer.slice(nameStart, nameEnd)));

        // Move to next entry
        offset = nameEnd + extraLength + commentLength;
    }

    return filenames;
}

// Call previous functions to generate
async function fetchZipEntries(identifier, zipFilename) {
    const zipUrl = "https://archive.org/download/" + encodeURIComponent(identifier) + "/" + encodeURIComponent(zipFilename);

    // Find the ZIP's size, get the end, and download the tail
    const fileSize = await fetchRemoteFileSize(zipUrl);
    const tailSize = Math.min(fileSize, 65557);
    const tail = await fetchByteRange(zipUrl, fileSize - tailSize, fileSize - 1);

    // Find the EOCD
    const eocd = locateEocd(tail);
    if (!eocd) throw new Error(`Could not locate ZIP EOCD for ${zipFilename}`);

    // Throw error is ZIP64
    if (eocd.entryCount === 0xffff || eocd.cdOffset === 0xffffffff) throw new Error(`ZIP64 is not supported: ${zipFilename}`);
    if (eocd.cdSize <= 0) return [];

    // Download the Central Directory, not the entire ZIP
    const centralDirectory = await fetchByteRange(zipUrl, eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1);

    // Parse the binary Central Directory into a list of filenames excluding directory entries
    return parseCentralDirectoryFilenames(centralDirectory, eocd.entryCount).filter(filename => !filename.endsWith("/"));
}

// Loop over all image files from IA to build the image gallery list
async function buildGalleryImageList(identifier, files) {
    const images = [];

    for (const file of files) {
        const filename = file?.name ?? "";

        // Ignore anything that isn't a ZIP file
        if (!GALLERY_ZIP_PATTERN.test(filename)) continue;

        console.log(`Expanding ZIP ${identifier}/${filename}`);
        const entries = await fetchZipEntries(identifier, filename);

        // Loop through each ZIP entry and split the path wherever " / " is present
        for (const entryPath of entries) {
            const parts = entryPath.split("/");

            // Only return the filename
            const baseName = parts[parts.length - 1];

            // Check filename against accepted pattern
            if (!GALLERY_FILE_PATTERN.test(baseName)) continue;

            // Only push images with matching filenames
            images.push({ filename: baseName, url: buildZipEntryUrl(identifier, filename, entryPath) });
        }
    }

    return images;
}


/* GENERATING GALLERY MANIFESTS */

// Generate the image gallery manifest
async function generateGalleryManifest(env, identifier) {

    // Get the files, information about the record, and the relevant images
    const metadata = await fetchIaMetadata(identifier);
    const databaseMeta = await getGalleryDatabase(env.DB, identifier);
    const images = await buildGalleryImageList(identifier, metadata.files);

    if (images.length === 0) throw new Error(`No matching images found for ${identifier}`);

    // Create the manifest key/value pair
    const manifest = {
        identifier,
        recovered_by: databaseMeta.Recovered_By ?? null,
        program_title: databaseMeta.Program_Title ?? null,
        date: databaseMeta.Date ?? null,
        service: databaseMeta.Service_Name ?? null,
        network: databaseMeta.Network ?? null,
        images
    };

    await env.GALLERY.put(galleryKey(identifier), JSON.stringify(manifest, null, 4), {
        httpMetadata: { contentType: "application/json; charset=utf-8" }
    });

    return manifest;
}

// Check if manifest already exists
async function generateSingleGallery(env, identifier, force) {
    const key = galleryKey(identifier);

    // Generate a new manifest if forced; if not forcing, skip generation if manifest exists
    if (!force) {
        const existing = await env.GALLERY.head(key);
        if (existing) return { status: "skipped", reason: "Manifest already exists", identifier, key };
    }

    const manifest = await generateGalleryManifest(env, identifier);

    return { status: "generated", identifier, key, imageCount: manifest.images.length };
}

// Generate all galleries
async function generateAllGalleries(env, force = false) {
    const identifiers = await getGalleryIdentifiers(env.DB);
    const generated = [];
    const skipped = [];
    const failed = [];

    // ! NOTE: This prevents a bulk run from creating a huge burst of simultaneous requests to IA.
    for (const identifier of identifiers) {
        const key = galleryKey(identifier);

        try {
            if (!force) {
                const existing = await env.GALLERY.head(key);
                if (existing) {
                    skipped.push(identifier);
                    continue;
                }
            }

            console.log(`Generating gallery ${identifier}`);
            const manifest = await generateGalleryManifest(env, identifier);
            generated.push({ identifier, imageCount: manifest.images.length });
        } catch (error) {
            console.error(`Gallery generation failed for ${identifier}:`, error);
            failed.push({ identifier, error: error.message });
        }
    }

    return {
        totalIdentifiers: identifiers.length,
        generatedCount: generated.length,
        skippedCount: skipped.length,
        failedCount: failed.length,
        generated,
        skipped,
        failed
    };
}


/* API REQUEST HANDLER */

// API router function
async function handleApi(request, env) {
    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeader() });
    }

    if (request.method !== "GET") {
        return errorResponse("Method not allowed", 405);
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/api") {
        return jsonResponse({ status: "ok" });
    }

    /*
    * API CALL: /api/electra-keyfax-trivia
    * This is called on the "Electra Trivia Pages" page.
    * This fetches all trivia pages found from submitted Electra samples.
    * Note that while Keyfax is listed, there are no trivia pages from Keyfax currently.
    */
    if (url.pathname === "/api/electra-keyfax-trivia") {
        try {
            const triviaPages = await getElectraKeyfaxTrivia(env.DB);
            return jsonResponse(triviaPages);
        } catch (error) {
            console.error("D1 Electra/Keyfax query failed:", error);
            return errorResponse(`Electra/Keyfax query failed: ${error.message}`, 500);
        }
    }

    /*
     * API CALL: /api/counts
     * This is called on the "Other Text Services" and "Services" pages.
     * This fetches the total number of available samples from each database table.
     * It also fetches the total number of teletext and text service samples.
     */
    if (url.pathname === "/api/counts") {
        try {
            const counts = await getAllCounts(env.DB);
            return jsonResponse(counts);
        } catch (error) {
            console.error("D1 counts query failed:", error);
            return errorResponse(`Database counts query failed: ${error.message}`, 500);
        }
    }

    /*
    * API CALL: /api/recent-additions
    * This is called on the homepage.
    * This fetches the ten most recent additions across all the database tables.
    */
    if (url.pathname === "/api/recent-additions") {
        try {
            const recent = await getRecentAdditions(env.DB);
            return jsonResponse(recent);
        } catch (error) {
            console.error("D1 recent additions query failed:", error);
            return errorResponse(`Database recent additions query failed: ${error.message}`, 500);
        }
    }

    /*
    * API CALL: /api/gallery/generate
    ! This is not meant to be used by the end user.
    ! This is used to generate a manifest for a new record.
    */
    if (url.pathname.startsWith("/api/gallery/generate/")) {
        const identifier = decodeURIComponent(url.pathname.slice("/api/gallery/generate/".length)).trim();

        if (!identifier) return errorResponse("Missing Internet Archive identifier", 400);

        // This is optional. This would be used to force updates to a specific manifest
        const force = url.searchParams.get("force") === "1";

        try {
            const result = await generateSingleGallery(env, identifier, force);
            return jsonResponse(result);
        } catch (error) {
            console.error(`Gallery generation failed for ${identifier}:`, error);
            return errorResponse(`Gallery generation failed: ${error.message}`, 500);
        }
    }

    /*
    * API CALL: /api/gallery-generate-all
    ! This is not meant to be used by the end user.
    ! This was used to generate all manifests for each record before pushing the code to the site.
    */
    if (url.pathname === "/api/gallery/generate-all") {

        // Again, this is optional; used to force updates to all manifests
        const force = url.searchParams.get("force") === "1";

        try {
            const result = await generateAllGalleries(env, force);
            return jsonResponse(result);
        } catch (error) {
            console.error("Bulk gallery generation failed:", error);
            return errorResponse(`Bulk gallery generation failed: ${error.message}`, 500);
        }
    }

    // Call the "getGalleryManifest" function and return the JSON manifest
    if (url.pathname.startsWith("/api/gallery/")) {
        const identifier = decodeURIComponent(url.pathname.slice("/api/gallery/".length)).trim();

        if (!identifier) return errorResponse("Missing Internet Archive identifier", 400);

        try {
            const manifest = await getGalleryManifest(env, identifier);
            if (!manifest) return errorResponse("Gallery manifest not found", 404);
            return jsonResponse(manifest);
        } catch (error) {
            console.error("Gallery manifest lookup failed:", error);
            return errorResponse(`Gallery manifest lookup failed: ${error.message}`, 500);
        }
    }

    // Dataset endpoints
    if (!url.pathname.startsWith("/api/")) {
        return errorResponse("Not found", 404);
    }

    const datasetName = url.pathname.slice("/api/".length).split("/")[0];
    const config = getDatasetConfig(datasetName);

    if (!config) return errorResponse(`Unknown dataset: ${datasetName}`, 404);

    try {
        const rows = await exportTable(env.DB, config);
        return jsonResponse(rows);
    } catch (error) {
        console.error(`D1 query failed for ${config.table}:`, error);
        return errorResponse(`Database query failed for ${config.table}: ${error.message}`, 500);
    }
}

// Cloudflare Worker entry point
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
            return handleApi(request, env);
        }

        // Getting TEXT service HTML files from R2
        const key = url.pathname.replace(/^\/+/, "");

        const object = await env.TEXT_ARCHIVE.get(key);
        if (!object) return new Response("Not found", { status: 404 });

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);

        if (!headers.has("content-type")) {
            headers.set("content-type", "text/html; charset=utf-8");
        }

        return new Response(object.body, { headers });
    }
};