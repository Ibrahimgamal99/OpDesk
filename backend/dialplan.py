#!/usr/bin/env python3
"""
QoS (Quality of Service) Configuration Module

Enables QoS tracking by configuring Asterisk dialplan files.
"""

import logging
import os
import subprocess
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

# Asterisk configuration paths
EXTENSIONS_CUSTOM_CONF = "/etc/asterisk/extensions_custom.conf"
EXTENSIONS_OPDESK_CONF = "/etc/asterisk/extensions_opdesk.conf"
EXTENSIONS_MOBILE_WAKE_CONF = "/etc/asterisk/extensions_mobile_wake.conf"
EXTENSIONS_RECORD_CONF = "/etc/asterisk/extensions_opdesk_record.conf"

# Where MixMonitor writes call recordings.
#   - Mixed file goes to the FreePBX/Asterisk default monitor dir, so it lands in the
#     same place the CDR(recordingfile) field points at (CMS / CDR reports find it).
#   - The two single-leg files (caller=sp1, callee=sp2) go to a sibling folder.
# Both are date-partitioned YYYY/MM/DD exactly like FreePBX's native recorder.
RECORD_MIX_DIR = "/var/spool/asterisk/monitor"
RECORD_SINGLE_DIR = "/var/spool/asterisk/single"
# Included INSIDE pjsip.transports.conf BEFORE the auto-generated [0.0.0.0-tls] section.
# PJSIP uses first-wins for duplicate section names, so this file's definition wins
# over the auto-generated one.  pjsip.transports_custom_post.conf is included AFTER
# and therefore loses — do NOT use it for transport overrides.
PJSIP_TRANSPORTS_CUSTOM = "/etc/asterisk/pjsip.transports_custom.conf"


def write_qos_conf():
    """
    Write the QoS dialplan sections to a dedicated extensions_opdesk.conf
    and ensure it is included from extensions_custom.conf.
    """
    log.info(f"Writing QoS dialplan to {EXTENSIONS_OPDESK_CONF}")

    custom_content = """[from-internal-custom]
exten => _.,1,Set(CHANNEL(hangup_handler_push)=qos-handler,s,1)

[from-pstn-custom]
exten => _.,1,Set(CHANNEL(hangup_handler_push)=qos-handler,s,1)

; 2. The Logic remains the same, but now it's guaranteed to run
[qos-handler]
exten => s,1,NoOp(-- QoS Handler Start --)
 same => n,Set(QOS_SRC=${IF($["${RTPAUDIOQOSBRIDGED}"!=""]?${RTPAUDIOQOSBRIDGED}:${RTPAUDIOQOS})})
 same => n,GotoIf($["${QOS_SRC}" != ""]?save)
 same => n,Set(QOS_SRC=${DB(qos/${CHANNEL(linkedid)}/data)})

 same => n(save),GotoIf($["${QOS_SRC}" = ""]?end)
 same => n,Set(QOS_CALLER=${IF($["${DB(qos/${CHANNEL(linkedid)}/caller)}"!=""]?${DB(qos/${CHANNEL(linkedid)}/caller)}:${CALLERID(num)})})
 same => n,Set(CDR(userfield)=QoS:${QOS_SRC},Caller:${QOS_CALLER})
 same => n,NoOp(Saved QoS to CDR: ${CDR(userfield)})
 same => n,DBdeltree(qos/${CHANNEL(linkedid)})
 same => n(end),NoOp(QoS Handler Finished)
 same => n,Return()
"""
    try:
        import tempfile

        # 1) Write or overwrite the dedicated OpDesk QoS file
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp_file:
            tmp_file.write(custom_content)
            opdesk_tmp_path = tmp_file.name

        result_opdesk = subprocess.run(
            ['sudo', 'cp', opdesk_tmp_path, EXTENSIONS_OPDESK_CONF],
            capture_output=True,
            text=True,
        )

        subprocess.run(
            ['sudo', 'chmod', '644', EXTENSIONS_OPDESK_CONF],
            capture_output=True,
            text=True,
        )

        os.unlink(opdesk_tmp_path)

        if result_opdesk.returncode != 0:
            log.error(f"Failed to write to {EXTENSIONS_OPDESK_CONF}: {result_opdesk.stderr}")
            return False

        log.info(f"Successfully wrote QoS custom dialplan to {EXTENSIONS_OPDESK_CONF}")

        # 2) Ensure extensions_custom.conf includes the OpDesk file
        include_lines = {
            f"#include {os.path.basename(EXTENSIONS_OPDESK_CONF)}",
            f"#include {EXTENSIONS_OPDESK_CONF}",
        }

        existing_content = ""
        if os.path.exists(EXTENSIONS_CUSTOM_CONF):
            with open(EXTENSIONS_CUSTOM_CONF, 'r') as f:
                existing_content = f.read()

        # If any acceptable include line already exists, we are done with this part
        if any(line in existing_content for line in include_lines):
            log.info(f"{EXTENSIONS_CUSTOM_CONF} already includes {EXTENSIONS_OPDESK_CONF}")
            return True

        # Append a simple relative include by default
        if existing_content and not existing_content.endswith('\n'):
            existing_content += '\n'
        existing_content += f"#include {os.path.basename(EXTENSIONS_OPDESK_CONF)}\n"

        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp_file:
            tmp_file.write(existing_content)
            custom_tmp_path = tmp_file.name

        result_custom = subprocess.run(
            ['sudo', 'cp', custom_tmp_path, EXTENSIONS_CUSTOM_CONF],
            capture_output=True,
            text=True,
        )

        subprocess.run(
            ['sudo', 'chmod', '644', EXTENSIONS_CUSTOM_CONF],
            capture_output=True,
            text=True,
        )

        os.unlink(custom_tmp_path)

        if result_custom.returncode == 0:
            log.info(
                f"Ensured {EXTENSIONS_CUSTOM_CONF} includes {os.path.basename(EXTENSIONS_OPDESK_CONF)}"
            )
            return True

        log.error(f"Failed to update {EXTENSIONS_CUSTOM_CONF}: {result_custom.stderr}")
        return False

    except Exception as e:
        log.error(f"Error writing QoS configuration files: {e}")
        return False


