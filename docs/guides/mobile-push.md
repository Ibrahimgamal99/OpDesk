# Mobile push notifications

Waking a mobile softphone for incoming calls, end to end: Firebase, APNs, and the
`.env` values that tie them together.

OpDesk can wake a mobile softphone (Flutter / native iOS / Android) for incoming calls without
keeping a background socket alive. Two push paths cover both app states:

- **App killed** — a dialplan hook fires *before* SIP contact resolution, CURLs
  `/api/internal/mobile-wake/<ext>` to send the wake push, waits for the app to re-register,
  then hands the call back to FreePBX normally.
- **App backgrounded** — Asterisk emits `DialBegin` as usual; the AMI handler calls
  `push_service.send_call_wake()` which sends a high-priority FCM data message (Android /
  `flutter_callkit_incoming`) or an APNs VoIP push via PushKit (iOS / CallKit). On missed call,
  `send_alert()` delivers a standard notification banner on both platforms.

The mobile client registers tokens with `POST /api/device-tokens` after login (iOS posts twice:
an `alert` token and a `voip` PushKit token) and removes them with `DELETE /api/device-tokens`
on logout. Payload on wake: `{ type, extension, caller, call_id, display_name }`.

## Firebase setup (Android + iOS alert push)

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com), add Android and iOS apps.
2. Download `google-services.json` → `android/app/` and `GoogleService-Info.plist` → `ios/Runner/`.
3. Project Settings → **Service accounts** → **Generate new private key** → save to `/opt/OpDesk/secrets/fcm-service-account.json`. Note your **Project ID**.

## APNs setup (iOS VoIP + CallKit)

1. [developer.apple.com → Certificates, IDs & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list) → **+** → check **Apple Push Notifications service** → Download.
2. File is named `AuthKey_XXXXXXXXXX.p8` — the 10-char suffix is your **Key ID**. **Team ID** is top-right on the portal.
3. Place the file at `/opt/OpDesk/secrets/AuthKey_XXXXXXXXXX.p8`.

> APNs is called directly from the server — the iOS app never touches the key. The VoIP topic is `<APNS_BUNDLE_ID>.voip` automatically.

## Fill in `.env`

The installer already writes all push variables into `backend/.env` (empty). Just fill in the values:

| Variable | What to put |
|----------|-------------|
| `FCM_PROJECT_ID` | Firebase Project ID (Project Settings page) |
| `FCM_SERVICE_ACCOUNT_FILE` | `/opt/OpDesk/secrets/fcm-service-account.json` (already set) |
| `APNS_AUTH_KEY_FILE` | `/opt/OpDesk/secrets/AuthKey_XXXXXXXXXX.p8` (rename to match) |
| `APNS_KEY_ID` | 10-char suffix from the `.p8` filename |
| `APNS_TEAM_ID` | Apple Developer Team ID (top-right on the portal) |
| `APNS_BUNDLE_ID` | Your app's bundle ID |
| `APNS_USE_SANDBOX` | `true` for dev/TestFlight, `false` for App Store |

Then restart: `systemctl restart opdesk`.
