# Golf Swing

A simple web app (PWA) for the driving range: set your phone up, tap start, and it loops hands-free:

**countdown → record your swing → replay it → countdown again**, until you tap stop.

- Front or back camera (flip button next to settings); front camera lets you watch the replay from where you stand
- Countdown beeps so you know when recording starts
- Optional slow-motion replays (last replay or all, at ¼×, ½× or ¾×)
- **Club-head trace**, worked out automatically after every swing: red on the backswing, green on the downswing. Toggle it on/off during replays and in the player
- **Save** a swing during its replay; saved swings are kept privately in Supabase
- **Gallery** of saved swings grouped by day, with an in-app player (speed, scrub, loop, delete, swipe between swings)
- Adjustable countdown, recording length, replays, pauses, video quality and frame rate
- Keeps the screen awake during a session

## How it's built

- Plain HTML/CSS/JavaScript, no build step. Hosted on GitHub Pages from `main`.
- `app.js`: camera, record/replay loop, settings
- `tracer.js`: club-head tracer. After recording, steps through the clip frame by frame:
  MediaPipe Pose (hidden, loaded from jsDelivr on first use) finds the hands; the shaft is found as a thin
  moving line out of the hands; a Viterbi search over (direction, visible length) picks the smoothest
  consistent club-head path, pinned to the address position before takeaway and at impact, with the
  backswing path guiding the blurred downswing
- `gallery.js`: gallery and player
- `supabase.js`: tiny Supabase client (GitHub sign-in, storage, `swings` table)

### Supabase

- Project `golfswing` (Seoul region)
- Table `public.swings`: one row per clip (`recorded_at`, `video_path`, `thumb_path`, `duration_ms`, `size_bytes`, `trace`, `facing`)
- Private bucket `swings`: files at `<user_id>/<YYYY-MM-DD>/<HH-MM-SS-mmm>.webm` (+ `.jpg` thumbnail)
- Row-level security: each signed-in user can only read, add and delete their own rows and files
