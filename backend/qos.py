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
EXTENSIONS_OVERRIDE_ISSABEL = "/etc/asterisk/extensions_override_issabel.conf"
EXTENSIONS_OVERRIDE_FREEPBX = "/etc/asterisk/extensions_override_freepbx.conf"


def get_pbx_version():
    """Get PBX version from environment variable."""
    pbx = os.getenv('PBX', '').strip()
    if not pbx:
        log.warning("PBX environment variable not set. Defaulting to FreePBX.")
        return "FreePBX"
    return pbx


def get_override_file_path():
    """Get the appropriate override file path based on PBX version."""
    pbx = get_pbx_version()
    if pbx.lower() == "issabel":
        return EXTENSIONS_OVERRIDE_ISSABEL
    else:
        # Default to FreePBX
        return EXTENSIONS_OVERRIDE_FREEPBX


def write_override_file():
    """Write the macro-hangupcall override to the appropriate file."""
    override_file = get_override_file_path()
    pbx = get_pbx_version()
    
    log.info(f"Writing QoS override to {override_file} for {pbx}")
    
    override_content = """[macro-hangupcall]
exten => s,1(start),GotoIf($["${USE_CONFIRMATION}"="" | "${RINGGROUP_INDEX}"="" | "${CHANNEL}"!="${UNIQCHAN}"]?theend)
exten => s,n(delrgi),Noop(Deleting: RG/${RINGGROUP_INDEX}/${CHANNEL} ${DB_DELETE(RG/${RINGGROUP_INDEX}/${CHANNEL})})
exten => s,n(theend),ExecIf($["${ONETOUCH_RECFILE}"!="" & "${CDR(recordingfile)}"=""]?Set(CDR(recordingfile)=${ONETOUCH_RECFILE}))
exten => s,n,Gosub(sub-hangupcall-custom,s,1)

exten => s,n,Hangup()
exten => s,n,Return()
"""
    
    try:
        # Check if file exists and read current content
        existing_content = ""
        if os.path.exists(override_file):
            with open(override_file, 'r') as f:
                existing_content = f.read()
        
        # Check if [macro-hangupcall] already exists
        if "[macro-hangupcall]" in existing_content:
            log.warning(f"[macro-hangupcall] already exists in {override_file}. Updating...")
            # Remove existing [macro-hangupcall] section
            lines = existing_content.split('\n')
            new_lines = []
            skip_section = False
            for line in lines:
                if line.strip() == "[macro-hangupcall]":
                    skip_section = True
                    continue
                elif skip_section and line.strip().startswith('[') and line.strip().endswith(']'):
                    skip_section = False
                    new_lines.append(line)
                elif not skip_section:
                    new_lines.append(line)
            existing_content = '\n'.join(new_lines)
        
        # Append new content
        if existing_content and not existing_content.endswith('\n'):
            existing_content += '\n'
        existing_content += override_content
        
        # Write to file (requires sudo, so we'll use subprocess)
        # First, write to a temporary file
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.conf') as tmp_file:
            tmp_file.write(existing_content)
            tmp_path = tmp_file.name
        
        # Copy to destination using sudo
        result = subprocess.run(
            ['sudo', 'cp', tmp_path, override_file],
            capture_output=True,
            text=True
        )
        
        # Set proper permissions
        subprocess.run(
            ['sudo', 'chmod', '644', override_file],
            capture_output=True,
            text=True
        )
        
        # Clean up temp file
        os.unlink(tmp_path)
        
        if result.returncode == 0:
            log.info(f"Successfully wrote QoS override to {override_file}")
            return True
        else:
            log.error(f"Failed to write to {override_file}: {result.stderr}")
            return False
            
    except Exception as e:
        log.error(f"Error writing override file: {e}")
        return False


