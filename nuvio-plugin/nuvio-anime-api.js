// =============================================================================
// Anime API - NuvioTV plugin (QuickJS / PluginRuntime)
//
// Nuvio calls:
//   getStreams(tmdbId, mediaType, season, episode) => Promise<LocalScraperResult[]>
//
// This adapter only talks to the independent Anime API in this repository:
//   /api/anime/tmdb:<id>
//   /api/episode/tmdb:<id>:s<season>:e<episode>/sources
//   /api/episode/tmdb:<id>:s<season>:e<episode>/subtitles
//
// The API resolves the canonical AniList/TMDB episode, reads the operator's
// authorized catalogue plus any enabled server-side provider, and separates
// external subtitle tracks from embedded/hardcoded subtitles. This plugin
// performs no scraping, no Cloudflare bypass, no CAPTCHA solving, no login
// handling and no DRM work.
//
// Configure the deployed API URL below, or provide globalThis.ANIME_API_URL.
// =============================================================================

var DEFAULT_API_BASE = "https://nuvio-anime-api.antideploy.app";
var PLUGIN_NAME = "Anime API";
var PLUGIN_VERSION = "1.0.0";

function configuredApiBase() {
    var value = "";

    if (typeof globalThis !== "undefined" && globalThis.ANIME_API_URL) {
        value = globalThis.ANIME_API_URL;
    } else if (
        typeof process !== "undefined" &&
        process &&
        process.env &&
        process.env.ANIME_API_URL
    ) {
        value = process.env.ANIME_API_URL;
    } else {
        value = DEFAULT_API_BASE;
    }

    return String(value == null ? "" : value)
        .replace(/^\s+|\s+$/g, "")
        .replace(/\/+$/, "");
}

var API_BASE = configuredApiBase();

function logInfo(message) {
    console.log("[" + PLUGIN_NAME + "] " + message);
}

function logError(message) {
    console.error("[" + PLUGIN_NAME + "] " + message);
}

function messageOf(error) {
    if (error && error.message) return String(error.message);
    return String(error == null ? "unknown error" : error);
}

function isMovie(mediaType) {
    return String(mediaType == null ? "" : mediaType).toLowerCase() === "movie";
}

function finiteNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
}

function pad2(value) {
    var text = String(Math.floor(finiteNumber(value, 0)));
    return text.length < 2 ? "0" + text : text;
}

function normalizeHeaders(headers) {
    if (!headers || typeof headers !== "object") return null;

    var out = {};
    var count = 0;
    var keys = Object.keys(headers);

    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var value = headers[key];
        if (typeof value !== "string") continue;
        out[key] = value;
        count += 1;
    }

    return count > 0 ? out : null;
}

function buildEpisodeId(tmdbId, mediaType, season, episode) {
    var id = Number(tmdbId);
    if (!isFinite(id) || id <= 0) return null;

    if (isMovie(mediaType)) {
        return "tmdb:" + Math.floor(id) + ":e1";
    }

    var seasonNumber = Math.floor(finiteNumber(season, 1));
    var episodeNumber = Math.floor(finiteNumber(episode, 1));
    if (seasonNumber < 0) seasonNumber = 1;
    if (episodeNumber < 0) episodeNumber = 1;

    return (
        "tmdb:" +
        Math.floor(id) +
        ":s" +
        seasonNumber +
        ":e" +
        episodeNumber
    );
}

async function apiGet(path) {
    var url = API_BASE + path;
    var response = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json"
        }
    });

    var text = await response.text();
    var payload = null;

    if (text) {
        try {
            payload = JSON.parse(text);
        } catch (error) {
            logError("API returned invalid JSON for " + path);
            return null;
        }
    }

    if (!response.ok) {
        var apiError = payload && payload.error ? payload.error : {};
        logError(
            "API " +
                path +
                " failed: HTTP " +
                response.status +
                (apiError.code ? " " + apiError.code : "") +
                (apiError.message ? " - " + apiError.message : "")
        );
        return null;
    }

    if (!payload || !payload.data) {
        logError("API response for " + path + " has no data envelope");
        return null;
    }

    return payload.data;
}

function safeGet(path) {
    return apiGet(path).catch(function (error) {
        logError("request failed for " + path + ": " + messageOf(error));
        return null;
    });
}

function buildTitle(anime, mediaType, season, episodeNumber) {
    var preferred =
        anime && anime.titles && anime.titles.preferred
            ? String(anime.titles.preferred)
            : "";

    if (isMovie(mediaType)) {
        return preferred || "Movie";
    }

    var seasonLabel = "S" + pad2(season);
    var episodeLabel = "E" + pad2(episodeNumber);
    var suffix = " - " + seasonLabel + episodeLabel;

    return preferred ? preferred + suffix : "Episode " + episodeNumber;
}

