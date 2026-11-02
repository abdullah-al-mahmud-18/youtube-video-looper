# CLAUDE.md — YouTube Segment Looper

## Project overview
A static web app that takes a YouTube URL, a start timestamp, an end timestamp, and a loop count (1 to infinity), then plays that segment of the video on repeat the requested number of times.

Hosted on **GitHub Pages**, so it must be fully static: no backend, no server-side code, no build step that GitHub Pages can't serve directly.

## Tech constraints
- Plain **HTML + CSS + vanilla JavaScript**. No frameworks, no bundler, no npm dependencies.
- Use the official **YouTube IFrame Player API** (`https://www.youtube.com/iframe_api`). Do not download or proxy video content.
- Files live at the repo root so GitHub Pages serves `index.html` directly:
  ```
  /index.html
  /style.css
  /app.js
  /README.md
  /CLAUDE.md
  ```
- Must work in current Chrome, Firefox, Edge, and Safari, on desktop and mobile.

## Features

### Inputs
1. **YouTube URL**: accept all common formats and extract the 11-character video ID:
   - `https://www.youtube.com/watch?v=ID` (with extra params like `&t=`, `&list=`)
   - `https://youtu.be/ID`
   - `https://www.youtube.com/shorts/ID`
   - `https://www.youtube.com/embed/ID`
   - `https://m.youtube.com/watch?v=ID`
   - `https://www.youtube.com/live/ID` and `/v/ID`
   - `music.youtube.com` and `youtube-nocookie.com` hosts
   - Any of the above without the `https://` prefix
   - A bare 11-character ID
2. **Start time**: a masked timestamp field that accepts only `hh:mm:ss` or `mm:ss`, not plain seconds.
   - The user types digits only. Colons are inserted automatically, grouping from the right: `130` shows `1:30`, `13000` shows `1:30:00`.
   - Non-digit characters are dropped, with a maximum of 6 digits.
   - On blur and on submit, a partial value is completed: `5` becomes `00:05`, `130` becomes `01:30`.
   - Use `inputmode="numeric"` so phones show a number keyboard.
3. **End time**: same field behavior as start time.
4. **Loop count**: an integer of 1 or more, plus an **∞ (infinite)** checkbox or toggle. When infinite is on, disable the number field.

### Validation (show inline error messages, never `alert()`)
- The URL must yield a valid video ID.
- Timestamps must parse correctly. Minutes and seconds must be in 0–59.
- The start time must be less than the end time.
- The end time must not exceed the video duration (check after the player loads, using `getDuration()`). Compare against the duration rounded up to a whole second, because durations are fractional and the field holds whole seconds. If the end time is within that rounding, stop at the real duration.
- The loop count must be an integer of 1 or more, unless infinite is selected.

### Playback behavior
- Clicking **Load & Play**:
  1. Creates the player, or reuses it with `loadVideoById({ videoId, startSeconds, endSeconds })`.
  2. Plays the segment.
- Loop logic:
  - On `YT.PlayerState.ENDED`, increment the completed-loop counter.
  - If `completed < loopCount`, or infinite is on, call `seekTo(start)` and then `playVideo()`.
  - Do not rely only on `endSeconds`. Also run a polling check every ~200ms (`getCurrentTime() >= end`) as a fallback, because `endSeconds` can be ignored after a `seekTo`. Make sure each loop is counted exactly once, with no double counting from both mechanisms.
  - Single counting uses the `armed` flag in the state object. Counting a loop disarms it, and it re-arms only once the playhead is seen back inside the segment. An `ENDED` event that arrives while disarmed resumes playback without counting.
- Display the status, for example: **"Loop 3 of 10"** or **"Loop 3 of ∞"**.
- Controls: **Play/Pause**, **Stop** (resets the counter), and **Restart loops**. After Stop or Done, Play starts the loops again from the first one.
- When all loops finish, pause at the end and show "Done".
- If playback hasn't started after about 4 seconds, show a hint to tap the video, because browsers (phones especially) may block autoplay.

### Error handling
- Handle the player `onError` codes:
  - **2**: invalid ID
  - **5**: HTML5 error
  - **100**: video not found or private
  - **101/150**: embedding disabled by the owner. YouTube also returned 150 for nonexistent IDs in testing, so the message must not state the owner as the only possible cause.
  - **153**: player configuration error from a missing page origin, for example when the page is opened as a local file
- Show a friendly message for each code, and a generic message with the code for any other value.
- If the IFrame API script fails to load, show a message about the connection or ad blockers.

### Additional features
- A **"Use current time"** button next to the start and end fields that fills in `getCurrentTime()`.
- Shareable links: encode the state in the query string, e.g. `?v=ID&start=90&end=120&loops=5`, or `loops=inf` for infinite. Times in the link are in seconds. Pre-fill the form with them as timestamps and auto-load the video on page open.
- A **Copy share link** button. Load & Play also updates the address bar to the share link.
- Remember the last inputs in `localStorage`, wrapped in try/catch. A share link takes priority over stored inputs, and stored inputs don't auto-load the video.
- Keyboard shortcuts: Space for play/pause, R for restart. Both are ignored while focus is on a form field. Space is also left alone on a focused button or link, so it activates that element as usual.

## UI / design
- A single page whose layout adapts to the screen:
  - **Laptop and desktop (1024px and wider):** the form sits in a column at the top right, and the video takes all the remaining space, with the status bar underneath it. The page fits the viewport height.
  - **Tablet and phone (below 1024px):** the form, a 16:9 player, and the status bar stack vertically. From 600px to 1023px, the start and end fields sit side by side.
- Must be usable on phone widths. Below 600px, inputs should stack vertically, and there should be no horizontal scroll.
- Support both light and dark mode via `prefers-color-scheme`.
- Use accessible labels for all inputs and visible focus states.

## Code guidelines
- Keep `app.js` organized into small, pure helper functions:
  - `parseVideoId(url)`
  - `parseTime(str)` → seconds or `null` (timestamps only)
  - `maskTimeInput(text)` → digits with colons added as the user types
  - `normalizeTimeInput(text)` → a complete `mm:ss` or `hh:mm:ss` timestamp
  - `formatTime(seconds)` → `hh:mm:ss`
  - `validateInputs()`
- Keep the player and loop state in one state object.
- No global leaks beyond `onYouTubeIframeAPIReady`, which the API requires to be global.
- Add short comments explaining the loop and polling logic.

## Testing (manual)
The project owner runs these checks. When coding is done, hand the work over without running them or building test harnesses, unless asked:
- [ ] Each URL format above loads correctly.
- [ ] A loop count of 1 plays the segment once, then stops.
- [ ] A loop count of 3 plays exactly 3 times, and the counter is accurate.
- [ ] Infinite mode loops until stopped.
- [ ] Typing digits into a time field adds the colons automatically, and letters are ignored.
- [ ] Start ≥ end shows an error.
- [ ] An end time beyond the video length shows an error.
- [ ] An embedding-disabled video shows a friendly message.
- [ ] The layout works at 375px width.
- [ ] From 1024px wide, the form is at the top right and the video fills the remaining space.
- [ ] A shareable link restores the state.

## Deployment
1. Push to the `main` branch.
2. In the repo, go to **Settings → Pages → Deploy from branch → `main` / root**.
3. Use relative paths only, e.g. `./app.js`, so the site works under `username.github.io/repo-name/`.