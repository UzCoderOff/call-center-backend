# Ledger's phone line

Ledger runs its own phone system: **Asterisk on the same server**, next to the
backend.

- **Incoming calls:** clients call the company number, and the call-center
  operators are rung in turn.
- **Staff calls:** staff call clients and each other from the Ledger app.
- **Recording:** every client call is recorded on the server.
- **Calls in Ledger:** every call appears in Ledger by itself, exactly like a
  call synced from a phone, with the same call-back list, Telegram alerts,
  reports and strikes.

```
client's phone ──► outside line (SkyLine) ──► Asterisk [company-line] ──► queue "callcenter"
                                                   │                        │ rings operators in turn
                                                   │                        ▼
Ledger app (TLS + SRTP) ◄──────────────── [ring-person] ◄── wake? ── Ledger (127.0.0.1:4001)
                                                   │
                         when a call ends: files in /var/spool/ledger-pbx + a WAV
                                                   ▼
                             Ledger (src/services/pbx/ingest.js) → CallLog + MP3
```

## Who is on it

- **"Ledger calls"** (Xodimlar → person → Ish sozlamalari) gives a person a
  **phone ID**:
  - three digits from **201** up, never reused;
  - 101–104 and 112 are Uzbekistan's emergency numbers, so they are never used.
- **"Can call out"** lets them call numbers outside the firm. Without it they
  can only call colleagues.
- **The company line:** everyone with Ledger calls on and **call center** among
  their jobs answers it.
  - There is no on/off switch. A phone that doesn't answer is skipped after
    20 s.
  - A phone that fails to come up twice in a row rests, off the line, for
    10 minutes (`src/services/pbx/presence.js`).
- **A missed client call** belongs to the operator whose turn it was (rung
  first). If nobody could be rung, it goes to the call-center staff in turn
  (`summarizeCall` in `ingest.js`).

## The pieces

| What | Where |
|---|---|
| Asterisk settings (hand-made, in git) | `pbx/asterisk/*.conf` → `/etc/asterisk/` by `install.sh` |
| Phones that may sign in, busy/free hints, values for the dialplan (written by Ledger) | `/etc/asterisk/ledger/` (`src/services/pbx/config.js`, `provision.js`) |
| A small file per finished call | `/var/spool/ledger-pbx/calls/` (deleted once taken in) |
| Recordings while a call is on | `/var/spool/ledger-pbx/recordings/` (turned into MP3s in `STORAGE_ROOT/<employee>/`) |
| Ledger ↔ Asterisk | AMI on 127.0.0.1:5038 (`ami.js`); Asterisk asks Ledger on 127.0.0.1:4001 (`hooks.js`) |
| TLS certificates | `/etc/asterisk/keys/` (`make-ca.sh`; Ledger's own authority, valid 10 years) |

The backend and Asterisk share the `ledgerpbx` group:
- Ledger writes `/etc/asterisk/ledger`.
- Asterisk writes the call files and recordings, and Ledger reads and deletes
  them.

Without `PBX_AMI_SECRET` in `.env`, none of this runs. That is the case on a
test computer.

## Installing (or updating the settings)

```bash
cd ~/call-center-backend && git pull
bash pbx/install.sh
```

The script:
- installs asterisk, ffmpeg and fail2ban;
- backs up `/etc/asterisk`;
- adds the secrets to `.env` (`PBX_AMI_SECRET`, `PBX_HOOK_SECRET`,
  `PBX_SECRET_KEY`), keeping any that are already there;
- creates the folders and the certificates;
- installs the settings and restarts Asterisk;
- sets the firewall: 5161/tcp (phones, TLS) and 10000–10399/udp (call audio)
  open, 5160 (plain SIP) closed.

### After installing

The backend has to be restarted **from a new login**, so that it runs with the
`ledgerpbx` group:

```bash
exit                          # log out, then ssh in again
id | grep ledgerpbx           # must show it
pm2 kill && pm2 resurrect     # or: sudo systemctl restart pm2-$USER
pm2 logs --lines 30           # "[pbx] connected to Asterisk", "[pbx] hooks on 127.0.0.1:4001"
```

**Keep `PBX_SECRET_KEY`.** It encrypts the phones' sign-in hashes in the
database. If it's lost, every phone simply signs in again.

## Trying it with a softphone (before the Ledger app can call)

1. Xodimlar → a person → "Ledger calls" on.
2. Sozlamalar → Telefon liniyasi → that person → **Test sign-in**.
   - It shows a phone ID and password once.
   - Their Ledger app is signed out of the line until it signs in again.
3. In MicroSIP (Windows) or Zoiper, use:
   - **SIP server and domain:** `82.115.51.61.nip.io:5161`
   - **Transport:** TLS
   - **Media encryption:** SRTP (SDES)
   - **Username and password:** as shown
   - The certificate is Ledger's own, so accept it if the app asks.
4. Dial **500**: you play a client calling the company line, and the
   operators' softphones ring in turn.
5. Colleagues call each other by phone ID (201, 202…).

## The outside line (SkyLine)

When the operator delivers it:

1. Write `/etc/asterisk/pjsip_trunk.conf` with an endpoint named `skyline`:
   - `context=from-trunk`, `allow=alaw`, `dtmf_mode=rfc4733`;
   - their registration (login/password), or `identify` by their addresses;
   - the `from_user`/`from_domain` they require.
2. Reload: `sudo asterisk -rx "module reload res_pjsip.so"`.
3. Firewall: `sudo ufw allow from <their address> to any port 5160 proto udp`,
   once for each of their addresses.
4. Sozlamalar → Telefon liniyasi: the company number, and "outside line
   connected" on.
5. Check the number format they want: `TRUNK_PREFIX` in `extensions.conf`
   ("998" + 9 digits).

Only Uzbek numbers can be dialled out (`[staff-out]`). Anything abroad,
emergency or short numbers get refused. The outside line can only reach
`[company-line]`.

## Checking on it

```bash
sudo asterisk -rx "pjsip show contacts"        # phones signed in now
sudo asterisk -rx "queue show callcenter"      # who answers the company line
sudo asterisk -rx "core show channels"         # calls going on
ls /var/spool/ledger-pbx/calls                 # calls not yet taken in (should be empty)
sudo tail -50 /var/log/asterisk/messages.log
sudo fail2ban-client status asterisk           # addresses blocked for guessing
```