function mapSubtitles(subtitleData) {
    var tracks =
        subtitleData && subtitleData.tracks && subtitleData.tracks.length
            ? subtitleData.tracks
            : [];
    var out = [];
    var seen = {};

    for (var i = 0; i < tracks.length; i++) {
        var track = tracks[i];
        if (!track || !track.url || seen[track.url]) continue;
        seen[track.url] = true;

        var language = track.language ? String(track.language) : "und";
        out.push({
            id: track.id ? String(track.id) : String(track.url),
            url: String(track.url),
            lang: language,
            language: language,
            name: track.label ? String(track.label) : language,
            addonName: PLUGIN_NAME,
            addonLogo: null,
            isStreamProvided: false,
            headers: normalizeHeaders(track.headers)
        });
    }

    // data.embedded is intentionally ignored. Hardcoded subtitles are not
    // selectable tracks and must never be advertised as if they were.
    return out;
}

function streamType(type) {
    var value = String(type == null ? "" : type).toLowerCase();
    if (value === "hls" || value === "m3u8") return "m3u8";
    if (value === "dash" || value === "mpd") return "mpd";
    if (value === "mp4") return "mp4";
    return value || null;
}

function mapSource(source, title, subtitles) {
    if (!source || !source.url) return null;
    if (source.delivery && String(source.delivery) !== "stream") return null;

    if (source.expiresAt) {
        var expiresAt = Date.parse(String(source.expiresAt));
        if (isFinite(expiresAt) && expiresAt <= Date.now()) return null;
    }

    var label = source.label ? String(source.label) : "Unknown";
    var pieces = [PLUGIN_NAME, label];

    if (source.name) pieces.push(String(source.name));
    if (source.quality) pieces.push(String(source.quality));
    if (source.language) pieces.push(String(source.language));
    if (source.provider && String(source.provider) !== "catalog") {
        pieces.push(String(source.provider));
    }

    return {
        title: title,
        name: pieces.join(" · "),
        url: String(source.url),
        quality: source.quality ? String(source.quality) : null,
        size: source.size ? String(source.size) : null,
        language: label,
        provider: PLUGIN_NAME,
        type: streamType(source.type),
        seeders: null,
        peers: null,
        infoHash: null,
        headers: normalizeHeaders(source.headers),
        subtitles: subtitles
    };
}

function streamRank(stream) {
    if (stream.language === "Sub") return 0;
    if (stream.language === "Dub") return 1;
    if (stream.language === "DL") return 2;
    return 3;
}

function sortStreams(a, b) {
    var rankA = streamRank(a);
    var rankB = streamRank(b);
    if (rankA !== rankB) return rankA - rankB;

    var qualityA = parseInt(a.quality, 10);
    var qualityB = parseInt(b.quality, 10);
    if (!isFinite(qualityA)) qualityA = 0;
    if (!isFinite(qualityB)) qualityB = 0;
    return qualityB - qualityA;
}

async function getStreams(tmdbId, mediaType, season, episode) {
    var results = [];
    var episodeId = buildEpisodeId(tmdbId, mediaType, season, episode);

    if (!episodeId) {
        logError("Invalid TMDB id: " + tmdbId);
        return results;
    }

    if (
        !API_BASE ||
        API_BASE.indexOf("your-anime-api") !== -1 ||
        API_BASE.indexOf("example.com") !== -1
    ) {
        logError(
            "API_BASE is not configured. Edit nuvio-plugin/nuvio-anime-api.js or set globalThis.ANIME_API_URL."
        );
        return results;
    }

    var animePath = "/api/anime/tmdb:" + Math.floor(Number(tmdbId));
    var encodedEpisode = encodeURIComponent(episodeId);

    logInfo(
        PLUGIN_VERSION +
            " resolving " +
            episodeId +
            " for " +
            String(mediaType == null ? "tv" : mediaType)
    );

    var responses = await Promise.all([
        safeGet(animePath),
        safeGet("/api/episode/" + encodedEpisode + "/sources"),
        safeGet("/api/episode/" + encodedEpisode + "/subtitles")
    ]);

    var anime = responses[0];
    var sourceData = responses[1];
    var subtitleData = responses[2];

    var seasonNumber = Math.floor(finiteNumber(season, 1));
    var episodeNumber = Math.floor(finiteNumber(episode, 1));
    var title = buildTitle(anime, mediaType, seasonNumber, episodeNumber);
    var subtitles = mapSubtitles(subtitleData);

    var sources =
        sourceData && sourceData.sources && sourceData.sources.length
            ? sourceData.sources
            : [];
    var seenUrls = {};

    for (var i = 0; i < sources.length; i++) {
        var mapped = mapSource(sources[i], title, subtitles);
        if (!mapped || seenUrls[mapped.url]) continue;
        seenUrls[mapped.url] = true;
        results.push(mapped);
    }

    results.sort(sortStreams);

    if (!results.length) {
        logInfo("No authorized stream is configured for " + episodeId + ".");
    } else {
        logInfo("Returning " + results.length + " stream(s) for " + episodeId + ".");
    }

    return results;
}

module.exports = { getStreams };
