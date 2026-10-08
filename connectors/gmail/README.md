# Gmail

Reads the headers and the first words of unread mail. Makes a draft in your Drafts folder. There is no send action, on purpose. A person must press Send. Mail is personal data, so a sub-agent cannot read it.

## Set up

1. Open Google Cloud Console in your own project. Turn on the Gmail API.
2. Make an OAuth client of type Web. Add the redirect address that TITAN shows.
3. Paste the client id and the client secret. Choose Connect and approve the scopes.

TITAN asks for `gmail.readonly` and `gmail.compose`. It refuses `gmail.send`, `gmail.modify`, and the full mail scope `https://mail.google.com/`.

## The 7 day limit

While the consent screen has the status Testing, Google ends the refresh token after 7 days. Move the consent screen to In production for your own account to stop that. Gmail scopes are restricted scopes. For use with your own account only, Google does not ask for a review, but you see a warning page when you approve. Choose Advanced and continue.

## Safe by design

- The `get_message` action asks for the `From`, `Subject`, and `Date` headers and a snippet. It does not read the body.
- The connector has no action that sends, deletes, or changes labels.
