# PROTOTYPE: Twelve-colour palette (throwaway)

Primary source for the wayfinder ticket "Twelve-colour palette" (Marcowich0/OpenStar#26).
This branch is never merged. `palette.html` is one self-contained page; open it in a Chromium
browser. Songs, lyrics and singers are invented and simulated; there is no audio.

Question: which twelve Party colours, in which palette order? The variants are candidate
palettes, not layouts. Each is shown on three screens:

| Screen | Shows |
|---|---|
| Board | The twelve in palette order; each as lane tint and pitch line on frosted lanes over mid, dark and bright video; closest pairs (ΔE 2000) for normal, deutan, protan and tritan vision; how distinct the first N stay; clashes with the golden note, passed-note grey, a neutral lyric fill, and the white initial |
| Sing | The Visual direction sing screen (round 4, take 2 "Two columns") with 1–8 Players in these colours. "first N" is a small Party, "last N" the weakest colours |
| Party | The Stage's Party people list with nine members, and a Phone picking a colour with the first free one pre-selected |

| Variant | Idea |
|---|---|
| A Candy twelve | All bright candy colours: seven of the old eight (amber dropped) plus lime, indigo, magenta, peach, lilac |
| B Candy + deep, distinct first | Eight candy (old eight, lime for amber) plus navy, cocoa, berry, forest; ordered most distinct first |
| C Candy + deep, bright first | Same twelve as B, candy eight first and the deep four last |
| D Max distinct | Found by greedy max-min search over saturated colours, counting colour-blind distances |

Controls: the bar at the bottom. ←/→ palette, 1/2/3 screen, `v` cycles simulated colour
vision (Machado 2009, full severity), `i` info, `h` hides the bar. Toggles for lane tint, an
ink edge under the pitch line, and the neutral lyric fill (slate or the sharing Players' colours
as stripes). URL parameters mirror the bar.

Finding before any reaction: the old amber `#FFB020` is the bottom stop of the golden-note
gradient (ΔE 0), so it cannot stay.

## Verdict

**B won**, in B's order (most distinct first), with three additions settled in the same round:
an ink edge under every pitch line, a slate `#7C82A0` lyric fill when several Players share a
Voice, and a white initial with an ink outline on every avatar. The colours keep fixed display
names. Owner's standing rule: the palette stays bright, colourful and fun; deep colours only as
rich jewel tones, never dull. Brightening B's deep four was tried and cut the first-four
separation from 33/20 to 25/14, so they stay as they are. The resolution comment on #26 holds the final list.
