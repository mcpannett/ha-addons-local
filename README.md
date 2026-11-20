# Local add-ons

Home Assistant add-on repository.

## Eufy Mega Security (experimental build)

An unofficial, experimental build based on [eufy-mega-security](https://github.com/mscodemonkey/eufy-mega-security) by mscodemonkey (MIT licence, see `LICENSE`). It is not supported by the upstream project; please do not report problems with this build upstream.

Base version: 0.1.259. Additions, all **off by default**:

- `experimental_e10_call_rollover_lead_s` (0 = off, 5–120): for E10 live views, open a second call this many seconds before the service's per-call limit and switch the video output to it at a keyframe, so the stream stays continuous. Never more than two calls at once; if the second call is refused it falls back to reconnecting without closing the output.
- `experimental_e10_call_limit_s` (default 300): the per-call limit used for the rollover timing.
- `experimental_e10_signal_tolerance` (`off` | `log` | `tolerate`) and `experimental_e10_signal_grace_ms`: value-free logging of unexpected E10 signalling messages, and optionally ignoring them while video keeps flowing.

Other E10 options added later (rollover mode, health guard, reconnect after refusal, route log, no relay, local stream key, LAN probe) are described below and in [`eufy_event_gateway_e10x/CHANGELOG.md`](eufy_event_gateway_e10x/CHANGELOG.md).

## Status (20 Nov 2026, version 0.1.259.8)

Tested on a real Window Camera E10 (T8404), standalone Wi-Fi, viewed continuously in Frigate:

| | Result |
|---|---|
| Stream past Eufy's 5-minute call limit | **Works.** About 1 hour over two tests, 12 sequential rollovers (one every ~4.5 min), one call at a time, no recoveries, no errors |
| Video route | **LAN.** All 14 logged calls went direct on the home network (`host` → `prflx`, private address). None used Eufy's relay, even with the relay allowed |
| No relay on | **Works.** Every call `path=lan lan=true`, stream unchanged |
| Smoothness | ~15 fps. Switch-over gaps hidden (Frigate max gap under 300 ms at handovers); one isolated 964 ms gap mid-call |
| Fully local (no Eufy servers) | **Not possible on current firmware.** The E10 does not answer the PPCS LAN lookup on UDP 32108 (3/3 rounds), and it has no RTSP |

In short: Eufy's servers still set up each call every ~5 minutes, but the video itself stays on the LAN, and the rollover keeps the stream continuous.

**Recommended E10 settings:** call rollover lead `30`, rollover mode `sequential`, health guard on, route log on, no relay on. LAN probe off (diagnostic only).

Only run one instance of the gateway per Eufy account, and do not run it at the same time as the upstream add-on (both use port 3218).

### e10x7: keep E10 video on the LAN (all opt-in)

- `experimental_e10_route_log` (default on): each E10 call logs `e10_route path=lan|nat|relay`. No addresses are logged. `lan` means the camera's address is on your home network and no relay is used (e10x8: also when the camera candidate is `prflx`).
- `experimental_e10_no_relay` (default off): never use Eufy's video relay for E10 calls. If the camera can't be reached directly, live view fails, so check the route log first.
- `experimental_e10_reconnect_on_refusal` (default on): now switchable in the UI.
- `experimental_e10_local_stream_key` (default empty = off): a key of 24+ characters you choose. It lets go2rtc/Frigate use one stable URL that never expires:

  ```yaml
  # go2rtc
  streams:
    e10: ffmpeg:http://<HA-IP>:3218/api/cameras/<E10-SERIAL>/live.ts?key=<YOUR-KEY>#video=copy
  ```

  Turn on call rollover (`experimental_e10_call_rollover_lead_s`, e.g. 30) so the stream carries on past Eufy's 5-minute call limit. Only E10 stream URLs accept the key.

Eufy still has to set up each call over the internet (every ~5 minutes). Video can stay local; call setup cannot.

- `experimental_e10_lan_probe` (default off, read-only): after sign-in, asks the E10 three times (a minute apart) on UDP 32108 whether it answers the local lookup other Eufy cameras answer. It sends only the 4-byte LAN search and logs `e10_lan_probe answered=true|false` with no addresses. If the inventory has no LAN address for the E10, set `experimental_e10_lan_ip` to its IP from your router. `answered=true` means a fully local stream might be possible. `answered=false` on all three rounds means it isn't, with current firmware.

Fake-call tests (no camera needed): `npm run test:e10`.

**Rollback:** branch `backup/pre-e10x7` marks the last e10x6 commit. To go back, reset `main` to that branch (or revert the merge), bump `version` in `config.yaml` above the current one, and update the add-on in HA.

**Versions:** from 0.1.259.7 the add-on uses plain numbers (`0.1.259.N`). HA's update button could not tell `-e10x7` was newer than `-e10x6`.
