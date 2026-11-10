// =============================================================================
// AnimePahe - NuvioTV plugin (QuickJS / PluginRuntime)
//
// Pipeline:
//   TMDB (title + season layout)
//     -> AnimePahe search
//     -> season/part aware episode selection
//     -> release list (/api?m=release) -> episode session
//     -> play page (/play/<animeSession>/<episodeSession>)
//     -> kwik.cx player -> packed JS -> .m3u8
//
// AnimePahe is reached directly first (that is how the site is meant to be
// used and it works from residential/mobile networks). The configured
// Cloudflare-bypass proxy is only used as a fallback for animepahe URLs,
// because the proxy rejects every host that does not contain "animepahe".
// kwik.cx and uwucdn.top are always fetched directly.
// =============================================================================

var PROXY_URL = "https://animepaheproxy.phisheranimepahe.workers.dev/?url=";
var BASE_URL = "https://animepahe.pw";
var TMDB_BASE = "https://api.themoviedb.org/3";

var UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

var AP_HEADERS = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BASE_URL + "/"
};

// Headers the kwik/uwucdn player requires. Without Referer kwik.cx the CDN
// answers 403 from Cloudflare.
var PLAYBACK_HEADERS = {
    "User-Agent": UA,
    Referer: "https://kwik.cx/",
    Origin: "https://kwik.cx",
    Accept: "*/*"
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function attr(tag, name) {
    var re = new RegExp(name + '\\s*=\\s*"([^"]*)"', "i");
    var m = tag.match(re);
    if (m) return m[1];
    re = new RegExp(name + "\\s*=\\s*'([^']*)'", "i");
    m = tag.match(re);
    return m ? m[1] : null;
}

function decodeEntities(value) {
    return String(value == null ? "" : value)
        .replace(/&amp;/g, "&")
        .replace(/&#0*38;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'");
}

function isCloudflareBlock(text) {
    if (!text) return false;
    var t = String(text);
    return (
        t.indexOf("Just a moment") !== -1 ||
        t.indexOf("Sorry, you have been blocked") !== -1 ||
        t.indexOf("Attention Required! | Cloudflare") !== -1 ||
        t.indexOf("cf-error-details") !== -1
    );
}

function normTitle(value) {
    return String(value == null ? "" : value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Fetch an AnimePahe URL. Direct first, proxy as fallback.
 */
async function apGet(url, extraHeaders) {
    var headers = Object.assign({}, AP_HEADERS, extraHeaders || {});

    var directStatus = 0;
    try {
        var res = await fetch(url, { headers: headers });
        var text = await res.text();
        directStatus = res.status;
        if (res.ok && !isCloudflareBlock(text)) return text;
    } catch (e) {
        console.error("[AnimePahe] direct request failed:", e && e.message);
    }

    var proxied = PROXY_URL + encodeURIComponent(url);
    try {
        var res2 = await fetch(proxied, { headers: headers });
        var text2 = await res2.text();
        if (res2.ok && !isCloudflareBlock(text2)) return text2;
        throw new Error("proxy HTTP " + res2.status);
    } catch (e2) {
        throw new Error(
            "AnimePahe request failed (direct " +
                directStatus +
                ", proxy " +
                ((e2 && e2.message) || "error") +
                "): " +
                url
        );
    }
}

async function apJson(url, extraHeaders) {
    return JSON.parse(await apGet(url, extraHeaders));
}

async function tmdbJson(path) {
    var key = typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY ? TMDB_API_KEY : "";
    if (!key) throw new Error("TMDB_API_KEY is not configured in the Nuvio build");
    var url =
        TMDB_BASE +
        path +
        (path.indexOf("?") === -1 ? "?" : "&") +
        "api_key=" +
        encodeURIComponent(key) +
        "&language=en-US";
    var res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("TMDB HTTP " + res.status);
    return await res.json();
}

// ---------------------------------------------------------------------------
// Packed-player unpacker (dean.edwards packer, base-a alphabet)
// ---------------------------------------------------------------------------

/** Read a JS string literal starting at `start`; returns raw (still escaped) value. */
function readJsString(src, start) {
    var quote = src.charAt(start);
    if (quote !== "'" && quote !== '"') return null;
    var i = start + 1;
    while (i < src.length) {
        var ch = src.charAt(i);
        if (ch === "\\") {
            i += 2;
            continue;
        }
        if (ch === quote) return { value: src.substring(start + 1, i), end: i + 1 };
        i++;
    }
    return null;
}

/** Decode the escape sequences of a JS string literal. */
function unescapeJsString(str) {
    var out = "";
    for (var i = 0; i < str.length; i++) {
        var ch = str.charAt(i);
        if (ch !== "\\") {
            out += ch;
            continue;
        }
        var next = str.charAt(++i);
        if (next === "n") out += "\n";
        else if (next === "r") out += "\r";
        else if (next === "t") out += "\t";
        else if (next === "b") out += "\b";
        else if (next === "f") out += "\f";
        else if (next === "v") out += "\v";
        else if (next === "0") out += "\0";
        else if (next === "x") {
            out += String.fromCharCode(parseInt(str.substring(i + 1, i + 3), 16));
            i += 2;
        } else if (next === "u") {
            out += String.fromCharCode(parseInt(str.substring(i + 1, i + 5), 16));
            i += 4;
        } else if (next === "\n") {
            // line continuation
        } else {
            out += next;
        }
    }
    return out;
}

/** Packer alphabet: 0-9, a-z, then A-Z for base 62. */
function packerBase(num, base) {
    var prefix = num < base ? "" : packerBase(Math.floor(num / base), base);
    var digit = num % base;
    return prefix + (digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36));
}

/**
 * Unpack one `eval(function(p,a,c,k,e,d){...}('...',a,c,'...'.split('|'),0,{}))`
 * block into readable JS.
 */
function unpackPackedBlock(block) {
    var marker = block.indexOf("}(");
    if (marker === -1) return null;
    var i = marker + 2;

    var pLit = readJsString(block, i);
    if (!pLit) return null;
    i = pLit.end;

    var nums = block.substring(i).match(/^\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*/);
    if (!nums) return null;
    var base = parseInt(nums[1], 10);
    var count = parseInt(nums[2], 10);
    if (!base || !count) return null;
    i += nums[0].length;

    var kLit = readJsString(block, i);
    if (!kLit) return null;

    var payload = unescapeJsString(pLit.value);
    var words = unescapeJsString(kLit.value).split("|");

    var dict = {};
    for (var n = 0; n < count; n++) {
        var token = packerBase(n, base);
        dict[token] = words[n] || token;
    }

    return payload.replace(/\b\w+\b/g, function (word) {
        return dict[word] !== undefined ? dict[word] : word;
    });
}

/** Collect every packed player block in an HTML page. */
function extractPackedBlocks(html) {
    var blocks = [];
    var markers = [".split('|'),0,{}))", '.split("|"),0,{}))'];
    var pos = 0;

    while (true) {
        var start = html.indexOf("eval(function", pos);
        if (start === -1) break;

        var end = -1;
        var markerLength = 0;
        for (var i = 0; i < markers.length; i++) {
            var candidate = html.indexOf(markers[i], start);
            if (candidate !== -1 && (end === -1 || candidate < end)) {
                end = candidate;
                markerLength = markers[i].length;
            }
        }
        if (end === -1) break;

        blocks.push(html.substring(start, end + markerLength));
        pos = end + markerLength;
    }
    return blocks;
}

/** Extract the HLS playlist from a kwik player page. */
function findM3u8(html) {
    var blocks = extractPackedBlocks(html);

    for (var i = 0; i < blocks.length; i++) {
        var code = unpackPackedBlock(blocks[i]);
        if (!code) continue;

        var m = code.match(/https?:\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/);
        if (m) return m[0];

        var rel = code.match(/\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/);
        if (rel) return "https:" + rel[0];
    }

    // Last resort: the playlist may be present in the raw page.
    var raw = html.match(/https?:\/\/[^\s'"\\<>]+?\.m3u8[^\s'"\\<>]*/);
    return raw ? raw[0] : null;
}

/** Resolve a kwik.cx embed page to a playable m3u8 + required headers. */
async function resolveKwik(kwikUrl) {
    var headers = Object.assign({}, AP_HEADERS, {
        Accept: "*/*",
        Referer: BASE_URL + "/"
    });
    var res = await fetch(kwikUrl, { headers: headers });
    if (!res.ok) {
        console.error("[AnimePahe] kwik HTTP " + res.status + " " + kwikUrl);
        return null;
    }
    var html = await res.text();
    if (isCloudflareBlock(html)) {
        console.error("[AnimePahe] kwik blocked by Cloudflare: " + kwikUrl);
        return null;
    }
    var m3u8 = findM3u8(html);
    if (!m3u8) {
        console.error("[AnimePahe] no m3u8 in kwik page: " + kwikUrl);
        return null;
    }
    return { url: m3u8, headers: Object.assign({}, PLAYBACK_HEADERS) };
}

// ---------------------------------------------------------------------------
// AnimePahe parsing
// ---------------------------------------------------------------------------

async function searchAnime(query) {
    var data = await apJson(BASE_URL + "/api?m=search&l=15&q=" + encodeURIComponent(query));
    return (data && data.data) || [];
}

function parsePlayButtons(html) {
    var menu = html.indexOf('id="resolutionMenu"');
    var scope = menu === -1 ? html : html.substring(menu);
    var buttons = [];
    var re = /<button\b[^>]*>/gi;
    var m;

    while ((m = re.exec(scope))) {
        var tag = m[0];
        var src = attr(tag, "data-src") || attr(tag, "data-url");
        if (!src || src.indexOf("kwik") === -1) continue;

        var quality = attr(tag, "data-resolution");
        if (!quality) {
            var qm = String(tag).match(/(\d{3,4})p/i);
            quality = qm ? qm[1] : "";
        }

        buttons.push({
            url: decodeEntities(src),
            quality: quality ? String(quality) + "p" : "",
            audio: attr(tag, "data-audio") || "",
            fansub: attr(tag, "data-fansub") || ""
        });
    }
    return buttons;
}

function audioToLanguage(audio) {
    var a = String(audio || "").toLowerCase();
    if (a === "eng" || a === "en" || a === "english" || a === "dub") return "Dub";
    if (a === "jpn" || a === "ja" || a === "japanese" || a === "sub") return "Sub";
    return "Sub";
}

async function findEpisode(animeSession, episodeNumber) {
    var base =
        BASE_URL +
        "/api?m=release&id=" +
        encodeURIComponent(animeSession) +
        "&sort=episode_asc&page=";

    var first = await apJson(base + "1");
    if (!first || !Array.isArray(first.data)) return null;

    var perPage = parseInt(first.per_page, 10) || 30;
    var lastPage = parseInt(first.last_page, 10) || 1;
    var computed = Math.min(Math.max(Math.ceil(episodeNumber / perPage), 1), lastPage);

    var pages = [computed];
    for (var p = 1; p <= lastPage && pages.length < 6; p++) {
        if (p !== computed) pages.push(p);
    }

    for (var i = 0; i < pages.length; i++) {
        var list;
        if (pages[i] === 1) {
            list = first.data;
        } else {
            var page = await apJson(base + pages[i]);
            list = (page && page.data) || [];
        }

        for (var k = 0; k < list.length; k++) {
            var ep = list[k];
            var num = parseFloat(ep.episode);
            var num2 = parseFloat(ep.episode2);
            if (num === episodeNumber) return ep;
            if (!isNaN(num2) && num2 > 0 && episodeNumber >= num && episodeNumber <= num2) return ep;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Season / part mapping
// ---------------------------------------------------------------------------

function ordinal(n) {
    var s = ["th", "st", "nd", "rd"];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function partRank(title, rootNorm) {
    var rest = normTitle(title).substring(rootNorm.length).trim();
    if (!rest) return 1;
    var m = rest.match(/part\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
    m = rest.match(/cour\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
    if (rest.indexOf("final chapter") !== -1) return 90;
    m = rest.match(/(\d+)\s*(st|nd|rd|th)\s*season/);
    if (m) return parseInt(m[1], 10);
    return 2;
}

/**
 * AnimePahe splits long shows into separate entries ("Season 2",
 * "Season 3 Part 2", "The Final Season", "Final Season Part 2", ...).
 * Build the ordered chain of entries that belong to one season.
 */
function buildChain(entries, prefixNorm) {
    if (!prefixNorm) return [];

    var matches = entries.filter(function (entry) {
        return normTitle(entry.title).indexOf(prefixNorm) === 0;
    });
    if (!matches.length) return [];

    matches.sort(function (a, b) {
        return normTitle(a.title).length - normTitle(b.title).length;
    });

    var root = normTitle(matches[0].title);
    var chain = matches.filter(function (entry) {
        var n = normTitle(entry.title);
        if (n === root) return true;
        // Only same-season continuations belong in the chain. A "Season N"
        // suffix is a different season, never an extra part of this one.
        var rest = n.substring(root.length).trim();
        return /^(part|cour|final chapter|the final chapter|\d)/.test(rest);
    });

    chain.sort(function (a, b) {
        return partRank(a.title, root) - partRank(b.title, root);
    });
    return chain;
}

function planInChain(chain, episodeNumber) {
    var offset = 0;
    for (var i = 0; i < chain.length; i++) {
        var eps = parseInt(chain[i].episodes, 10) || 0;
        if (eps > 0 && episodeNumber <= offset + eps) {
            return { entry: chain[i], episode: episodeNumber - offset };
        }
        offset += eps;
    }
    return null;
}

function pickBaseEntry(entries, baseTitle) {
    var target = normTitle(baseTitle);
    var prefixMatch = null;
    for (var i = 0; i < entries.length; i++) {
        var n = normTitle(entries[i].title);
        if (n === target) return entries[i];
        if (!prefixMatch && n.indexOf(target) === 0) prefixMatch = entries[i];
    }
    return prefixMatch;
}

function seasonPrefixes(baseTitle, seasonMeta, seasonNumber) {
    var out = [];
    var seen = {};
    function add(value) {
        var n = normTitle(value);
        if (n && !seen[n]) {
            seen[n] = true;
            out.push(n);
        }
    }

    var seasonName = seasonMeta && seasonMeta.name ? String(seasonMeta.name) : "";
    if (seasonName && seasonName !== "Specials") {
        add(baseTitle + " " + seasonName);
        add(baseTitle + " " + seasonName.replace(/^the\s+/i, ""));
    }
    add(baseTitle + " " + ordinal(seasonNumber) + " Season");
    add(baseTitle + " Season " + seasonNumber);
    add(baseTitle + " " + seasonNumber);
    return out;
}

async function resolveEpisode(tmdb, season, episode) {
    var seasonNumber = season == null ? 1 : parseInt(season, 10);
    if (isNaN(seasonNumber) || seasonNumber < 1) seasonNumber = 1;
    var targetEpisode = episode == null ? 1 : parseInt(episode, 10);
    if (isNaN(targetEpisode) || targetEpisode < 1) targetEpisode = 1;

    var baseTitle = tmdb.titles[0];
    if (!baseTitle) return null;

    var seasonMeta = null;
    for (var i = 0; i < tmdb.seasons.length; i++) {
        if (parseInt(tmdb.seasons[i].season_number, 10) === seasonNumber) {
            seasonMeta = tmdb.seasons[i];
            break;
        }
    }

    // Episodes that aired before this season, for absolute-number fallback.
    var previousEpisodes = 0;
    for (var j = 0; j < tmdb.seasons.length; j++) {
        var sn = parseInt(tmdb.seasons[j].season_number, 10);
        if (sn >= 1 && sn < seasonNumber) {
            previousEpisodes += parseInt(tmdb.seasons[j].episode_count, 10) || 0;
        }
    }

    // Collect candidates: base title, then the season-specific query.
    var entries = [];
    var seen = {};
    function merge(list) {
        for (var x = 0; x < list.length; x++) {
            if (list[x].session && !seen[list[x].session]) {
                seen[list[x].session] = true;
                entries.push(list[x]);
            }
        }
    }

    merge(await searchAnime(baseTitle));

    var prefixes = seasonNumber > 1 ? seasonPrefixes(baseTitle, seasonMeta, seasonNumber) : [normTitle(baseTitle)];

    if (seasonNumber > 1) {
        var hint = seasonMeta && seasonMeta.name ? baseTitle + " " + seasonMeta.name : baseTitle + " Season " + seasonNumber;
        if (normTitle(hint) !== normTitle(baseTitle)) {
            try {
                merge(await searchAnime(hint));
            } catch (e) {
                console.error("[AnimePahe] season search failed:", e && e.message);
            }
        }
    }

    if (!entries.length && tmdb.titles[1]) {
        merge(await searchAnime(tmdb.titles[1]));
    }

    // 1. Season/part chains (correct for split seasons).
    for (var p = 0; p < prefixes.length; p++) {
        var chain = buildChain(entries, prefixes[p]);
        if (!chain.length) continue;
        var plan = planInChain(chain, targetEpisode);
        if (plan) {
            return {
                animeSession: plan.entry.session,
                episode: plan.episode,
                animeTitle: plan.entry.title,
                season: seasonNumber,
                requestedEpisode: targetEpisode
            };
        }
    }

    // 2. Single entry that covers every season (absolute numbering).
    var baseEntry = pickBaseEntry(entries, baseTitle);
    if (baseEntry) {
        var absolute = previousEpisodes + targetEpisode;
        var absolutePlan = planInChain([baseEntry], absolute);
        if (absolutePlan) {
            return {
                animeSession: baseEntry.session,
                episode: absolutePlan.episode,
                animeTitle: baseEntry.title,
                season: seasonNumber,
                requestedEpisode: targetEpisode
            };
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function getStreams(tmdbId, mediaType, season, episode) {
    var results = [];
    var isMovie = String(mediaType || "").toLowerCase() === "movie";

    try {
        var tmdb = await getTmdbInfo(tmdbId, mediaType);
        if (!tmdb.titles.length) {
            console.error("[AnimePahe] TMDB returned no title for " + mediaType + " " + tmdbId);
            return results;
        }

        var plan = await resolveEpisode(tmdb, isMovie ? 1 : season, isMovie ? 1 : episode);
        if (!plan) {
            console.error(
                "[AnimePahe] no matching AnimePahe entry for '" +
                    tmdb.titles[0] +
                    "' S" +
                    season +
                    "E" +
                    episode
            );
            return results;
        }

        var ep = await findEpisode(plan.animeSession, plan.episode);
        if (!ep || !ep.session) {
            console.error(
                "[AnimePahe] episode " + plan.episode + " not found for " + plan.animeTitle
            );
            return results;
        }

        var playUrl = BASE_URL + "/play/" + plan.animeSession + "/" + ep.session;
        var playHtml = await apGet(playUrl);
        var buttons = parsePlayButtons(playHtml);

        if (!buttons.length) {
            console.error("[AnimePahe] no kwik buttons on " + playUrl);
            return results;
        }

        var label = isMovie
            ? plan.animeTitle
            : plan.animeTitle + " - S" + plan.season + "E" + plan.requestedEpisode;

        var seenUrls = {};
        var jobs = [];

        for (var i = 0; i < buttons.length; i++) {
            if (seenUrls[buttons[i].url]) continue;
            seenUrls[buttons[i].url] = true;

            jobs.push(
                (async function (button) {
                    try {
                        var stream = await resolveKwik(button.url);
                        if (!stream) return;

                        var language = audioToLanguage(button.audio);
                        var quality = button.quality || "";
                        var nameParts = ["AnimePahe"];
                        if (quality) nameParts.push(quality);
                        nameParts.push(language);
                        if (button.fansub) nameParts.push(button.fansub);

                        results.push({
                            title: label,
                            name: nameParts.join(" · "),
                            url: stream.url,
                            quality: quality || null,
                            language: language,
                            provider: "AnimePahe",
                            type: "m3u8",
                            headers: stream.headers,
                            subtitles: [],
                            size: null,
                            infoHash: null,
                            seeders: null,
                            peers: null
                        });
                    } catch (e) {
                        console.error("[AnimePahe] kwik resolve failed:", e && e.message);
                    }
                })(buttons[i])
            );
        }

        await Promise.all(jobs);
    } catch (e) {
        console.error("[AnimePahe] getStreams error:", (e && e.message) || e, (e && e.stack) || "");
    }

    // Sub first, then higher quality first.
    results.sort(function (a, b) {
        if (a.language !== b.language) return a.language === "Sub" ? -1 : 1;
        return (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0);
    });

    console.log("[AnimePahe] returning " + results.length + " streams");
    return results;
}

async function getTmdbInfo(tmdbId, mediaType) {
    var kind = String(mediaType || "").toLowerCase() === "movie" ? "movie" : "tv";
    var data = await tmdbJson("/" + kind + "/" + encodeURIComponent(tmdbId));

    var titles = [];
    function addTitle(value) {
        if (value && titles.indexOf(value) === -1) titles.push(value);
    }
    addTitle(data.name || data.title);
    addTitle(data.original_name || data.original_title);

    return {
        kind: kind,
        titles: titles,
        seasons: Array.isArray(data.seasons) ? data.seasons : []
    };
}

module.exports = { getStreams };
