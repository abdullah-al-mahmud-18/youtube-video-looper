# YouTube Segment Looper

**This app is vibecoded with Claude.**

A static web page that plays a chosen segment of a YouTube video on repeat, from once to forever. It uses the official [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) and has no backend, build step, or dependencies.

## Using it

1. Paste a YouTube URL or an 11-character video ID.
2. Enter the start and end times as `hh:mm:ss` or `mm:ss`. Type digits only and the colons are added for you, so `130` becomes `01:30` and `13000` becomes `01:30:00`.
3. Enter the number of loops, or turn on **Infinite**.
4. Click **Load & Play**.

Use **Play/Pause**, **Stop**, and **Restart loops** under the player. On a keyboard, `Space` plays or pauses and `R` restarts the loops, as long as focus isn't on a form field. If a button has focus, `Space` presses that button instead.

**Use current time** fills in a start or end time from the video's current position.

## Sharing a segment

**Copy share link** copies a link that fills in the form and loads the video when opened:

```
?v=VIDEO_ID&start=90&end=120&loops=5
```

Times in the link are in seconds, and the form shows them as timestamps. Use `loops=inf` for infinite looping. Some browsers block autoplay, so the viewer may need to tap the video to start it.

## Running locally

YouTube embeds need a real page origin, so serve the folder over HTTP instead of opening the file directly:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploying to GitHub Pages

1. Push to the `main` branch.
2. In the repository, go to **Settings → Pages → Deploy from a branch**, then select `main` and `/ (root)`.

## Limitations

- Video owners can disable embedding. The page shows a message when a video can't be played.
- Between loops, playback can run slightly past the end time, because the page checks the position about every 200ms.
