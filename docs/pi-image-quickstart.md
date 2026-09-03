# Pi image quickstart

How to get a Raspberry Pi 4/5 running the full Atlas stack — app, MQTT broker, local NTP
server, and the complete Tier A mTLS authentication chain — from a USB drive or SD card,
with two manual steps (flashing, and a quick file drop for the user account — see step 2's
note on why) and one script (everything else).

This automates what `install.sh` plus the deployment-robustness scripts
(`provision-broker.sh`, `generate-tls-cert.sh`, `install-broker-cert.sh`,
`provision-cms-client-cert.sh`, `sync-mosquitto-scoresheet-acl.sh`,
`sync-mosquitto-tier-a.sh`) already do by hand, sequenced to run unattended on first boot.
See `docs/cross-platform-deployment-discussion.md` for the wider design context this grew
out of — this doc is the concrete, scoped-down "just get it running" version of that
broader (partly aspirational) discussion.

**Not automated here, deliberately**: WiFi zero-config (ethernet-first for this pass — see
step 2's note on WiFi), and the first-boot forced-OS-password/locked-SSH hardening ideas
from that discussion doc. This is the "get it running to find the limits" version, not the
polished organiser-onboarding one.

## 1. Flash the OS with rpi-imager

Open `rpi-imager` (already installed on this machine). Pick:
- **OS**: Raspberry Pi OS Lite (64-bit) — no desktop needed, this is a headless server.
- **Storage**: your actual target USB drive or SD card — double-check you've selected the
  right device in the picker before writing.
- **OS Customisation** (gear icon / Ctrl+Shift+X): **skip it, or fill it in if you like —
  either way, don't rely on it.** On the current default OS release (Trixie),
  rpi-imager 1.8.5's customization step (hostname/SSH/user/WiFi) silently fails to apply —
  a known, tracked, closed-as-not-planned upstream bug
  ([raspberrypi/rpi-imager#1444](https://github.com/raspberrypi/rpi-imager/issues/1444)).
  The dialog looks like it saves, and nothing downstream happens. Step 2 below sets the
  user/SSH the reliable way instead, so there's no need to fight the dialog.

Write it. Don't eject yet.

## 2. Set the user account and enable SSH by hand

Once the write finishes, your desktop should auto-mount (or re-mount) the device's two
partitions — a small FAT32 "bootfs" and a larger ext4 root filesystem. This bypasses
rpi-imager's broken customization pipeline entirely, using Raspberry Pi OS's own older,
independent mechanism (its boot scripts read these two files directly, unrelated to the
`firstrun.sh` path the customization dialog would have used):

```bash
# with the boot (FAT32) partition mounted, e.g. /media/you/bootfs
touch /media/you/bootfs/ssh
echo "yourpassword" | openssl passwd -6 -stdin   # copy the $6$... hash it prints
echo '<username>:<hash-from-above>' > /media/you/bootfs/userconf.txt
```

Pick whatever `<username>` you want — you'll pass it again in step 3. This flow assumes
ethernet (deliberately, see "Not automated here" above); if you need WiFi, rpi-imager's own
WiFi field in the customization dialog may or may not be affected by the same bug — worth
testing separately rather than assuming it works.

## 3. Run `prepare-pi-firstboot.sh`

Find the **root** partition's mount point (not the small boot one you just used), then
from this repo:

```bash
./scripts/prepare-pi-firstboot.sh <root-mountpoint> <username>
```

e.g. `./scripts/prepare-pi-firstboot.sh /media/you/rootfs pi` — `<username>` must exactly
match what you used in `userconf.txt` above. The script refuses to run unless the path
really looks like a Raspberry Pi OS root (checks for `etc/rpi-issue`/`boot/firmware`), and
only ever writes two small files into it — it never touches the block device, partition
table, or does anything rpi-imager's own write didn't already do.

You may be prompted for your own (this desktop's) sudo password — expected, since the
mounted filesystem's system directories are root-owned like any real Linux root.

## 4. Eject, boot, wait

Unmount/eject the drive, put it in the Pi, power it on. First boot takes real time — this
is doing a full `apt`/`npm` install on Pi hardware, not a desktop, so budget 10-20+ minutes
depending on network speed and which Pi model.

Watch progress:
```bash
ssh <username>@raspberrypi.local
tail -f /var/log/atlas-firstboot.log
```

Note the hostname stays the OS default (`raspberrypi`, not `openpiste`) — step 2's file
drop only sets the user account and SSH, not the hostname rpi-imager's (broken) dialog
would have. If `raspberrypi.local` doesn't resolve yet, the Pi may still be early in boot
(avahi hasn't started advertising yet) — try again in a minute, or use its IP address
directly if your router shows it. Once logged in, `sudo bash scripts/set-hostname.sh` sets
it to `openpiste` (matching what the rest of Atlas assumes) if you want that — optional,
not required for anything in this doc to work.

## 5. Done

Browse to `https://raspberrypi.local:3001` (or `http://` on the same port before this
device has trusted the local CA — `/install-cert.html` walks through that, same as any
other new device per `generate-tls-cert.sh`'s own instructions; swap in `openpiste.local`
if you ran `set-hostname.sh` above).

The admin PIN `install.sh` generates is in the log:
```bash
sudo grep -A5 'ADMIN CREDENTIALS' /var/log/atlas-firstboot.log
```
You'll be forced to change it on first login.

## If something goes wrong

`atlas-firstboot.sh` isn't designed to be idempotent as a whole (it only ever runs once,
gated by `/opt/.atlas-firstboot-done`) — but every individual step it calls is safe to
re-run by hand. Find where the log stopped, fix whatever broke, then re-run that one script
directly over SSH (e.g. `cd ~/AtlasCompetitionManager && sudo bash install.sh`, or
`./scripts/provision-broker.sh --yes`, etc.) rather than trying to re-trigger the whole
first-boot unit.

### The Pi never shows up / user doesn't exist after boot

If you followed step 1's advice and used rpi-imager's OS Customisation dialog anyway
instead of step 2's file drop, you may hit this: the dialog looks like it saves, but on
the current default OS release (Trixie) it silently writes nothing to the image — no
`firstrun.sh`, no user, no SSH — a known, tracked, closed-as-not-planned upstream bug
([raspberrypi/rpi-imager#1444](https://github.com/raspberrypi/rpi-imager/issues/1444)).
`atlas-firstboot.sh` detects this itself (waits up to 60s for the target user to exist,
then aborts rather than hanging) — check `/var/log/atlas-firstboot.log` for `User <name>
still doesn't exist after 60s` to confirm this is what happened.

**Fix — no need to reflash.** Do step 2's `userconf.txt`/`touch ssh` file drop now (the
already-written drive is otherwise fine; only the customization step failed), eject, and
boot again. `atlas-firstboot.service` is still enabled from the earlier failed attempt and
will correctly re-trigger on this next boot.

### First boot is extremely slow (hours, not minutes)

If you watched `install.sh` grind through installing dozens of unrelated packages
(`node-babel7`, `node-istanbul`, `node-tape`, and similar) while "setting up" `nodejs`/`npm`
— that was a real bug, fixed 2026-09-02. Debian/Raspberry Pi OS's `apt install nodejs npm`
packages pull in a large chunk of Debian's own packaged Node ecosystem (test frameworks,
transpilers, coverage tools) that Atlas never uses, since it installs its own dependencies
via `npm ci` against `package.json`. `install.sh` now installs Node.js directly from
NodeSource instead, which is self-contained and skips all of it. If you're re-testing after
pulling a fresh copy of this repo, you shouldn't see this anymore; if you do, `install.sh`
itself is the thing to check first, not your hardware.

`install.sh`'s package list was also trimmed (2026-09-03): `build-essential`/`python3`
(node-gyp's compile toolchain) are no longer installed upfront — `npm ci` tries a
prebuilt `better-sqlite3` binary first (confirmed one exists for linux-arm64 + Node 20)
and only falls back to installing the compiler toolchain and rebuilding from source if
that fails. `p7zip-full`, `sqlite3` (the CLI), and `lsof` are dropped entirely from the
default install — they're only needed by the optional failover-bundle scripts or manual
debugging, and those scripts/`docs/admin-manual.md` now tell you how to install them
on demand if you need them.

### The Pi's clock is wrong, apt fails signature checks, everything crawls

Symptom: `atlas-firstboot.log`'s very first line shows an obviously wrong date (e.g.
months in the past), and the `apt-get install` right after it fails with `Verifying
signature: Not live until <some future date>` for every Debian repo, falling back to
stale cached package indexes. Confirmed real (2026-09-03): a Pi has no battery-backed
RTC, so a cold first boot can start with the clock stuck wherever the OS image left it
— from the clock's own wrong point of view, today's real repo signatures look like
they're from the future. `apt` still limps forward on the stale fallback rather than
hard-failing, so this shows up as things being unusually slow rather than an outright
error — easy to mistake for "the whole install just takes this long."

Fixed for future flashes (`prepare-pi-firstboot.sh` now orders `atlas-firstboot.service`
after `time-sync.target`, not just `network-online.target`, so NTP gets a chance to
correct the clock before `apt`/`git clone`/any certificate operation runs). If you're
re-testing after pulling a fresh copy of this repo, you shouldn't see the "Not live
until" errors anymore.
