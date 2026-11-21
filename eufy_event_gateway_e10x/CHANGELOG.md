# Changelog

Experimental E10 build of eufy-mega-security (base 0.1.275).

## 0.1.275.1 (21 Nov 2026)

- **Rebased on upstream 0.1.275** (from 0.1.259): picks up 16 upstream releases of fixes, including upstream's own E10 work (relay permission renewal, keepalive profile, keeping connected E10 video after a signalling hangup). Upstream still documents the E10 five-minute stop as unresolved, so the call rollover here is unchanged.
- All E10 options are unchanged and keep their defaults. With call rollover on, a signalling hangup still ends the call so the next call takes over (as before); with it off, upstream's keep-video-after-hangup applies.
- Route log now also runs alongside upstream's peer-evidence tracking.
- Not yet hardware-tested on this base: check the stream for 15+ min after updating (rollover lines in the log), and roll back if anything regresses.

## 0.1.259.8 (20 Nov 2026)

- **Route log fix:** an E10 call is now reported as `path=lan lan=true` when no relay is used and the camera's address is private, including the `prflx` route the E10 actually uses. Before this it was wrongly shown as `path=nat`. Log-only change.
- **Tested on hardware:** with **no relay** on, all calls ran on the LAN, rollover was clean every ~4.5 min, and there were no recoveries or errors.

## 0.1.259.7 (20 Nov 2026)

- **New: route log** (on by default, value-free): each E10 call logs whether video went over the LAN, a NAT route or Eufy's relay.
- **New: no relay** (off by default): E10 calls never use Eufy's video relay, so video can only go direct.
- **New: local stream key** (empty = off): a fixed key that opens E10 `live.ts` / `live.h264` URLs only, for a permanent go2rtc/Frigate link.
- **New: LAN probe** (off by default, read-only): checks whether the E10 answers a local PPCS lookup. Result on current firmware: it does not.
- **Options:** reconnect after a refused call is now switchable; every E10 option has a label and description; the country defaults to GB.
- **Versioning:** plain numbers (`0.1.259.N`) so HA's Update button works. `-e10x7` was not seen as newer than `-e10x6`.
- **Testing:** fake-camera tests (`npm run test:e10`), and GitHub CI (typecheck, tests, build, HA version check) on every push.
- **Tested on hardware:** about 38 min continuous, 8 rollovers, one call at a time, ~15 fps.

## 0.1.259-e10x6 and earlier

- E10 call rollover (`overlap` or `sequential`), health guard, reconnect after refusal and signal tolerance. See the README.

## Rollback

Branch `backup/pre-e10x7` holds the e10x6 version. HA keeps its own backup when you update with "Keep backup" on.
