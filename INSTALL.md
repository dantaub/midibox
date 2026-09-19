# Installing MidiBox

MidiBox is a Bun server that reads a MIDI device, writes events to a local
SQLite file, and serves a web UI. Installing it means: get Bun, get the code,
and decide how it should start.

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- A MIDI keyboard on either:
  - **Linux** — an ALSA raw MIDI device (`/dev/snd/midiC*D*`), and a user in the
    `audio` group
  - **macOS** — any CoreMIDI device (MidiBox uses [JZZ](https://github.com/jazz-soft/JZZ))
- Disk for the recordings: roughly 50 MB per million events

## Get it running

```bash
git clone https://github.com/creationix/midibox.git
cd midibox
bun install
bun run start
```

Open <http://localhost:4000>. Play a few notes — they should appear on the
keyboard and timeline. `Ctrl-C` stops it.

If you see `No MIDI input available`, jump to [Troubleshooting](#troubleshooting).

## Run it as a service

Pick one. The first is what most people want.

### systemd (system service)

Starts at boot, runs whether or not anyone is logged in.

```bash
./scripts/install-service.sh
```

The installer detects systemd, fills your install directory, service user and
`bun` path into `scripts/midibox.service`, writes it to
`/etc/systemd/system/midibox.service`, copies `/etc/default/midibox`, adds the
user to `audio`, then enables and starts the unit.

```bash
sudo systemctl restart midibox
systemctl status midibox
journalctl -u midibox -f      # logs
```

Run it again and it refuses, printing the commands for the installation it
found rather than overwriting it. To reinstall — after moving the directory, or
to pick up a new unit file — pass `--force`; your `/etc/default/midibox` is
kept either way.

```bash
./scripts/install-service.sh --force
```

### systemd (user service)

No root needed. Good on a machine you log into, or where you'd rather keep
everything under your home directory.

```bash
mkdir -p ~/.config/systemd/user
sed -e "s|@MIDIBOX_USER@|$USER|g" \
    -e "s|@MIDIBOX_DIR@|$PWD|g" \
    -e "s|@MIDIBOX_BUN@|$(command -v bun)|g" \
    scripts/midibox.service > ~/.config/systemd/user/midibox.service

# A user unit can't set User= or SupplementaryGroups=
sed -i '/^User=/d; /^SupplementaryGroups=/d; /^ReadWritePaths=/d; /^ProtectSystem=/d' \
    ~/.config/systemd/user/midibox.service
sed -i 's|^WantedBy=.*|WantedBy=default.target|' ~/.config/systemd/user/midibox.service

systemctl --user daemon-reload
systemctl --user enable --now midibox
sudo loginctl enable-linger "$USER"   # keep it running after you log out
```

Logs: `journalctl --user -u midibox -f`. Your login user must already be in the
`audio` group (`sudo usermod -aG audio $USER`, then log out and back in).

### OpenRC (Alpine)

The same installer handles it:

```bash
./scripts/install-service.sh
sudo rc-service midibox start
```

It writes `/etc/init.d/midibox` with settings in `/etc/conf.d/midibox`, and logs
to `/var/log/midibox.log`. As with systemd, a second run refuses unless you pass
`--force`, and an existing `/etc/conf.d/midibox` is kept.

### By hand

For a quick trial, or on macOS where no service file is shipped:

```bash
bun run start                    # foreground
bun run dev                      # foreground, restarts on file changes
tmux new -s midibox 'bun run start'   # detached
```

On macOS, wrap `bun run start` in a launchd plist if you want it always on.

## Configuration

Everything is optional; the defaults work.

| Setting | Default | How to change it |
| ------- | ------- | ---------------- |
| Port | `4000` | `MIDIBOX_PORT` (or `PORT`) |
| Install / working directory | where you cloned it | `WorkingDirectory=` in the unit, `MIDIBOX_DIR` in `/etc/conf.d/midibox` |
| Service user | the user who ran the installer | `User=` in the unit, `MIDIBOX_USER` in `/etc/conf.d/midibox` |
| `bun` path | `command -v bun` | `ExecStart=` in the unit, `MIDIBOX_BUN` in `/etc/conf.d/midibox` |
| Database file | `midibox.db` in the working directory | move the directory, or symlink the file |

### Changing the port

**systemd:** edit `/etc/default/midibox`:

```sh
MIDIBOX_PORT=4100
```

then `sudo systemctl restart midibox`.

**OpenRC:** set `MIDIBOX_PORT` in `/etc/conf.d/midibox`, then
`sudo rc-service midibox restart`.

**By hand:** `MIDIBOX_PORT=4100 bun run start`.

### Changing the directory or user

Edit the unit (`sudo systemctl edit --full midibox`) and change
`WorkingDirectory=`, `User=` and `ReadWritePaths=` together — the last one must
match the working directory or the service can't write its database. Then:

```bash
sudo systemctl daemon-reload && sudo systemctl restart midibox
```

Re-running `./scripts/install-service.sh --force` from the new location does the
same thing and rewrites the unit.

## The database

One file, `midibox.db`, in the working directory. It holds every MIDI event and
every saved session. To back up a running instance, use the `sqlite3` CLI if you
have it (`apk add sqlite`, `apt install sqlite3`):

```bash
sqlite3 midibox.db ".backup '/tmp/midibox-backup.db'"
```

Without it, stop the service first and copy the file:

```bash
sudo systemctl stop midibox && cp midibox.db ~/midibox-backup.db && sudo systemctl start midibox
```

To keep it somewhere else (a bigger disk, say), stop the service, move the file,
and symlink it back:

```bash
sudo systemctl stop midibox
mv midibox.db /data/midibox.db
ln -s /data/midibox.db midibox.db
sudo systemctl start midibox
```

## Upgrading

```bash
git pull
bun install
sudo systemctl restart midibox
```

Schema changes are applied at startup and are safe to re-run. Take a backup
first if the release notes mention a migration.

## Uninstalling

```bash
sudo systemctl disable --now midibox
sudo rm /etc/systemd/system/midibox.service /etc/default/midibox
sudo systemctl daemon-reload
```

OpenRC: `sudo rc-update del midibox && sudo rm /etc/init.d/midibox /etc/conf.d/midibox`.

The clone and `midibox.db` are yours to delete.

## Troubleshooting

**`No MIDI input available` / nothing records.** Check the device is there and
readable:

```bash
ls -l /dev/snd/midi*
id -nG midibox-user | tr ' ' '\n' | grep audio
```

A raw MIDI device is usually `crw-rw----+ root audio`. A systemd service gets no
logind ACL, so group membership is what grants access — add the user to `audio`
and restart the service (group changes reach a service on restart, but a login
shell needs a fresh login).

**Notes record but nothing plays back.** The output has to be connected: the
`Connect Out` button in the header, or `POST /api/midi/output`. If connecting
fails, the error names the device and reason; a write failure to `/dev/snd/...`
means the same permission problem as above, or another process holding the
device.

**`Failed to start server. Is port 4000 in use?`** Something else is on the
port — often a second copy of MidiBox. `sudo systemctl stop midibox`, or pick
another port.

**`SysV service '/etc/init.d/midibox' lacks a native systemd unit file`.** An
OpenRC script is left in `/etc/init.d` on a systemd host. Remove it:

```bash
sudo rm /etc/init.d/midibox && sudo systemctl daemon-reload
```

**Reaching it from another machine.** The server listens on all interfaces, so
`http://<host>:4000` works across your LAN. There is **no authentication** —
keep it on a trusted network, or put it behind a reverse proxy that adds auth.
