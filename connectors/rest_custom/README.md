# Custom REST API

Calls a JSON API that has no connector of its own. You give the base address and, if needed, a key. The key goes in one header, and you choose the name and the prefix.

## Safety rules

- The base address must use https and must hold no query and no fragment.
- A path must start with one `/`. It must not hold `..`, `?`, or `#`. The final address must keep the same host as the base address.
- The data class is `personal`. A sub-agent cannot use this connector.
- The broker resolves the host through DNS over HTTPS and refuses a private or loopback answer. A redirect is refused.
- A `POST` needs approval unless you set the action to auto-approve.
