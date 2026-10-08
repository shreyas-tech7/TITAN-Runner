# Gmail

Reads the headers and the first words of recent mail. Makes a draft in your Drafts folder. There is no send action, on purpose. A person must press Send. Mail is personal data, so a sub-agent cannot read it.

## Set up

1. Open Google Cloud Console in your own project. Turn on the Gmail API.
2. Make an OAuth client of type Web. Add the redirect URL that TITAN shows.
3. Paste the client id and the client secret. Choose Connect and approve the scopes.

TITAN asks for `gmail.readonly` and `gmail.compose`. It refuses `gmail.send`, `gmail.modify`, and the full mail scope. The scopes `gmail.readonly` and `gmail.compose` are restricted scopes. A personal project in test mode may use them for its own account. Google ends the refresh token after 7 days in test mode.

## Safe by design

- The `get_headers` action asks for the `From`, `Subject`, and `Date` headers and a snippet. It does not read the body.
- The connector has no action that sends, deletes, or changes labels.
