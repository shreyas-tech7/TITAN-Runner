# Google Calendar

Reads upcoming events and adds an event to your primary calendar. Calendar data is personal, so a sub-agent cannot read it.

## Set up

1. Open Google Cloud Console in your own project. Turn on the Google Calendar API.
2. Make an OAuth client of type Web. Add the redirect URL that TITAN shows in the connect window.
3. Paste the client id and the client secret. Choose Connect and approve the scope.

TITAN asks for `calendar.events` only. It refuses the wide `calendar` scope and the mail scope.

The refresh token stays in the vault. TITAN gets a new access token when the old one is near its end. If the project stays in test mode, Google ends the refresh token after 7 days. Move the consent screen to production for your own use to stop that.
