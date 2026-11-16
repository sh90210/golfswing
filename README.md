# Golf Swing

A simple web app (PWA) for the driving range: set your phone up, tap start, and it loops hands-free:

**countdown → record your swing → replay it → countdown again**, until you tap stop.

- Front camera, so you can watch the replay from where you stand
- Countdown beeps so you know when recording starts
- Optional slow-motion replays (last replay or all, at ¼×, ½× or ¾×)
- **Swing trace** (optional): hand path and an experimental club-head path, red on the backswing and green on the downswing
- **Save** a swing during its replay; saved swings are kept privately in Supabase
- **Gallery** of saved swings grouped by day, with an in-app player (speed, scrub, loop, delete, swipe between swings)
- Adjustable countdown, recording length, replays, pauses, video quality and frame rate
- Keeps the screen awake during a session

## How it's built

- Plain HTML/CSS/JavaScript, no build step. Hosted on GitHub Pages from `main`.
- `app.js`: camera, record/replay loop, settings
- `tracer.js`: MediaPipe Pose (loaded from jsDelivr on first use) for the hand path; club head estimated from frame-to-frame motion along rays from the hands
- `gallery.js`: gallery and player
- `supabase.js`: tiny Supabase client (GitHub sign-in, storage, `swings` table)

### Supabase

- Project `golfswing` (Seoul region)
- Table `public.swings`: one row per clip (`recorded_at`, `video_path`, `thumb_path`, `duration_ms`, `size_bytes`, `trace`)
- Private bucket `swings`: files at `<user_id>/<YYYY-MM-DD>/<HH-MM-SS-mmm>.webm` (+ `.jpg` thumbnail)
- Row-level security: each signed-in user can only read, add and delete their own rows and files
