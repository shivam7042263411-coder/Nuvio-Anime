-- Initial schema for the independent anime API.
-- Applied automatically at boot by src/db/migrate.ts.

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

-- Durable cache tier. Short-lived signed URLs are memory-only and never reach this table.
create table if not exists cache_entries (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null,
  stale_until timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists cache_entries_stale_until_idx
  on cache_entries (stale_until);

-- Persisted TMDB <-> AniList matches. Avoids repeating fuzzy matching on every request.
create table if not exists metadata_matches (
  anilist_id integer primary key,
  tmdb_id integer not null,
  media_type text not null check (media_type in ('tv', 'movie')),
  confidence numeric(4, 3) not null check (confidence >= 0 and confidence <= 1),
  matched_title text,
  matched_year integer,
  updated_at timestamptz not null default now()
);

create index if not exists metadata_matches_tmdb_idx
  on metadata_matches (tmdb_id, media_type);

-- Sources the operator is authorized to provide. The catalogue path never
-- scrapes sites and never bypasses Cloudflare, CAPTCHA, logins or other access
-- controls. The optional AnimePahe provider resolves public links at request
-- time and never writes their temporary URLs to this table.
create table if not exists authorized_sources (
  id text primary key,
  provider_id text not null default 'catalog',
  anime_id text not null,
  season_number integer,
  episode_number numeric(10, 2) not null check (episode_number >= 0),
  label text not null check (label in ('sub', 'dub', 'dl')),
  language text,
  quality text,
  stream_type text not null default 'hls' check (stream_type in ('hls', 'dash', 'mp4')),
  url text not null check (url ~ '^https?://'),
  headers jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists authorized_sources_identity_idx
  on authorized_sources (
    provider_id,
    anime_id,
    coalesce(season_number, -1),
    episode_number,
    label,
    coalesce(quality, '')
  );

create index if not exists authorized_sources_episode_idx
  on authorized_sources (anime_id, season_number, episode_number)
  where enabled = true;

-- Selectable external subtitle tracks and factual hardsub/embedded labels.
-- Embedded subtitles never appear in the selectable `tracks` response.
create table if not exists authorized_subtitles (
  id text primary key,
  provider_id text not null default 'catalog',
  anime_id text not null,
  season_number integer,
  episode_number numeric(10, 2) not null check (episode_number >= 0),
  kind text not null check (kind in ('external', 'embedded')),
  language text not null,
  label text not null,
  format text check (format in ('srt', 'vtt')),
  url text check (url is null or url ~ '^https?://'),
  headers jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'external' or (format is not null and url is not null)),
  check (kind <> 'embedded' or url is null)
);

create unique index if not exists authorized_subtitles_identity_idx
  on authorized_subtitles (
    provider_id,
    anime_id,
    coalesce(season_number, -1),
    episode_number,
    kind,
    language,
    label
  );

create index if not exists authorized_subtitles_episode_idx
  on authorized_subtitles (anime_id, season_number, episode_number)
  where enabled = true;