def write_custom_file():
    """Write the sub-hangupcall-custom section to extensions_custom.conf."""
    log.info(f"Writing QoS custom dialplan to {EXTENSIONS_CUSTOM_CONF}")
    
    custom_content = """[sub-hangupcall-custom]
exten => s,1,NoOp(-- Extracting Call Quality Metrics --)
 same => n,GotoIf($["${HANGUPCAUSE}" != "16"]?end)
 ; Try direct channel QoS first
 same => n,Set(QOS_SRC=${IF($["${RTPAUDIOQOSBRIDGED}"!=""]?${RTPAUDIOQOSBRIDGED}:${RTPAUDIOQOS})})
 same => n,GotoIf($["${QOS_SRC}" != ""]?save)
 ; Try AstDB (stored by h extension using linkedid)
 same => n,Set(QOS_SRC=${DB(qos/${CHANNEL(linkedid)}/data)})
 same => n,GotoIf($["${QOS_SRC}" = ""]?end)
 same => n(save),Set(QOS_CALLER=${IF($["${DB(qos/${CHANNEL(linkedid)}/caller)}"!=""]?${DB(qos/${CHANNEL(linkedid)}/caller)}:${CALLERID(num)})})
 same => n,Set(CDR(userfield)=QoS:${QOS_SRC},Caller:${QOS_CALLER})
 same => n,NoOp(Saved QoS to CDR: ${CDR(userfield)})
 same => n,DBdeltree(qos/${CHANNEL(linkedid)})
 same => n(end),Return()
"""
    
    try:
        # Check if file exists and read current content
        existing_content = ""
        if os.path.exists(EXTENSIONS_CUSTOM_CONF):
            with open(EXTENSIONS_CUSTOM_CONF, 'r') as f:
                existing_content = f.read()
        
        # Check if [sub-hangupcall-custom] already exists
        if "[sub-hangupcall-custom]" in existing_content:
            log.warning(f"[sub-hangupcall-custom] already exists in {EXTENSIONS_CUSTOM_CONF}. Updating...")
            # Remove existing [sub-hangupcall-custom] section
            lines = existing_content.split('\n')
            new_lines = []
            skip_section = False
            for line in lines:
                if line.strip() == "[sub-hangupcall-custom]":
                    skip_section = True
                    continue
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


def remove_override_file():
    """Remove the macro-hangupcall override from the appropriate file."""
    override_file = get_override_file_path()
    pbx = get_pbx_version()
    
    log.info(f"Removing QoS override from {override_file} for {pbx}")
    
    try:
        # Check if file exists
        if not os.path.exists(override_file):
            log.warning(f"Override file {override_file} does not exist. Nothing to remove.")
            return True
        
        # Read current content
        with open(override_file, 'r') as f:
            existing_content = f.read()
        
        # Check if [macro-hangupcall] exists and contains our QoS Gosub
        if "[macro-hangupcall]" not in existing_content or "sub-hangupcall-custom" not in existing_content:
            log.info(f"No QoS configuration found in {override_file}. Nothing to remove.")
            return True
        
        # Remove [macro-hangupcall] section
        lines = existing_content.split('\n')
        new_lines = []
        skip_section = False
        for line in lines:
            if line.strip() == "[macro-hangupcall]":
                skip_section = True
                continue
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
            ['sudo', 'cp', tmp_path, override_file],
            capture_output=True,
            text=True
        )
        
        # Set proper permissions
        subprocess.run(
            ['sudo', 'chmod', '644', override_file],
            capture_output=True,
            text=True
        )
        
        # Clean up temp file
        os.unlink(tmp_path)
        
        if result.returncode == 0:
            log.info(f"Successfully removed QoS override from {override_file}")
            return True
        else:
            log.error(f"Failed to write to {override_file}: {result.stderr}")
            return False
            
    except Exception as e:
        log.error(f"Error removing override file: {e}")
        return False


def remove_custom_file():
    """Remove the sub-hangupcall-custom section from extensions_custom.conf."""
    log.info(f"Removing QoS custom dialplan from {EXTENSIONS_CUSTOM_CONF}")
    
    try:
        # Check if file exists
        if not os.path.exists(EXTENSIONS_CUSTOM_CONF):
            log.warning(f"Custom file {EXTENSIONS_CUSTOM_CONF} does not exist. Nothing to remove.")
            return True
        
        # Read current content
        with open(EXTENSIONS_CUSTOM_CONF, 'r') as f:
            existing_content = f.read()
        
        # Check if [sub-hangupcall-custom] exists
        if "[sub-hangupcall-custom]" not in existing_content:
            log.info(f"No QoS configuration found in {EXTENSIONS_CUSTOM_CONF}. Nothing to remove.")
            return True
        
        # Remove [sub-hangupcall-custom] section
        lines = existing_content.split('\n')
        new_lines = []
        skip_section = False
        for line in lines:
            if line.strip() == "[sub-hangupcall-custom]":
                skip_section = True
                continue
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
    
    pbx = get_pbx_version()
    log.info(f"Detected PBX: {pbx}")
    
    # Write override file
    if not write_override_file():
        log.error("Failed to write override file. Aborting.")
        return False
    
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
    
    pbx = get_pbx_version()
    log.info(f"Detected PBX: {pbx}")
    
    # Remove override file section
    if not remove_override_file():
        log.error("Failed to remove override file section. Continuing...")
    
    # Remove custom file section
    if not remove_custom_file():
        log.error("Failed to remove custom file section. Continuing...")
    
    # Reload dialplan
    if not reload_asterisk_dialplan():
        log.error("Failed to reload dialplan. Configuration may still be active.")
        return False
    
    log.info("QoS configuration disabled successfully!")
    return True


