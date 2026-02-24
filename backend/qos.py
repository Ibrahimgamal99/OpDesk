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


def write_custom_file():
    """Write the QoS dialplan sections to extensions_custom.conf."""
    log.info(f"Writing QoS custom dialplan to {EXTENSIONS_CUSTOM_CONF}")
    
    custom_content = """; 1. This hook executes at the very start of every call on the system
[from-internal-custom]
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
        # Check if file exists and read current content
        existing_content = ""
        if os.path.exists(EXTENSIONS_CUSTOM_CONF):
            with open(EXTENSIONS_CUSTOM_CONF, 'r') as f:
                existing_content = f.read()
        
        # Check if QoS sections already exist
        qos_sections = ["[from-internal-custom]", "[from-pstn-custom]", "[qos-handler]"]
        has_qos_sections = any(section in existing_content for section in qos_sections)
        
        if has_qos_sections:
            log.warning(f"QoS sections already exist in {EXTENSIONS_CUSTOM_CONF}. Updating...")
            # Remove existing QoS sections
            lines = existing_content.split('\n')
            new_lines = []
            skip_section = False
            for i, line in enumerate(lines):
                # Check if this line starts a QoS section
                if any(line.strip() == section for section in qos_sections):
                    skip_section = True
                    continue
                # Check if we're ending a QoS section (new section starts)
                elif skip_section and line.strip().startswith('[') and line.strip().endswith(']'):
                    skip_section = False
                    new_lines.append(line)
                elif not skip_section:
                    new_lines.append(line)
            existing_content = '\n'.join(new_lines)
        
        # Append new content
        if existing_content and not existing_content.endswith('\n'):
            existing_content += '\n'
        existing_content += custom_content
        
        # Write to file (requires sudo, so we'll use subprocess)
        # First, write to a temporary file
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp_file:
            tmp_file.write(existing_content)
            tmp_path = tmp_file.name
        
        # Copy to destination using sudo
        result = subprocess.run(
            ['sudo', 'cp', tmp_path, EXTENSIONS_CUSTOM_CONF],
            capture_output=True,
            text=True
        )
        
        # Set proper permissions
        subprocess.run(
            ['sudo', 'chmod', '644', EXTENSIONS_CUSTOM_CONF],
            capture_output=True,
            text=True
        )
        
        # Clean up temp file
        os.unlink(tmp_path)
        
        if result.returncode == 0:
            log.info(f"Successfully wrote QoS custom dialplan to {EXTENSIONS_CUSTOM_CONF}")
            return True
        else:
            log.error(f"Failed to write to {EXTENSIONS_CUSTOM_CONF}: {result.stderr}")
            return False
            
    except Exception as e:
        log.error(f"Error writing custom file: {e}")
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


def remove_custom_file():
    """Remove the QoS dialplan sections from extensions_custom.conf."""
    log.info(f"Removing QoS custom dialplan from {EXTENSIONS_CUSTOM_CONF}")
    
    try:
        # Check if file exists
        if not os.path.exists(EXTENSIONS_CUSTOM_CONF):
            log.warning(f"Custom file {EXTENSIONS_CUSTOM_CONF} does not exist. Nothing to remove.")
            return True
        
        # Read current content
        with open(EXTENSIONS_CUSTOM_CONF, 'r') as f:
            existing_content = f.read()
        
        # Check if QoS sections exist
        qos_sections = ["[from-internal-custom]", "[from-pstn-custom]", "[qos-handler]"]
        has_qos_sections = any(section in existing_content for section in qos_sections)
        
        if not has_qos_sections:
            log.info(f"No QoS configuration found in {EXTENSIONS_CUSTOM_CONF}. Nothing to remove.")
            return True
        
        # Remove QoS sections
        lines = existing_content.split('\n')
        new_lines = []
        skip_section = False
        for line in lines:
            # Check if this line starts a QoS section
            if any(line.strip() == section for section in qos_sections):
                skip_section = True
                continue
            # Check if we're ending a QoS section (new section starts)
            elif skip_section and line.strip().startswith('[') and line.strip().endswith(']'):
                skip_section = False
                new_lines.append(line)
            elif not skip_section:
                new_lines.append(line)
        
        # Remove trailing empty lines
        while new_lines and not new_lines[-1].strip():
            new_lines.pop()
        
        new_content = '\n'.join(new_lines)
        
        # Write to file (requires sudo, so we'll use subprocess)
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp_file:
            tmp_file.write(new_content)
            tmp_path = tmp_file.name
        
        # Copy to destination using sudo
        result = subprocess.run(
            ['sudo', 'cp', tmp_path, EXTENSIONS_CUSTOM_CONF],
            capture_output=True,
            text=True
        )
        
        # Set proper permissions
        subprocess.run(
            ['sudo', 'chmod', '644', EXTENSIONS_CUSTOM_CONF],
            capture_output=True,
            text=True
        )
        
        # Clean up temp file
        os.unlink(tmp_path)
        
        if result.returncode == 0:
            log.info(f"Successfully removed QoS custom dialplan from {EXTENSIONS_CUSTOM_CONF}")
            return True
        else:
            log.error(f"Failed to write to {EXTENSIONS_CUSTOM_CONF}: {result.stderr}")
            return False
            
    except Exception as e:
        log.error(f"Error removing custom file: {e}")
        return False


def enable_qos():
    """Main function to enable QoS configuration."""
    log.info("Enabling QoS configuration...")
    
    # Write custom file
    if not write_custom_file():
        log.error("Failed to write custom file. Aborting.")
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
    
    # Remove custom file section
    if not remove_custom_file():
        log.error("Failed to remove custom file section. Continuing...")
    
    # Reload dialplan
    if not reload_asterisk_dialplan():
        log.error("Failed to reload dialplan. Configuration may still be active.")
        return False
    
    log.info("QoS configuration disabled successfully!")
    return True