def reload_asterisk_dialplan():
    """Reload Asterisk dialplan using 'asterisk -rx dialplan reload'."""
    log.info("Reloading Asterisk dialplan...")
    
    try:
        result = subprocess.run(
            ['sudo', 'asterisk', '-rx', 'dialplan reload'],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            log.info("Successfully reloaded Asterisk dialplan")
            return True
        else:
            log.error(f"Failed to reload dialplan: {result.stderr}")
            return False
            
    except subprocess.TimeoutExpired:
        log.error("Timeout while reloading Asterisk dialplan")
        return False
    except Exception as e:
        log.error(f"Error reloading dialplan: {e}")
        return False


def reload_asterisk_sip(PBX: str | None = None):
    """
    Reload Asterisk SIP / configuration based on PBX type.
    - Issabel: run '/var/lib/asterisk/bin/retrieve_conf && asterisk -rx \"core reload\"'.
    - FreePBX/other: keep existing 'fwconsole reload' logic.
    """
    pbx = (PBX or os.getenv('PBX', '') or '').strip().lower()

    try:
        if pbx == 'issabel':
            log.info("PBX=Issabel detected; running 'retrieve_conf' and 'asterisk -rx \"core reload\"'...")
            cmd = '/var/lib/asterisk/bin/retrieve_conf && asterisk -rx "core reload"'
            result = subprocess.run(
                ['sudo', 'bash', '-c', cmd],
                capture_output=True,
                text=True,
                timeout=30,
            )
        else:
            log.info("Running 'fwconsole reload' to apply SIP/WebRTC changes...")
            result = subprocess.run(
                ['sudo', 'fwconsole', 'reload'],
                capture_output=True,
                text=True,
                timeout=15,
            )

        if result.returncode == 0:
            log.info("Successfully reloaded Asterisk SIP / config")
            return True

        stderr = (result.stderr or '').strip()
        stdout = (result.stdout or '').strip()
        msg = stderr or stdout or 'no output'
        log.warning(f"SIP/config reload command failed (PBX={pbx or 'unknown'}): {msg}")
        return False

    except subprocess.TimeoutExpired:
        log.warning(f"Timeout while reloading SIP/config (PBX={pbx or 'unknown'})")
        return False
    except FileNotFoundError as e:
        log.warning(f"Reload command not found (PBX={pbx or 'unknown'}): {e}")
        return False
    except Exception as e:
        log.warning(f"Error reloading SIP/config (PBX={pbx or 'unknown'}): {e}")
        return False


def write_mobile_wake_conf(backend_port: int = None, wait_seconds: int = None) -> bool:
    """
    Install an automatic "wake before dial" hook in [from-internal-custom].

    Why here and not a FreePBX predial hook: when a mobile app is killed/backgrounded
    its SIP registration expires, so PJSIP_DIAL_CONTACTS() returns empty. FreePBX's
    macro-dial-one resolves contacts (priority ~30) and immediately bails to "nodial"
    with DIALSTATUS=CHANUNAVAIL *before* it ever reaches the predial hook (godial,
    priority ~53). The phone is therefore never dialled and no DialBegin event fires —
    so the AMI-driven push never gets a chance. The wake MUST happen before contact
    resolution.

    [from-internal-custom] is the right place: FreePBX includes it *first* in
    [from-internal], ahead of the generated routing, and it is re-entered by the
    Local/<ext>@from-internal channels that ring groups, queues and follow-me use — so
    a single hook covers internal calls and most inbound paths automatically, with no
    per-extension configuration.

    For each call the hook:
      1. Falls straight through for anything that is not a real local extension
         (feature codes, outbound numbers) — Goto(from-internal-additional,...).
      2. Falls straight through (no wake, zero added latency) if the extension already
         has a registered contact — the normal ring handles it.
      3. Otherwise CURLs the backend wake endpoint. The endpoint returns "1" only when
         the extension has a registered mobile token; only then do we Wait() for the
         app to come up. Then it hands the call back to the full FreePBX stack via
         Goto(from-internal-additional,${EXTEN},1) — preserving voicemail, recording,
         CID, follow-me, etc.
    """
    if backend_port is None:
        backend_port = int(os.getenv("PORT", "8765"))
    if wait_seconds is None:
        wait_seconds = int(os.getenv("MOBILE_WAKE_WAIT", "3"))

    log.info(f"Writing mobile wake dialplan to {EXTENSIONS_MOBILE_WAKE_CONF}")

    # The wake/continue body is identical for 3- and 4-digit extensions; emit it once
    # per pattern. ${EXTEN:0:0} trick is avoided — we just duplicate the few lines.
    def _hook_lines(pattern: str) -> str:
        return f"""exten => {pattern},1,NoOp(OpDesk mobile wake check for ${{EXTEN}})
 same => n,ExecIf($[${{DIALPLAN_EXISTS(qos-handler,s,1)}}]?Set(CHANNEL(hangup_handler_push)=qos-handler,s,1))
 same => n,GotoIf($["${{DB(AMPUSER/${{EXTEN}}/device)}}"=""]?passthru)
 same => n,GotoIf($["${{PJSIP_DIAL_CONTACTS(${{EXTEN}})}}"!=""]?passthru)
 same => n,Set(CURLOPT(conntimeout)=2)
 same => n,Set(CURLOPT(httptimeout)=3)
 same => n,Set(OPDESKWAKE=${{CURL(http://127.0.0.1:{backend_port}/api/internal/mobile-wake/${{EXTEN}}?caller=${{URIENCODE(${{CALLERID(num)}})}})}})
 same => n,ExecIf($["${{OPDESKWAKE}}"="1"]?Wait({wait_seconds}))
 same => n(passthru),Goto(from-internal-additional,${{EXTEN}},1)
"""

    content = f"""; OpDesk mobile wake dialplan — auto-generated. Do not edit manually.
;
; Wakes a killed/backgrounded mobile softphone BEFORE FreePBX tries to resolve its SIP
; contact, so the app has time to re-register and actually ring. Runs automatically for
; every internal call and for ring-group/queue/follow-me legs (which re-enter
; from-internal via Local channels). No per-extension configuration required.
;
; Tunable: MOBILE_WAKE_WAIT (seconds to wait after the push) in the backend .env.
;
[from-internal-custom]
{_hook_lines("_XXX")}
{_hook_lines("_XXXX")}"""
    try:
        import tempfile

        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        result = subprocess.run(
            ['sudo', 'cp', tmp_path, EXTENSIONS_MOBILE_WAKE_CONF],
            capture_output=True, text=True,
        )
        subprocess.run(['sudo', 'chmod', '644', EXTENSIONS_MOBILE_WAKE_CONF], capture_output=True)
        os.unlink(tmp_path)

        if result.returncode != 0:
            log.error(f"Failed to write {EXTENSIONS_MOBILE_WAKE_CONF}: {result.stderr}")
            return False

        # Ensure extensions_custom.conf includes the new file
        include_line = f"#include {os.path.basename(EXTENSIONS_MOBILE_WAKE_CONF)}"
        existing = ""
        if os.path.exists(EXTENSIONS_CUSTOM_CONF):
            with open(EXTENSIONS_CUSTOM_CONF, 'r') as f:
                existing = f.read()

        if include_line not in existing:
            if existing and not existing.endswith('\n'):
                existing += '\n'
            existing += include_line + '\n'
            with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp:
                tmp.write(existing)
                tmp_path = tmp.name
            subprocess.run(['sudo', 'cp', tmp_path, EXTENSIONS_CUSTOM_CONF], capture_output=True)
            subprocess.run(['sudo', 'chmod', '644', EXTENSIONS_CUSTOM_CONF], capture_output=True)
            os.unlink(tmp_path)

        log.info(f"Mobile wake dialplan written to {EXTENSIONS_MOBILE_WAKE_CONF}")
        return True

    except Exception as e:
        log.error(f"Error writing mobile wake conf: {e}")
        return False


def remove_mobile_wake_conf() -> bool:
    """Clear the mobile wake dialplan context (disables the feature)."""
    log.info(f"Clearing mobile wake dialplan from {EXTENSIONS_MOBILE_WAKE_CONF}")
    try:
        import tempfile
        if not os.path.exists(EXTENSIONS_MOBILE_WAKE_CONF):
            return True
        minimal = "; OpDesk mobile wake disabled\n"
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp:
            tmp.write(minimal)
            tmp_path = tmp.name
        result = subprocess.run(['sudo', 'cp', tmp_path, EXTENSIONS_MOBILE_WAKE_CONF], capture_output=True, text=True)
        subprocess.run(['sudo', 'chmod', '644', EXTENSIONS_MOBILE_WAKE_CONF], capture_output=True)
        os.unlink(tmp_path)
        if result.returncode != 0:
            log.error(f"Failed to clear {EXTENSIONS_MOBILE_WAKE_CONF}: {result.stderr}")
            return False
        log.info("Mobile wake dialplan cleared")
        return True
    except Exception as e:
        log.error(f"Error clearing mobile wake conf: {e}")
        return False


def enable_mobile_wake(wait_seconds: int = None) -> bool:
    """Enable the mobile pre-dial wake dialplan and reload Asterisk."""
    if not write_mobile_wake_conf(wait_seconds=wait_seconds):
        return False
    return reload_asterisk_dialplan()


def disable_mobile_wake() -> bool:
    """Disable the mobile pre-dial wake dialplan and reload Asterisk."""
    if not remove_mobile_wake_conf():
        return False
    return reload_asterisk_dialplan()


def remove_qos_conf():
    """
    Remove the QoS dialplan contents from extensions_opdesk.conf,
    but keep the file itself and the #include in extensions_custom.conf.
    """
    log.info(f"Clearing QoS custom dialplan from {EXTENSIONS_OPDESK_CONF}")

    try:
        import tempfile

        # If the OpDesk file does not exist, nothing to clean
        if not os.path.exists(EXTENSIONS_OPDESK_CONF):
            log.info(f"{EXTENSIONS_OPDESK_CONF} does not exist. Nothing to clear.")
            return True

        # Write an empty (or minimal) file so QoS contexts are removed
        minimal_content = "; QoS disabled – OpDesk dialplan cleared by OpDesk backend\n"

        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp_file:
            tmp_file.write(minimal_content)
            tmp_path = tmp_file.name

        result = subprocess.run(
            ['sudo', 'cp', tmp_path, EXTENSIONS_OPDESK_CONF],
            capture_output=True,
            text=True,
        )

        subprocess.run(
            ['sudo', 'chmod', '644', EXTENSIONS_OPDESK_CONF],
            capture_output=True,
            text=True,
        )

        os.unlink(tmp_path)

        if result.returncode == 0:
            log.info(f"Successfully cleared QoS dialplan from {EXTENSIONS_OPDESK_CONF}")
            return True

        log.error(f"Failed to clear {EXTENSIONS_OPDESK_CONF}: {result.stderr}")
        return False

    except Exception as e:
        log.error(f"Error clearing QoS configuration file: {e}")
        return False


def enable_qos():
    """Main function to enable QoS configuration."""
    log.info("Enabling QoS configuration...")
    
    # Write QoS configuration
    if not write_qos_conf():
        log.error("Failed to write QoS configuration. Aborting.")
        return False
    
    # Reload dialplan
    if not reload_asterisk_dialplan():
        log.error("Failed to reload dialplan. Configuration may not be active.")
        return False
    
    log.info("QoS configuration enabled successfully!")
    return True


def disable_qos():
    """Main function to disable QoS configuration."""
    log.info("Disabling QoS configuration...")
    
    # Clear QoS configuration from the OpDesk dialplan file
    if not remove_qos_conf():
        log.error("Failed to clear QoS configuration. Continuing...")
    
    # Reload dialplan
    if not reload_asterisk_dialplan():
        log.error("Failed to reload dialplan. Configuration may still be active.")
        return False
    
    log.info("QoS configuration disabled successfully!")
    return True


def write_recording_conf(mix_format: str = None, vad: bool = True) -> bool:
    """
    Install full-call recording via MixMonitor for every real call — internal
    extension-to-extension, inbound from trunks, and outbound to trunks.

    Why the predial hooks and NOT [from-internal-custom]:
      [from-internal-custom] is only reachable through the `_.` catch-all, which is the
      least-specific pattern in Asterisk. For any routed call (a real extension, an
      outbound route) a more-specific pattern in ext-local / outrt-N wins, so the catch-all
      never executes — recording placed there would capture nothing. FreePBX instead ships
      two blank predial-hook stubs (extensions.conf, `s,1,return()`) specifically so
      integrators can override them:
        - macro-dialout-one-predial-hook   : fires before dialling an extension
                                             (internal ext<->ext and inbound trunk -> ext)
        - macro-dialout-trunk-predial-hook : fires before dialling out a trunk (outbound)
      Together they fire exactly once per real call, on the originating channel, just
      before the bridge — so a single MixMonitor follows the whole conversation. Defining
      them from a file #include'd by extensions_custom.conf wins the duplicate-priority
      race against the blank stubs (the custom include is parsed before them).

    Outputs (one MixMonitor call, three files):
      - mixed : RECORD_MIX_DIR/YYYY/MM/DD/<base>.<fmt>      (FreePBX/CDR default location;
                CDR(recordingfile) is set so it shows in CDR reports / Call Recordings)
      - sp1   : RECORD_SINGLE_DIR/YYYY/MM/DD/<base>-sp1.<fmt>  (caller leg  = r() receive)
      - sp2   : RECORD_SINGLE_DIR/YYYY/MM/DD/<base>-sp2.<fmt>  (callee leg  = t() transmit)

    <base> mirrors FreePBX's naming style: <timestamp>-<cidnum>-<dialed>-<uniqueid>.
    A channel flag (__OPDESK_REC) guards against double-recording when a ring group /
    queue runs the predial hook once per member on the same channel.
    """
    if mix_format is None:
        mix_format = os.getenv("OPDESK_REC_FORMAT", "wav")

    # VAD post-call analysis only makes sense on a PCM format the analyser can read.
    if vad and mix_format not in ("wav", "sln"):
        log.warning(f"VAD analysis needs 16-bit PCM (wav/sln); format={mix_format} -> disabling VAD")
        vad = False

    log.info(f"Writing call recording dialplan to {EXTENSIONS_RECORD_CONF} (vad={vad})")

    # When VAD is on, [opdesk-record] records the single-leg base path and fires a
    # UserEvent so the OpDesk AMI monitor can run the post-call analysis in-process.
    # The monitor pairs this base with the channel's Hangup event (same Uniqueid) and,
    # once the WAV legs are flushed, analyses them and stores the result in the OpDesk DB.
    # No AGI / hangup handler / loopback endpoint involved.
    vad_record_lines = (
        " same => n,Set(OPDESK_SINGLE_BASE=__SINGLEDIR__/${OPDESK_DAY}/${OPDESK_BASE})\n"
        " same => n,UserEvent(OpDeskRecording,Recbase: ${OPDESK_SINGLE_BASE})\n"
    ) if vad else ""

    vad_context = ""

    template = """; OpDesk call recording dialplan — auto-generated. Do not edit manually.
;
; Records every real call (internal ext<->ext, inbound from trunks, outbound to trunks)
; with a single MixMonitor started from FreePBX's predial hooks. [from-internal-custom]
; is NOT used on purpose: its `_.` entry is a catch-all that loses to FreePBX's
; per-extension / per-route patterns and never runs for routed calls.
;
;   mixed -> __MIXDIR__/YYYY/MM/DD/<base>.__FMT__        (CDR default location, CDR-linked)
;   sp1   -> __SINGLEDIR__/YYYY/MM/DD/<base>-sp1.__FMT__ (caller leg, r() receive)
;   sp2   -> __SINGLEDIR__/YYYY/MM/DD/<base>-sp2.__FMT__ (callee leg, t() transmit)
;
; The predial-hook stubs ship blank in extensions.conf to be overridden; defining them
; here (included from extensions_custom.conf, parsed before the stubs) wins the
; duplicate-priority race so this version runs instead of the no-op stub.

[macro-dialout-one-predial-hook]
exten => s,1,GosubIf($["${OPDESK_REC}"=""]?opdesk-record,s,1)
 same => n,Return()

[macro-dialout-trunk-predial-hook]
exten => s,1,GosubIf($["${OPDESK_REC}"=""]?opdesk-record,s,1)
 same => n,Return()

[opdesk-record]
exten => s,1,NoOp(OpDesk recording start on ${CHANNEL})
 same => n,Set(__OPDESK_REC=1)
 same => n,Set(OPDESK_TS=${STRFTIME(${EPOCH},,%Y%m%d-%H%M%S)})
 same => n,Set(OPDESK_DAY=${STRFTIME(${EPOCH},,%Y/%m/%d)})
 same => n,Set(OPDESK_DST=${IF($["${EXTTOCALL}"!=""]?${EXTTOCALL}:${CALLERID(dnid)})})
 same => n,Set(OPDESK_BASE=${OPDESK_TS}-${CALLERID(num)}-${OPDESK_DST}-${UNIQUEID})
 same => n,Set(OPDESK_MIX=__MIXDIR__/${OPDESK_DAY}/${OPDESK_BASE}.__FMT__)
 same => n,Set(OPDESK_SP1=__SINGLEDIR__/${OPDESK_DAY}/${OPDESK_BASE}-sp1.__FMT__)
 same => n,Set(OPDESK_SP2=__SINGLEDIR__/${OPDESK_DAY}/${OPDESK_BASE}-sp2.__FMT__)
 same => n,MixMonitor(${OPDESK_MIX},r(${OPDESK_SP1})t(${OPDESK_SP2}))
 same => n,Set(CDR(recordingfile)=${OPDESK_BASE}.__FMT__)
 same => n,NoOp(OpDesk recording: mix=${OPDESK_MIX} sp1=${OPDESK_SP1} sp2=${OPDESK_SP2})
__VAD_RECORD_LINES__ same => n,Return()
__VAD_CONTEXT__"""

    content = (
        template
        .replace("__VAD_RECORD_LINES__", vad_record_lines)
        .replace("__VAD_CONTEXT__", vad_context)
        .replace("__MIXDIR__", RECORD_MIX_DIR)
        .replace("__SINGLEDIR__", RECORD_SINGLE_DIR)
        .replace("__FMT__", mix_format)
    )

    try:
        import tempfile

        # MixMonitor auto-creates the dated YYYY/MM/DD subdirs, but the single base dir
        # must exist and be writable by the asterisk user first.
        subprocess.run(['sudo', 'mkdir', '-p', RECORD_SINGLE_DIR], capture_output=True)
        subprocess.run(['sudo', 'chown', 'asterisk:asterisk', RECORD_SINGLE_DIR], capture_output=True)
        subprocess.run(['sudo', 'chmod', '775', RECORD_SINGLE_DIR], capture_output=True)

        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        result = subprocess.run(
            ['sudo', 'cp', tmp_path, EXTENSIONS_RECORD_CONF],
            capture_output=True, text=True,
        )
        subprocess.run(['sudo', 'chmod', '644', EXTENSIONS_RECORD_CONF], capture_output=True)
        os.unlink(tmp_path)

        if result.returncode != 0:
            log.error(f"Failed to write {EXTENSIONS_RECORD_CONF}: {result.stderr}")
            return False

        # Ensure extensions_custom.conf includes the recording file.
        include_line = f"#include {os.path.basename(EXTENSIONS_RECORD_CONF)}"
        existing = ""
        if os.path.exists(EXTENSIONS_CUSTOM_CONF):
            with open(EXTENSIONS_CUSTOM_CONF, 'r') as f:
                existing = f.read()

        if include_line not in existing:
            if existing and not existing.endswith('\n'):
                existing += '\n'
            existing += include_line + '\n'
            with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp:
                tmp.write(existing)
                tmp_path = tmp.name
            subprocess.run(['sudo', 'cp', tmp_path, EXTENSIONS_CUSTOM_CONF], capture_output=True)
            subprocess.run(['sudo', 'chmod', '644', EXTENSIONS_CUSTOM_CONF], capture_output=True)
            os.unlink(tmp_path)

        log.info(f"Call recording dialplan written to {EXTENSIONS_RECORD_CONF}")
        return True

    except Exception as e:
        log.error(f"Error writing recording conf: {e}")
        return False


def remove_recording_conf() -> bool:
    """Reset the recording predial hooks to no-ops (disables recording)."""
    log.info(f"Clearing call recording dialplan from {EXTENSIONS_RECORD_CONF}")
    try:
        import tempfile
        if not os.path.exists(EXTENSIONS_RECORD_CONF):
            return True
        # Keep the hook contexts but make them no-ops, so they still win the
        # duplicate-priority race against the blank stubs without starting MixMonitor.
        minimal = (
            "; OpDesk call recording disabled\n"
            "[macro-dialout-one-predial-hook]\n"
            "exten => s,1,Return()\n\n"
            "[macro-dialout-trunk-predial-hook]\n"
            "exten => s,1,Return()\n"
        )
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp:
            tmp.write(minimal)
            tmp_path = tmp.name
        result = subprocess.run(['sudo', 'cp', tmp_path, EXTENSIONS_RECORD_CONF], capture_output=True, text=True)
        subprocess.run(['sudo', 'chmod', '644', EXTENSIONS_RECORD_CONF], capture_output=True)
        os.unlink(tmp_path)
        if result.returncode != 0:
            log.error(f"Failed to clear {EXTENSIONS_RECORD_CONF}: {result.stderr}")
            return False
        log.info("Call recording dialplan cleared")
        return True
    except Exception as e:
        log.error(f"Error clearing recording conf: {e}")
        return False


def enable_recording(mix_format: str = None, vad: bool = True) -> bool:
    """Enable full-call MixMonitor recording (+ optional post-call VAD analysis) and
    reload the Asterisk dialplan."""
    if not write_recording_conf(mix_format=mix_format, vad=vad):
        return False
    return reload_asterisk_dialplan()


def disable_recording() -> bool:
    """Disable full-call recording and reload the Asterisk dialplan."""
    if not remove_recording_conf():
        return False
    return reload_asterisk_dialplan()


# Markers written around OpDesk's TLS block so we can find and remove it cleanly
_TLS_MARKER_START = "; --- OpDesk SIP TLS BEGIN ---"
_TLS_MARKER_END   = "; --- OpDesk SIP TLS END ---"


def _detect_tls_mode():
    """
    Return ('freepbx', config_file) or ('issabel', config_file).

    FreePBX  — has pjsip.transports.conf auto-generated by FreePBX;
               override by writing [0.0.0.0-tls] into pjsip.transports_custom_post.conf
               (included after the auto-generated file → values win).

    Issabel 5 (PJSIP) — no pjsip.transports.conf; uses pjsip_custom_post.conf
                         → write a new [opdesk-sip-tls] transport there.
    """
    if os.path.isfile("/etc/asterisk/pjsip.transports.conf"):
        return "freepbx", PJSIP_TRANSPORTS_CUSTOM

    for candidate in ("/etc/asterisk/pjsip_custom_post.conf",
                      "/etc/asterisk/pjsip_custom.conf"):
        if os.path.isfile(candidate):
            return "issabel", candidate

    return "issabel", "/etc/asterisk/pjsip_custom_post.conf"


def _write_to_file(path: str, content: str) -> bool:
    """Overwrite a file via sudo tee."""
    try:
        result = subprocess.run(
            ["sudo", "tee", path],
            input=content.encode(),
            capture_output=True,
        )
        if result.returncode != 0:
            log.error(f"tee {path} failed: {result.stderr.decode()}")
            return False
        return True
    except Exception as e:
        log.error(f"Failed to write {path}: {e}")
        return False


def _remove_opdesk_block(path: str) -> bool:
    """Remove the OpDesk TLS marker block from a file, leave the rest intact."""
    if not os.path.isfile(path):
        return True
    try:
        result = subprocess.run(["sudo", "cat", path], capture_output=True)
        if result.returncode != 0:
            return False
        lines = result.stdout.decode(errors="replace").splitlines(keepends=True)
        out, inside = [], False
        for line in lines:
            if _TLS_MARKER_START in line:
                inside = True
            if not inside:
                out.append(line)
            if _TLS_MARKER_END in line:
                inside = False
        return _write_to_file(path, "".join(out))
    except Exception as e:
        log.error(f"Failed to remove OpDesk TLS block from {path}: {e}")
        return False


def _reload_asterisk(mode: str) -> bool:
    """Restart Asterisk immediately to pick up transport changes.

    TLS transports have allow_reload=false, so a module reload is not enough.
    'core restart now' is used instead of 'graceful' because graceful waits
    for all active calls to end — on a busy PBX this can mean it never fires.
    """
    result = subprocess.run(
        ["sudo", "asterisk", "-rx", "core restart now"],
        capture_output=True,
    )
    if result.returncode != 0:
        log.error(f"Asterisk restart failed: {result.stderr.decode()}")
        return False
    log.info("Asterisk restarted — TLS transport changes applied")
    return True


def enable_sip_tls(domain: str) -> bool:
    """Enable SIP TLS on port 5061 using the Let's Encrypt cert for the given domain."""
    le_cert = f"/etc/letsencrypt/live/{domain}/fullchain.pem"
    le_key  = f"/etc/letsencrypt/live/{domain}/privkey.pem"

    if not os.path.isfile(le_cert) or not os.path.isfile(le_key):
        log.error(f"Let's Encrypt cert not found for domain '{domain}'. Expected: {le_cert}")
        return False

    # /etc/letsencrypt/live and /archive are root-only — asterisk can't read them.
    # Copy into /etc/asterisk/keys/ where asterisk has access.
    cert = "/etc/asterisk/keys/opdesk_le_fullchain.pem"
    key  = "/etc/asterisk/keys/opdesk_le_privkey.pem"
    for src, dst, perms in ((le_cert, cert, "644"), (le_key, key, "600")):
        r = subprocess.run(["sudo", "cp", "-L", src, dst], capture_output=True)
        if r.returncode != 0:
            log.error(f"Failed to copy {src} → {dst}: {r.stderr.decode()}")
            return False
        subprocess.run(["sudo", "chown", "asterisk:asterisk", dst], capture_output=True)
        subprocess.run(["sudo", "chmod", perms, dst], capture_output=True)

    mode, config_file = _detect_tls_mode()
    log.info(f"SIP TLS mode detected: {mode} → {config_file}")

    if mode == "freepbx":
        # Complete transport definition. pjsip.transports_custom.conf is included
        # INSIDE pjsip.transports.conf BEFORE the auto-generated [0.0.0.0-tls], and
        # PJSIP uses first-wins for duplicate object names — so this complete section
        # wins and the auto-generated one is rejected as a duplicate.
        # method=tlsv1_2 is required on OpenSSL 3.x (the FreePBX default "sslv23"
        # throws "no protocols available" because SSLv3/TLS1.0/1.1 are disabled).
        content = (
            f"{_TLS_MARKER_START}\n"
            f"[0.0.0.0-tls]\n"
            f"type=transport\n"
            f"protocol=tls\n"
            f"bind=0.0.0.0:5061\n"
            f"cert_file={cert}\n"
            f"priv_key_file={key}\n"
            f"method=tlsv1_2\n"
            f"verify_client=no\n"
            f"verify_server=no\n"
            f"{_TLS_MARKER_END}\n"
        )
    else:
        # Issabel 5 (PJSIP) — add a dedicated transport to the shared custom file
        content_prefix = ""
        if os.path.isfile(config_file):
            r = subprocess.run(["sudo", "cat", config_file], capture_output=True)
            content_prefix = r.stdout.decode(errors="replace").rstrip("\n") + "\n"
        new_block = (
            f"\n{_TLS_MARKER_START}\n"
            f"[opdesk-sip-tls]\n"
            f"type=transport\n"
            f"protocol=tls\n"
            f"bind=0.0.0.0:5061\n"
            f"cert_file={cert}\n"
            f"priv_key_file={key}\n"
            f"method=tlsv1_2\n"
            f"verify_client=no\n"
            f"verify_server=no\n"
            f"{_TLS_MARKER_END}\n"
        )
        content = content_prefix + new_block

    if not _write_to_file(config_file, content):
        return False

    subprocess.run(["sudo", "ufw", "allow", "5061/tcp"], capture_output=True)
    subprocess.run(["sudo", "ufw", "allow", "5061/udp"], capture_output=True)
    subprocess.run(["sudo", "ufw", "reload"], capture_output=True)

    if not _reload_asterisk(mode):
        return False

    log.info(f"SIP TLS enabled on port 5061 ({mode}) with cert for {domain}")
    return True


def disable_sip_tls() -> bool:
    """Disable SIP TLS on port 5061."""
    mode, config_file = _detect_tls_mode()
    log.info(f"SIP TLS disable: mode={mode}, file={config_file}")

    _remove_opdesk_block(config_file)

    subprocess.run(["sudo", "ufw", "delete", "allow", "5061/tcp"], capture_output=True)
    subprocess.run(["sudo", "ufw", "delete", "allow", "5061/udp"], capture_output=True)
    subprocess.run(["sudo", "ufw", "reload"], capture_output=True)

    if not _reload_asterisk(mode):
        return False

    log.info("SIP TLS disabled on port 5061")
    return True


