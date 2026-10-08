# Documentation standard: Simplified Technical English

Write documentation in ASD-STE100 Simplified Technical English about 80 percent of the time. This rule applies to each new doc, code comment, commit body, pull request text, and prompt. Each future agent must obey it.

Code, identifiers, commands, quoted error text, and legal text stay as they are.

## The rules

1. Use short sentences. Use 20 words or less in a step and 25 words or less in a description.
2. Write one instruction in each sentence. Two actions can share a sentence only when they occur at the same time.
3. Use the imperative for instructions: "Run the tests."
4. Use the active voice.
5. Use simple tenses: present, past, and future with "will".
6. Do not use the `-ing` form of a verb. Technical names are an exception.
7. Keep the articles "a", "an", and "the". Do not write in telegraph style.
8. Use the same word for the same thing in every document. In TITAN, use these words:
    - "key": a provider API key
    - "token": a TITAN access token
    - "secret": a GitHub Actions secret
9. Put a condition before the instruction: "If the test fails, read the log."
10. Use a vertical list for three or more items. Put a colon before the list.
11. Write one topic in each paragraph. Use six sentences or less in a paragraph.
12. Start a warning or a caution with a clear command. Use a note only to give information.
13. Do not use contractions, em dashes, or semicolons.
14. Use noun clusters of three words or less.
15. Do not use slang or filler. Do not use words such as "seamless", "robust", "leverage", "delve", "pivotal", or "testament".

## Examples

| Do not write | Write |
|---|---|
| The key is being validated by the Worker before it gets saved. | The Worker checks the key. Then it saves the key. |
| Don't forget to rotate the token, it's important! | Rotate the token every 90 days. |
| Using the dashboard, keys can be added easily. | Add a key on the Keys page. |
| Webhook setup and testing should be done next. | Make the webhook. Then send a test message. |

## The check

The script `scripts/check-ste.mjs` checks Markdown files. It runs in CI and before each push.

- It checks only the lines that changed. Old text that did not change gives warnings.
- It skips code blocks, inline code, URLs, tables, and quotes.
- It fails on an em dash or a semicolon in prose.
- It warns about long sentences, "-ing" forms, contractions, passive voice, and en dashes.
- It prints a score. The score is the share of changed sentences that pass every rule. The run fails when the score is below 80.

Run the check for your own changes:

```bash
node scripts/check-ste.mjs --base origin/main
```

The file `docs/waves/WAVE12_BRIEF.md` is a word for word copy of the brief. The check skips it.
