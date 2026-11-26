# Fake USDB pages

The pages the fake USDB (`crates/test-harness`, `FakeUsdb`) serves, and that the
USDB parsers (#47) are tested against. No test ever talks to the real USDB.

## How a request finds its page

- `/` or `/index.php` with `link=<name>` and `id=<n>` in the query:
  `<name>-<n>.html`, else `<name>.html`. With no `link`: `home.html`.
- Any other path: the file at that path below `static/` (for example a cover at
  `static/data/cover/1.jpg`).
- Nothing found: 404.
- Logins: `POST ?link=login` with the fake credentials (`user`, `pass`,
  `login=Login`) answers `home.html` with the session cookie
  `PHPSESSID=fake-usdb-session`; other credentials get no cookie.
  `?link=profil` without that cookie serves `logged-out/profil.html`. Every
  other page is served whatever the cookie.
- A test can script the next requests to get an error status with
  `Retry-After`, or `not-logged-in.html` (or the normal answer, to let some
  requests through first).
- Once a test gives the fake a song list (`FakeUsdb::set_songs`),
  `POST ?link=list` renders pages of it in `list.html`'s row shape (`limit`,
  `start`, `order=lastchange` or by id, `ud`) instead of serving `list.html`.

## The pages

The repository is public, so these pages are **reconstructed, not saved from
USDB**: nobody logged in to USDB to make them ([`../README.md`](../README.md)
rule 2). Each keeps the HTML shape of USDB's real pages as saved in
usdb_syncer's test resources (`bohning/usdb_syncer` @ `1a4b048`,
`tests/resources/html/usdb-animux-de/`) and as its scraper
(`src/usdb_syncer/usdb_scraper.py`) reads them, stripped to what the parsers
need, with **made-up song data and placeholder lyrics only**. The "not logged
in" page and the profile pages have no saved original anywhere: they are the
standard page frame with the sentence and greeting other clients' code looks
for. When someone with a USDB account checks a real page against these,
update the page here and say so in this file.

| File                     | Stands in for                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `home.html`              | the start page (also the answer to a login POST)                                                    |
| `list.html`              | a song list page (`POST ?link=list`), 3 rows: entities, no cover, no year, half stars               |
| `detail-1.html`          | the detail page of song 1 (`?link=detail&id=1`) read without a login, with 3 comments, newest first |
| `gettxt-1.html`          | the text of song 1 (`POST ?link=gettxt&id=1`): `Re: Stacks`, `&amp;amp;`, `#VIDEO` with `v=`/`a=`   |
| `gettxt-2.html`          | the text of song 2: a 1.x text (`#VERSION`) whose `#VIDEO` is a plain link                          |
| `profil.html`            | the profile page (`?link=profil`) when logged in as `fake-usdb-user`                                |
| `not-logged-in.html`     | the page USDB shows when the login is missing                                                       |
| `logged-out/profil.html` | the profile page without a login (served for `?link=profil` without the session cookie)             |
| `song-txt/*.txt`         | the `song.txt` a Download writes from `gettxt-1` (with a cover) and `gettxt-2` (without), by hand   |

Known differences from the real site that the parsers rely on, all from
usdb_syncer's saved pages: list rows carry `data-songid` and
`data-lastchange` (Unix seconds); stars are `images/star.png`,
`images/half_star.png` and `images/star2.png` (empty); a comment's header row
is `<tr class="list_tr2"><td>DD.MM.YY - HH:MM | author`, newest comment first;
a detail page read without a login carries "You are not logged in. Login to
use this function." inside its comment form, which does not make it the "not
logged in" page.
