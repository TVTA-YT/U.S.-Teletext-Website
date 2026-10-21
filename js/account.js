window.NatAccount = (() => {
    const API_BASE = "";

    async function request(method, path, body) {
        const options = {
            method, credentials:
                "same-origin", headers: {}
        };

        if (body !== undefined) {
            options.headers["Content-Type"] = "application/json";
            options.body = JSON.stringify(body);
        }

        try {
            const response = await fetch(`${API_BASE}${path}`, options);
            const data = await response.json().catch(() => ({}));
            return {
                ok: response.ok,
                status: response.status,
                ...data

            };
        } catch {
            return {
                ok: false,
                status: 0,
                error: "Couldn't reach the server. Check your connection and try again."
            };
        }
    }

    async function getMe() {
        const result = await request("GET", "/api/auth/me");
        return result.ok ? result : { loggedIn: false };
    }

    async function signOut() {
        await request("POST", "/api/auth/logout");
    }

    function el(tag, attributes = {}, children = []) {
        const node = document.createElement(tag);

        for (const [key, value] of Object.entries(attributes)) {
            if (value === null || value === undefined || value === false) continue;
            if (key === "className") node.className = value;
            else if (key === "text") node.textContent = value;
            else node.setAttribute(key, value === true ? "" : value);
        }

        for (const child of [].concat(children)) {
            if (child === null || child === undefined) continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }

        return node;
    }

    function safeNextPage(value) {
        return /^[a-z0-9-]+\.html$/i.test(value ?? "") ? value : null;
    }

    return {
        get: path => request("GET", path),
        post: (path, body) => request("POST", path, body ?? {}),
        getMe,
        signOut,
        el,
        safeNextPage
    };
})();