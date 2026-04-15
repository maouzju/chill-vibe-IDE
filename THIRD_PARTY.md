# Third-Party Notes

Chill Vibe is a local-first application, but some optional features depend on third-party services or fetch externally hosted assets at runtime. This file documents the non-obvious integrations that matter for open-source review and release hygiene.

The generated npm dependency inventory lives in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). Refresh it with `pnpm legal:generate` whenever `package.json` or `pnpm-lock.yaml` changes.

## Bundled Open-Source Dependencies

The repository declares package dependencies in [`package.json`](./package.json) and resolves their licenses through the lockfile. The current dependency tree is dominated by MIT/ISC/Apache/BSD packages, with a smaller set of other permissive licenses such as MPL-2.0, CC-BY-4.0, W3C, BlueOak, 0BSD, Python-2.0, and dual-license combinations. Review [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) before shipping releases.

One direct dependency worth calling out explicitly because it powers an end-user feature is:

- `NeteaseCloudMusicApi` (`package.json`)
  License reported by installed package metadata: `MIT`

Packaged desktop releases should carry at least these repo-level legal docs:

- [`LICENSE`](./LICENSE)
- [`THIRD_PARTY.md`](./THIRD_PARTY.md)
- [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)
- [`PRIVACY.md`](./PRIVACY.md)
- [`SECURITY.md`](./SECURITY.md)

## Runtime Services

These services are contacted at runtime by optional features. They are not vendored into this repository.

- Weather data and geocoding: `wttr.in`, `freeipapi.com`, `open-meteo.com`, and `nominatim.openstreetmap.org`
  Source code: [`server/weather/weather-service.ts`](./server/weather/weather-service.ts)
- NetEase music integration: `NeteaseCloudMusicApi` is used as the client library for the experimental music feature
  Source code: [`server/music/netease-service.ts`](./server/music/netease-service.ts)

## Runtime-Fetched Sample Audio

The white-noise feature downloads audio on demand instead of bundling it in this repository.
Source code: [`server/whitenoise/audio-cache.ts`](./server/whitenoise/audio-cache.ts)

### Asset Map

- `rain`, `wind`, `fire`, `night`, `thunder`, `cafe`, `ocean`, `birds`
  Upstream repository: `bradtraversy/ambient-sound-mixer`
  Upstream repository URL: `https://github.com/bradtraversy/ambient-sound-mixer`
  Upstream repository license: `MIT`
  Upstream README note: the project says its sound files are sourced from royalty-free libraries.
  Maintainer note: this is a repository-level statement, not a per-file provenance table. Treat these clips as demo/sample assets and revalidate the individual audio provenance before relying on them as release-critical redistributed media.

- `stream`
  Upstream repository: `mateusfg7/Noisekun`
  Upstream repository URL: `https://github.com/mateusfg7/Noisekun`
  Upstream repository license: `MIT`
  Upstream credits note: the `README` credits table lists `Stream Water` with author `SFX Producer` and license `CC0`.
  Maintainer note: Chill Vibe uses the raw `stream-water.ogg` file from that repository, so keep the upstream credits table in sync if the source ever changes.

- `cat`
  Upstream host: `BigSoundBank`
  Upstream host URL: `https://bigsoundbank.com/`
  Runtime URL in code: `https://bigsoundbank.com/UPLOAD/mp3/1010.mp3`
  Upstream license page: `https://bigsoundbank.com/licenses.html`
  Upstream usage note: BigSoundBank says files marked `Free and Royalty Free` may be used, adapted, and redistributed for commercial or non-commercial projects without asking permission.
  Maintainer note: the direct `UPLOAD/mp3/...` URL used in code bypasses the human-readable download page, so revalidate the corresponding source page before depending on this clip for a release.

These files are cached locally in the app data directory after the first download and are not committed to this repository.

## Maintainer Notes

- Do not add externally hosted media files to the repository without reviewing the upstream license and redistribution terms first.
- If an upstream asset source, host, or terms change, update the corresponding runtime integration or remove that source.
- When this file makes an inference from upstream materials, it says so explicitly. Prefer asset-level attribution over repository-level assumptions whenever it is available.
- Users are responsible for complying with the terms and local law that apply to the third-party services and media they choose to access through optional features.
