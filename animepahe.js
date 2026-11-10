// =============================================================================
// AnimePahe Nuvio Plugin
// Compatible with NuvioTV PluginRuntime (QuickJS)
// Streams anime from animepahe.com / .pw / .org via the Cloudflare bypass proxy
// =============================================================================

const PROXY_URL = "https://animepaheproxy.phisheranimepahe.workers.dev/?url=";
const BASE_URL = "https://animepahe.com";

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: "https://animepahe.com/",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9"
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchText(url, opts = {}) {
    const headers = { ...HEADERS, ...(opts.headers || {}) };
    const target =
        opts.useProxy !== false ? PROXY_URL + encodeURIComponent(url) : url;
    const res = await fetch(target, { headers });
    if (!res.ok) {
        throw new Error("HTTP " + res.status + " " + target);
    }
    return await res.text();
}

async function fetchJson(url, opts = {}) {
    const text = await fetchText(url, opts);
    return JSON.parse(text);
}

/** Extract quality label like 1080p / 720p / 360p from button text. */
function extractQuality(text) {
    const m = String(text).match(/(\d{3,4}p)/);
    return m ? m[1] : "720p";
}

/** Detect Dub vs Sub from button text. */
function detectLanguage(text) {
    const t = String(text).toLowerCase();
    if (t.includes("dub")) return "Dub";
    if (t.includes("sub")) return "Sub";
    return "Sub";
}

/** Base-N encoder used by the JS packer unpacker. */
function baseN(n, base) {
    if (n < base) return String.fromCharCode(97 + n); // 'a'..'z'
    return baseN(Math.floor(n / base), base) + String.fromCharCode(97 + (n % base));
}

/**
 * Unpack JS-packed code:
 *   eval(function(p,a,c,k,e,d){...})
 */
function unpack(code) {
    try {
        const match = code.match(
            /}\((['"])([\s\S]*?)\1,\s*(\d+),\s*(\d+),\s*(['"])([\s\S]*?)\5\.split\((['"])\|\7\)/
        );
        if (!match) return code;

        let payload = match[2];
        const a = parseInt(match[3], 10);
        const b = parseInt(match[4], 10);
        const symbolList = match[6];

        payload = payload.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

        const symbols = symbolList.split("|");
        const dict = {};
        for (let i = 0; i < b; i++) {
            dict[baseN(i, a)] = symbols[i] || baseN(i, a);
        }

        return payload.replace(/\b\w+\b/g, (word) => dict[word]);
    } catch (e) {
        console.error("[AnimePahe] Unpack error:", e.message);
        return code;
    }
}

/**
 * Fetch a kwik.cx page, unpack its obfuscated player, and extract the m3u8 URL.
 */
