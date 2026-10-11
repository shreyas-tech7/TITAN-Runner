# RSS and Atom

Reads a public feed. It needs no key. The data is public. The host comes from the address that you typed, so the broker checks its DNS answer on each call and refuses a private address.

## Set up

Paste the https address of a feed. Choose Test. TITAN fetches the feed, reads at most 256 KB, and shows the first item.

## Limits

- The reader parses RSS 2.0 and Atom 1.0 with simple text rules. It does not run scripts. It drops all markup from titles and summaries.
- A redirect is refused. Paste the final address.
