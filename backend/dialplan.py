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


def reload_asterisk_sip():
    """Reload FreePBX/Asterisk config using 'fwconsole reload'."""
    log.info("Running 'fwconsole reload' to apply SIP/WebRTC changes...")
    try:
        result = subprocess.run(
            ['sudo', 'fwconsole', 'reload'],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            log.info("Successfully ran 'fwconsole reload'")
            return True
        log.warning(f"fwconsole reload failed: {result.stderr or result.stdout}")
        return False
    except subprocess.TimeoutExpired:
        log.warning("Timeout while running 'fwconsole reload'")
        return False
    except Exception as e:
        log.warning(f"Error running 'fwconsole reload': {e}")
        return False


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


