# Pi image quickstart

How to get a Raspberry Pi 4/5 running the full Atlas stack — app, MQTT broker, local NTP
server, and the complete Tier A mTLS authentication chain — from a USB drive or SD card,
with one manual step (flashing) and one script (everything else).

This automates what `install.sh` plus the deployment-robustness scripts
(`provision-broker.sh`, `generate-tls-cert.sh`, `install-broker-cert.sh`,
`provision-cms-client-cert.sh`, `sync-mosquitto-scoresheet-acl.sh`,
`sync-mosquitto-tier-a.sh`) already do by hand, sequenced to run unattended on first boot.
See `docs/cross-platform-deployment-discussion.md` for the wider design context this grew
out of — this doc is the concrete, scoped-down "just get it running" version of that
broader (partly aspirational) discussion.

**Not automated here, deliberately**: WiFi zero-config (ethernet-first for this pass —
rpi-imager's own WiFi field works fine if you want wireless, just set it there), and the
first-boot forced-OS-password/locked-SSH hardening ideas from that discussion doc. This is
the "get it running to find the limits" version, not the polished organiser-onboarding one.

## 1. Flash the OS with rpi-imager

Open `rpi-imager` (already installed on this machine). Pick:
- **OS**: Raspberry Pi OS Lite (64-bit) — no desktop needed, this is a headless server.
- **Storage**: your actual target USB drive or SD card — double-check you've selected the
  right device in the picker before writing.
- **OS Customisation** (gear icon / Ctrl+Shift+X): set a **hostname** (`openpiste` matches
  what the rest of Atlas assumes — see CLAUDE.md), enable **SSH** (password or your own
  key), and set a **username/password**. Optionally configure WiFi here too if you want it
  instead of ethernet.

Write it. Don't eject yet.

## 2. Run `prepare-pi-firstboot.sh`

Once the write finishes, your desktop should auto-mount (or re-mount) the device's two
partitions — a small FAT32 "bootfs" and a larger ext4 root filesystem. Find the **root**
one's mount point (not the small boot one), then from this repo:

```bash
./scripts/prepare-pi-firstboot.sh <root-mountpoint> <username>
```

e.g. `./scripts/prepare-pi-firstboot.sh /media/you/rootfs pi` — `<username>` must exactly
match what you set in rpi-imager's customization step. The script refuses to run unless the
path really looks like a Raspberry Pi OS root (checks for `etc/rpi-issue`/`boot/firmware`),
and only ever writes two small files into it — it never touches the block device, partition
table, or does anything rpi-imager's own write didn't already do.

You may be prompted for your own (this desktop's) sudo password — expected, since the
mounted filesystem's system directories are root-owned like any real Linux root.

## 3. Eject, boot, wait

Unmount/eject the drive, put it in the Pi, power it on. First boot takes real time — this
is doing a full `apt`/`npm` install on Pi hardware, not a desktop, so budget 10-20+ minutes
depending on network speed and which Pi model.

Watch progress:
```bash
ssh <username>@openpiste.local
tail -f /var/log/atlas-firstboot.log
```

If `openpiste.local` doesn't resolve yet, the Pi may still be early in boot (avahi hasn't
started advertising yet) — try again in a minute, or use its IP address directly if your
router shows it.

## 4. Done

Browse to `https://openpiste.local:3001` (or `http://` on the same port before this device
has trusted the local CA — `/install-cert.html` walks through that, same as any other new
device per `generate-tls-cert.sh`'s own instructions).

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

### rpi-imager's OS Customisation silently does nothing (confirmed 2026-09-02)

Symptom: the Pi never shows up as `openpiste.local` (or under the hostname/SSH/user you
set), no matter how long you wait — because none of it was actually applied. Confirmed by
mounting the flashed root partition directly and checking: `/etc/hostname` was still the
factory default `raspberrypi`, SSH was `disabled`, and no custom user existed at all — the
OS Customisation dialog looked like it saved, but wrote nothing to the image. This is a
known, tracked, closed-as-not-planned bug in rpi-imager on the current default OS release
(Trixie) — [raspberrypi/rpi-imager#1444](https://github.com/raspberrypi/rpi-imager/issues/1444).
`atlas-firstboot.sh` detects this itself (waits up to 60s for the target user to exist,
then aborts rather than hanging or doing anything risky) — check
`/var/log/atlas-firstboot.log` for `User <name> still doesn't exist after 60s` to confirm
this is what happened to you.

**Fix — no need to reflash.** Bypass rpi-imager's customization pipeline entirely using
Raspberry Pi OS's own older, independent mechanism, which isn't affected by this bug:

```bash
# on this machine, with the boot (FAT32) partition mounted, e.g. /media/you/bootfs
touch /media/you/bootfs/ssh
echo "yourpassword" | openssl passwd -6 -stdin   # copy the $6$... hash it prints
echo '<username>:<hash-from-above>' > /media/you/bootfs/userconf.txt
```

Eject and boot as normal — Raspberry Pi OS's own boot scripts read `userconf.txt`/`ssh`
independently of the broken customization path, create the user, and enable SSH. The
already-written drive doesn't need to be reflashed; only the customization step had failed.
`atlas-firstboot.service` is still enabled from the earlier failed attempt and will
correctly re-trigger on this next boot.

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
