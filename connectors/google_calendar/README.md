# Google Calendar

Reads upcoming events and your busy times. There is no action that changes the calendar. Calendar data is personal, so a sub-agent cannot read it.

## Set up

1. Open Google Cloud Console in your own project. Turn on the Google Calendar API.
2. Make an OAuth client of type Web. Add the redirect address that TITAN shows in the connect window.
3. Paste the client id and the client secret. Choose Connect and approve the scope.

TITAN asks for `calendar.readonly` only. It refuses the wide `calendar` scope, the `calendar.events` scope, and the mail scope.

## The 7 day limit

While the consent screen of your Google Cloud project has the status Testing, Google ends the refresh token after 7 days. TITAN then shows Needs attention and you connect again. Move the consent screen to In production for your own account to stop this. For personal use, Google does not ask for a review. You will see a warning page when you approve. Choose Advanced and continue.

The refresh token stays in the vault. TITAN asks for a new access token when the old one has less than 2 minutes left.
