# Mobile push notifications

Waking a closed mobile softphone for incoming calls, end to end: how OpDesk does
RFC 8599 next to Asterisk, the Firebase and APNs keys, and signing a phone in with a QR code.

The recommended app is **[Medut Softphone](https://github.com/Ibrahimgamal99/medut-softphone)**
(Android and iOS). Any softphone that sends RFC 8599 Contact parameters works the same way.

## How it works (RFC 8599)

Android and iOS stop a closed app's network connection, so its SIP registration lapses
and Asterisk has nowhere to send the INVITE. RFC 8599 fixes this without any app-side API:
the softphone puts its push address in the **Contact URI of its REGISTER**:

```
Contact: <sip:201@10.0.0.5:51234;transport=tls
          ;pn-provider=fcm
          ;pn-prid=dXyZ…APA91b…
          ;pn-param=medut-generic-phone>
```

| Parameter | Android (FCM) | iOS (APNs) |
|---|---|---|
| `pn-provider` | `fcm` | `apns` (App Store / TestFlight) or `apns-sandbox` (debug builds) |
| `pn-prid` | FCM registration token | PushKit VoIP token, hex |
| `pn-param` | Firebase project ID | optional: `<Team ID>.<topic>` |

Asterisk's registrar keeps these parameters in the contact but does not act on them,
so OpDesk does the proxy's part:

1. **Learns the binding.** A separate AMI connection watches `ContactStatus` events and
   lists every contact (`PJSIPShowContacts`) at startup and every 10 minutes. Each
   `pn-*` triple is stored per extension in the `sip_push_bindings` table and kept after
   the registration expires: that is what lets OpDesk wake the phone for the next call.
2. **Pushes before dialing.** With Mobile Wake on, a hook in `[from-internal-custom]`
   runs before FreePBX resolves the extension's contacts. For an extension with a
   binding it calls OpDesk, which sends a `call` push.
3. **Holds the call.** The dialplan polls OpDesk every 0.5 s for up to the **hold time**
   until a mobile contact registers after the push: a new contact, or the same one with a
   later expiry. A mobile contact is one with `pn-*` parameters, or whose User-Agent
   contains the **mobile client marker**. A desk phone on the same extension therefore
   does not end the hold.
4. **Lets it ring.** After the **settle window** the call goes back to FreePBX as usual
   (ring groups, queues, follow-me, voicemail all unchanged), and the INVITE takes over the
   ring the push started.
5. **Cancels.** If the hold runs out, or the caller hangs up during it, OpDesk sends a
   `cancel` push so the phone stops ringing.

A provider that reports a token as dead (FCM `UNREGISTERED`, APNs `410` /
`BadDeviceToken`) has its bindings deleted; the phone adds a new one on its next REGISTER.
Bindings not seen for 90 days are pruned.

### Push payload

The Medut-SDK push contract. FCM sends it as a high-priority data-only message (all
values strings); APNs as a VoIP push with the fields at the top level.

| Field | `call` | `cancel` |
|---|---|---|
| `type` | `call` | `cancel` |
| `caller_uri` | `sip:<caller>@<host>` | — |
| `caller_name` | caller ID name, or the extension's name for internal callers | — |
| `aor` | `sip:<extension>@<host>` | `sip:<extension>@<host>` |

There is deliberately **no `call_id`**: Asterisk chooses the INVITE's Call-ID itself, and
the app rejects an INVITE whose Call-ID differs from the one its push named.

**APNs.** `apns-push-type: voip`, priority 10, expiration 0, topic `<bundle ID>.voip` (or the
topic in `pn-param`). `apns-sandbox` bindings always go to the sandbox host; `apns` goes to
production unless *Use APNs sandbox* is on. `cancel` is never sent over APNs: iOS ends an
app that receives a VoIP push without reporting a CallKit call. On iPhone an unanswered
push ends as a missed call.

## Settings → Mobile Wake

| Setting | Default | What it does |
|---|---|---|
| Enabled | off | Installs the pre-dial hook and reloads the Asterisk dialplan. |
| Hold time | 10 s (8–30) | Longest the caller waits for the phone to wake and re-register. |
| Settle window | 3 s (0–10) | Extra wait after the re-registration before the call rings. |
| Mobile client marker | `Medut` | Text in the SIP User-Agent that marks a mobile client. Medut sends `Medut/<version> (android\|ios)`. |
| FCM project ID | from the key | Must equal `pn-param` in the phone's REGISTER; others are skipped. |
| Service account JSON | — | Upload; stored in the OpDesk database. |
| Key ID / Team ID / Bundle ID | — | From the Apple Developer account. |
| Auth key (`.p8`) | — | Upload; stored in the OpDesk database. Uploading `AuthKey_<KeyID>.p8` fills in the Key ID. |
| Use APNs sandbox | off | Sandbox host for bindings that say only `apns`. |
| Web push (VAPID) | — | *Create keys* / *Replace keys*. Replacing deletes every browser subscription; browsers subscribe again on their next visit. |

The page also lists the **registered devices** (extension, provider, masked token, app,
last seen) and can forget one.

Settings saved in the UI take precedence over `backend/.env`. The old variables
(`FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_FILE`, `APNS_*`, `VAPID_*`, `MOBILE_WAKE_WAIT`,
`MOBILE_WAKE_SETTLE`) still work as a fallback.

## Firebase (Android)

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
   and add the Android app (Medut: `com.medut.generic.phone`). The app build needs that
   project's `google-services.json`.
2. **Project settings → Service accounts → Generate new private key**.
3. Upload the downloaded JSON under **Settings → Mobile Wake → Android (FCM)**. The project
   ID fills in from the key.

## APNs (iOS)

1. [developer.apple.com → Certificates, IDs & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list)
   → **+** → check **Apple Push Notifications service** → download `AuthKey_XXXXXXXXXX.p8`.
   The 10-character suffix is the **Key ID**; the **Team ID** is at the top right of the portal.
2. Enter the Team ID and the app's bundle ID, and upload the `.p8` under
   **Settings → Mobile Wake → iOS (APNs)**.

APNs is called directly from the server; the key never leaves it.

## Signing a phone in with a QR code

- **Everyone:** profile menu (top right) → **Mobile app QR**, for their own extension.
- **Admins:** **Users** → the QR button on any user with an extension.

The code is Medut's [account JSON](https://github.com/Ibrahimgamal99/medut-softphone/blob/main/docs/account-setup.md)
with no `transport`, so Medut signs in on *Auto*: it tries TLS, TCP, UDP and secure WebSocket
at once and keeps the first that registers (for WebSocket it finds OpDesk's `/sip-ws` on 443).
The code carries no port, so when OpDesk runs on another HTTPS port (such as 8443 next to
FreePBX's Apache) the WebSocket attempt misses it and the phone uses TLS, TCP or UDP.

```json
{"name": "OpDesk 100", "uri": "100@pbx.example.com", "password": "…", "display_name": "Sara"}
```

Without `OPDESK_DOMAIN` (self-signed certificate) the code adds `"verify_tls": false`.
*Include the password* is on by default: one scan signs in, so treat the code like the
password. Turn it off for a code you print or share; the app then asks for the password.

The same profile menu has **Change SIP password**: confirmed with the OpDesk sign-in
password, it sets a new extension secret (8–64 characters, letters and digits) and reloads
Asterisk. Every phone on the extension has to sign in again; the dialog offers the new QR.

## App-registered tokens (older clients)

Clients that do not use RFC 8599 can still register tokens themselves with
`POST /api/device-tokens` (iOS posts an `alert` token and a `voip` PushKit token) and remove
them with `DELETE /api/device-tokens`. They are woken by the same pre-dial hook, with the
legacy payload `{ type: "incoming_call", extension, caller, call_id, display_name }`, plus a
push on `DialBegin` for calls that skip the hook. For them, any new or refreshed contact on
the extension ends the hold.

## Troubleshooting

- **No devices listed.** The phone's REGISTER has no `pn-*` parameters: in Medut, check
  that push is on for the account and, on Android, that the build has `google-services.json`.
  `sudo asterisk -rx "pjsip show contacts"` shows the Contact URIs Asterisk stored.
- **FCM binding skipped** in the log: `pn-param` (the app's Firebase project) differs from
  the FCM project ID in Settings.
- **iPhone never rings.** A debug build registers `apns-sandbox` and must reach the sandbox
  host; a mismatch fails silently at Apple.
- **Call waits the full hold time.** The phone woke but did not re-register in time: raise
  the hold time, and check the app's connection log. With a desk phone on the same
  extension, make sure the marker matches the mobile app's User-Agent and not the desk phone's.
