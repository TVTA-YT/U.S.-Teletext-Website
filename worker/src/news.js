// ^ Browsers cache the public news responses for 1 minute, Cloudflare's edge for 5 minutes
const PUBLIC_CACHE = "public, max-age=60, s-maxage=300";

// & Same CORS headers as the rest of the API, plus PUT/DELETE for the admin routes
function newsHeaders(extra = {}) {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json; charset=utf-8",
        ...extra
    };
}

function newsJson(data, code = 200, extra = {}) {
    return new Response(JSON.stringify(data), { status: code, headers: newsHeaders(extra) });
}

// ^ Story IDs: same characters as today's <article> IDs
const STORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

// & Returns a Response for news routes, or null so the Index JS can keep routing
export async function handleNews(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const isNewsRoute = path === "/api/news" || path.startsWith("/api/news/") || path.startsWith("/api/admin/news");
    if (!isNewsRoute) return null;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: newsHeaders() });

    try {
        /*
        * API CALL: /api/news
        * This is called on the "Teletext News" page.
        * This fetches the list of published stories for the preview grid (no story bodies).
        */
        if (path === "/api/news" && request.method === "GET") {
            return await cached(request, ctx, async () => {
                const { results } = await env.NEWS_DB.prepare(`
                    SELECT id, date, title, author, summary, preview, preview_alt AS previewAlt, is_new AS isNew
                    FROM news_stories
                    WHERE published = 1
                    ORDER BY date DESC, updated_at DESC
                `).all();

                return newsJson(results.map(row => ({ ...row, isNew: !!row.isNew })), 200, { "Cache-Control": PUBLIC_CACHE });
            });
        }

        /*
        * API CALL: /api/news/<id>
        * This is called on the "Teletext News" page when a story is opened.
        */
        if (path.startsWith("/api/news/") && request.method === "GET") {
            const id = decodeURIComponent(path.slice("/api/news/".length));
            if (!STORY_ID_PATTERN.test(id)) return newsJson({ error: "Invalid story ID" }, 400);

            return await cached(request, ctx, async () => {
                const row = await env.NEWS_DB.prepare(`
                    SELECT id, date, title, author, body, is_new AS isNew
                    FROM news_stories
                    WHERE id = ? AND published = 1
                `).bind(id).first();

                if (!row) return newsJson({ error: "Story not found" }, 404);
                return newsJson({ ...row, isNew: !!row.isNew }, 200, { "Cache-Control": PUBLIC_CACHE });
            });
        }

        // ! Everything below is admin-only
        if (path.startsWith("/api/admin/news")) {
            if (!isNewsAdmin(request, env)) return newsJson({ error: "Forbidden" }, 403);

            /*
            * API CALL: PUT /api/admin/news-media/<story-id>/<file>
            ! Used by "Publish Story" MJS to upload a story's images
            */
            if (path.startsWith("/api/admin/news-media/") && request.method === "PUT") {
                const rel = decodeURIComponent(path.slice("/api/admin/news-media/".length));
                if (!/^[A-Za-z0-9_\-./]+$/.test(rel) || rel.includes("..")) return newsJson({ error: "Bad path" }, 400);

                const key = `news/${rel}`;
                await env.NEWS_MEDIA.put(key, request.body, {
                    httpMetadata: { contentType: request.headers.get("Content-Type") ?? "application/octet-stream" }
                });
                return newsJson({ ok: true, url: `${url.origin}/files/${key}` });
            }

            /*
            * API CALL: PUT /api/admin/news/<id>: create or update a story
            * API CALL: DELETE /api/admin/news/<id>: delete a story
            ! Used by "Publish Story" MJS (and later, the admin dashboard).
            */
            if (path.startsWith("/api/admin/news/")) {
                const id = decodeURIComponent(path.slice("/api/admin/news/".length));
                if (!STORY_ID_PATTERN.test(id)) return newsJson({ error: "Invalid story ID" }, 400);

                if (request.method === "PUT") {
                    const story = await request.json();
                    if (!story.date || !story.title || !story.body) {
                        return newsJson({ error: "date, title and body are required" }, 400);
                    }

                    await env.NEWS_DB.prepare(`
                        INSERT INTO news_stories (id, date, title, author, summary, preview, preview_alt, body, is_new, published, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
                        ON CONFLICT(id) DO UPDATE SET
                            date = ?2, title = ?3, author = ?4, summary = ?5, preview = ?6, preview_alt = ?7,
                            body = ?8, is_new = ?9, published = ?10, updated_at = datetime('now')
                    `).bind(
                        id, story.date, story.title, story.author ?? null, story.summary ?? null,
                        story.preview ?? null, story.previewAlt ?? "", story.body,
                        story.isNew ? 1 : 0, story.published === false ? 0 : 1
                    ).run();

                    await purgeNewsCache(url, id);
                    return newsJson({ ok: true, id });
                }

                if (request.method === "DELETE") {
                    await env.NEWS_DB.prepare(`DELETE FROM news_stories WHERE id = ?`).bind(id).run();
                    await purgeNewsCache(url, id);
                    return newsJson({ ok: true, id });
                }
            }
        }

        return newsJson({ error: "Method not allowed" }, 405);
    } catch (error) {
        console.error("Request failed:", error);
        return newsJson({ error: `Request failed: ${error.message}` }, 500);
    }
}

// & Same secret as the gallery generator. This will later check for admin sign-in
function isNewsAdmin(request, env) {
    const auth = request.headers.get("Authorization") ?? "";
    return Boolean(env.ADMIN_KEY) && auth === `Bearer ${env.ADMIN_KEY}`;
}

// & Serve from Cloudflare's edge cache when possible
async function cached(request, ctx, produce) {
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;

    const response = await produce();
    if (response.ok) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
}

// & Clear the cached list and story so a publish shows up immediately
async function purgeNewsCache(url, id) {
    const cache = caches.default;
    await Promise.all([
        cache.delete(new Request(`${url.origin}/api/news`)),
        cache.delete(new Request(`${url.origin}/api/news/${encodeURIComponent(id)}`))
    ]);
}