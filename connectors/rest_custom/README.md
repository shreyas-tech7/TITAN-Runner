# Custom REST API

Calls a JSON API that has no connector of its own. You give the base address, how the API wants the key, and the paths that TITAN may call.

## Safety rules

- The base address must use https and must hold no query and no fragment.
- A path must start with one `/`. It must not hold `..`, `?`, `#`, or a backslash. The final address must keep the host of the base address.
- Only paths that start with one of your allowed prefixes work. The default prefix is `/`, which allows all paths on that host. Set a narrow list.
- The data class is `personal`. A sub-agent cannot use this connector.
- `GET` is a read action. `POST`, `PUT`, `PATCH`, and `DELETE` are write actions that need approval unless you set them to auto-approve.
- The broker resolves the host through DNS over HTTPS and refuses a private or loopback answer. A redirect is refused.

## Key styles

| Style | What TITAN sends |
|---|---|
| `bearer` | `Authorization: Bearer <key>` |
| `header` | `<header name>: <key>` |
| `basic` | `Authorization: Basic base64(user:key)` |
| `none` | no key |