async function extractKwik(kwikUrl, referer) {
    try {
        const html = await fetchText(kwikUrl, {
            headers: {
                ...HEADERS,
                Referer: referer + "/",
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            useProxy: true
        });

        const scriptTags = html.match(/<script[\s\S]*?<\/script>/g) || [];
        const packedBlocks = [];

        for (const script of scriptTags) {
            if (!script.includes("eval(function")) continue;
            let pos = 0;
            while (true) {
                const idx = script.indexOf("eval(function", pos);
                if (idx === -1) break;
                const splitIdx = script.indexOf("'.split('|'", idx);
                if (splitIdx === -1) break;
                const endIdx = script.indexOf("))", splitIdx);
                if (endIdx === -1) break;
                packedBlocks.push(script.substring(idx, endIdx + 2));
                pos = endIdx + 2;
            }
        }

        for (const block of packedBlocks) {
            const unpacked = unpack(block);
            const m = unpacked.match(
                /source\s*=\s*['"]([^'"]*m3u8[^'"]*)['"]/
            );
            if (m) {
                return {
                    url: m[1],
                    headers: {
                        Referer: "https://kwik.cx/",
                        Origin: "https://kwik.cx",
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    }
                };
            }
        }
    } catch (e) {
        console.error("[AnimePahe] Kwik extraction failed:", e.message);
    }
    return null;
}

/**
 * Look up the display title from TMDB so we can search animepahe by name.
 */
async function getTmdbTitle(tmdbId, mediaType) {
    try {
        const key =
            typeof TMDB_API_KEY !== "undefined" ? TMDB_API_KEY : "";
        if (!key) return null;

        const isMovie = mediaType === "movie";
        const url = `https://api.themoviedb.org/3/${
            isMovie ? "movie" : "tv"
        }/${tmdbId}?api_key=${key}&language=en-US`;
        const res = await fetchJson(url, { useProxy: false });
        return res.title || res.name || null;
    } catch (e) {
        console.error("[AnimePahe] TMDB lookup failed:", e.message);
        return null;
    }
}

/**
 * Search animepahe for a title. Returns the raw search response.
 */
async function searchAnime(query) {
    const url = BASE_URL + "/api?m=search&l=8&q=" + encodeURIComponent(query);
    return await fetchJson(url);
}

/**
 * Fetch all pages of the episode list for an anime and find the entry
 * matching the requested episode number.
 */
async function findEpisodeEntry(animeId, targetEpisode) {
    let totalPages = 1;

    const firstPage = await fetchJson(
        `${BASE_URL}/api?m=release&id=${animeId}&sort=episode_asc&page=1`
    );
    if (!firstPage || !Array.isArray(firstPage.data)) return null;

    totalPages = firstPage.total_pages || firstPage.total || 1;

    // Check page 1
    for (const ep of firstPage.data) {
        if (ep.episode == targetEpisode || ep.episode_number == targetEpisode) {
            return ep;
        }
    }

    // Check remaining pages
    for (let p = 2; p <= totalPages; p++) {
        const page = await fetchJson(
            `${BASE_URL}/api?m=release&id=${animeId}&sort=episode_asc&page=${p}`
        );
        if (!page || !Array.isArray(page.data)) break;
        for (const ep of page.data) {
            if (ep.episode == targetEpisode || ep.episode_number == targetEpisode) {
                return ep;
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Plugin entry point - Nuvio calls getStreams(tmdbId, mediaType, season, episode)
// ---------------------------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode) {
    const results = [];

    try {
        // 1. Resolve title from TMDB
        const title = await getTmdbTitle(tmdbId, mediaType);
        if (!title) {
            console.error("[AnimePahe] Could not resolve title from TMDB");
            return results;
        }

        // 2. Search animepahe
        const searchData = await searchAnime(title);
        if (!searchData || !searchData.data || searchData.data.length === 0) {
            console.error("[AnimePahe] No search results for:", title);
            return results;
        }

        // 3. Pick best matching anime
        let animeId = null;
        let animeTitle = title;

        for (const item of searchData.data) {
            const itemTitle = item.title || item.original_title || "";
            const lowerItem = itemTitle.toLowerCase();
            const lowerQuery = title.toLowerCase();
            if (
                lowerItem.includes(lowerQuery) ||
                lowerQuery.includes(lowerItem)
            ) {
                animeId = item.session;
                animeTitle = itemTitle;
                break;
            }
        }

        if (!animeId) {
            animeId = searchData.data[0].session;
            animeTitle =
                searchData.data[0].title ||
                searchData.data[0].original_title ||
                title;
        }

        // 4. Determine target episode number
        // Nuvio passes season + episode. AnimePahe uses absolute episode
        // numbering per series. For season 1, episode == absolute episode.
        // For later seasons we still request the absolute episode number
        // passed by Nuvio (PluginEpisodeRequestRules already converts anime
        // IDs like mal:X:Y to absolute Y when applicable).
        const targetEpisode = episode || 1;

        // 5. Find the episode entry across all pages
        const epEntry = await findEpisodeEntry(animeId, targetEpisode);
        if (!epEntry) {
            console.error(
                "[AnimePahe] Episode not found:",
                animeTitle,
                "ep",
                targetEpisode
            );
            return results;
        }

        const episodeSession = epEntry.session;
        if (!episodeSession) {
            console.error("[AnimePahe] Episode entry missing session id");
            return results;
        }

        // 6. Load the play page and parse resolution buttons
        const playUrl = `${BASE_URL}/play/${animeId}/${episodeSession}`;
        const playHtml = await fetchText(playUrl, { useProxy: true });

        const cheerio = require("cheerio");
        const $ = cheerio.load(playHtml);

        const streamPromises = [];

        $("#resolutionMenu button").each((_i, el) => {
            const $el = $(el);
            const dataSrc = $el.attr("data-src");
            const text = $el.text() || "";
            if (!dataSrc || !dataSrc.includes("kwik")) return;

            const quality = extractQuality(text);
            const lang = detectLanguage(text);

            streamPromises.push(
                (async () => {
                    try {
                        const kwik = await extractKwik(dataSrc, BASE_URL);
                        if (!kwik) return;

                        results.push({
                            url: kwik.url,
                            title: animeTitle + " - Episode " + targetEpisode,
                            name: "AnimePahe - " + quality + " " + lang,
                            quality: quality,
                            language: lang,
                            headers: kwik.headers,
                            provider: "AnimePahe",
                            type: "m3u8",
                            subtitles: [],
                            size: null,
                            infoHash: null,
                            seeders: null,
                            peers: null
                        });
                    } catch (e) {
                        console.error("[AnimePahe] Stream parse error:", e.message);
                    }
                })()
            );
        });

        await Promise.all(streamPromises);
    } catch (e) {
        console.error("[AnimePahe] getStreams error:", e.message, e.stack);
    }

    return results;
}

// Export for Nuvio PluginRuntime (wrapped in module.exports IIFE)
module.exports = { getStreams };
exports.getStreams = getStreams;
