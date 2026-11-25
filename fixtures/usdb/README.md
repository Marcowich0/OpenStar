# Fake USDB pages

The pages the fake USDB (`crates/test-harness`, `FakeUsdb`) serves, and that the
USDB parsers (#47) are tested against. No test ever talks to the real USDB.

## How a request finds its page

- `/` or `/index.php` with `link=<name>` and `id=<n>` in the query:
  `<name>-<n>.html`, else `<name>.html`. With no `link`: `home.html`.
- Any other path: the file at that path below `static/` (for example a cover at
  `static/data/cover/1.jpg`).
- Nothing found: 404.
- A test can script the next requests to get an error status with
  `Retry-After`, or `not-logged-in.html`.

## The pages

The pages here are minimal placeholders that keep USDB's routes, so the harness
works before the USDB client exists. #47 replaces each with a saved real page,
stripped down, with **placeholder lyrics and made-up song data only**
([`../README.md`](../README.md) rule 2): never a real Song's text.

| File                 | Stands in for                                    |
| -------------------- | ------------------------------------------------ |
| `home.html`          | the start page (also the answer to a login POST) |
| `list.html`          | the song list (`?link=list`)                     |
| `detail-1.html`      | the detail page of song 1 (`?link=detail&id=1`)  |
| `gettxt-1.html`      | the `.txt` of song 1 (`?link=gettxt&id=1`)       |
| `not-logged-in.html` | the page USDB shows when the login is missing    |
