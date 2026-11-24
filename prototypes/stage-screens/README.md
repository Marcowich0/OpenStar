# PROTOTYPE: Stage screens (throwaway)

Primary source for the wayfinder ticket "Stage screens" (Marcowich0/OpenStar#28).
This branch is never merged. One self-contained page; open it in a desktop browser. The Stage is drawn
at 1920x1080 and scaled to the window. Songs, people, scores and the video are invented; there is no
real mic, server or audio.

| File | Round | What it asks |
|---|---|---|
| `round1-three-takes.html` | 1 | Three takes on the Stage's own screens (idle, Line-up, results, Party people list, toasts, "Stage moved here", mic lost on a lane): A Tabs on the TV, B Big moments, C Side rail. |

Prototype keys: `[` and `]` switch the take, `` ` `` (backtick) or the "scenes" button opens the panel,
which jumps to any scene and fires things a Remote does (toasts, a Phone joining, a lost mic, a Stage takeover).

Stage keys (the design under test): arrows move focus, Enter picks, Esc backs out, hold Enter on
destructive buttons; the mouse hovers to focus, clicks to pick and presses and holds to confirm.
Take A adds `1`–`4` for its tabs; take B adds `S`, `Q`, `P` for its overlays; Space starts a ready Line-up
and pauses a Song in every take. Location: `#<take>-<scene>`, for example `#b-results`.
