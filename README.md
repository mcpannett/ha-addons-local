# Local add-ons

Home Assistant add-on repository.

## Eufy Mega Security (experimental build)

An unofficial, experimental build based on [eufy-mega-security](https://github.com/mscodemonkey/eufy-mega-security) by mscodemonkey (MIT licence, see `LICENSE`). It is not supported by the upstream project; please do not report problems with this build upstream.

Base version: 0.1.259. Additions, all **off by default**:

- `experimental_e10_call_rollover_lead_s` (0 = off, 5–120): for E10 live views, open a second call this many seconds before the service's per-call limit and switch the video output to it at a keyframe, so the stream stays continuous. Never more than two calls at once; if the second call is refused it falls back to reconnecting without closing the output.
- `experimental_e10_call_limit_s` (default 300): the per-call limit used for the rollover timing.
- `experimental_e10_signal_tolerance` (`off` | `log` | `tolerate`) and `experimental_e10_signal_grace_ms`: value-free logging of unexpected E10 signalling messages, and optionally ignoring them while video keeps flowing.

Only run one instance of the gateway per Eufy account, and do not run it at the same time as the upstream add-on (both use port 3218).
