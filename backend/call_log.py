import os
import re
from pathlib import Path
from db_manager import get_call_log_from_db


# Get root directory for Asterisk recordings from environment variable


def classify_cdr_direction(cdr: dict) -> str:
    """
    Classify call direction (IN/OUT/INTERNAL) using weighted voting.
    """
    # Extract and clean fields
    src = str(cdr.get("src", "")).strip()
    dst = str(cdr.get("dst", "")).strip()
    dcontext = str(cdr.get("dcontext", "")).lower()
    channel = str(cdr.get("channel", "")).lower()
    dstchannel = str(cdr.get("dstchannel", "")).lower()
    
    votes = {"IN": 0, "OUT": 0, "INTERNAL": 0}
    
    # Patterns
    is_ext = lambda n: bool(re.match(r"^[1-9]\d{1,4}$", n))
    is_pstn = lambda n: bool(re.match(r"^\+?\d{7,15}$", n))
    
    src_ext, dst_ext = is_ext(src), is_ext(dst)
    src_pstn, dst_pstn = is_pstn(src), is_pstn(dst)
    
    # Vote 1: Context (weight 4)
    # Convert to lowercase for case-insensitive matching
    dcontext_lower = dcontext.lower()
    
    # Incoming keywords (including any IVR)
    incoming_keywords = ["from-trunk", "from-pstn", "incoming", "ext-did", "ivr","queue"]
    
    # Outgoing keywords
    outgoing_keywords = ["from-internal", "outbound", "dialout"]
    
    # Check all incoming keywords
    if any(keyword in dcontext_lower for keyword in incoming_keywords):
        votes["IN"] += 4
    
    # Check all outgoing keywords
    if any(keyword in dcontext_lower for keyword in outgoing_keywords):
        votes["OUT"] += 2
    
    # Vote 2: Number patterns (weight 3-5)
    if src_ext and dst_pstn:
        votes["OUT"] += 3
    elif src_pstn and dst_ext:
        votes["IN"] += 3
    elif src_ext and dst_ext:
        votes["INTERNAL"] += 5
    
    # Vote 3: Channels (weight 2)
    trunk_indicators = ["trunk", "gw", "provider", "peer", "dahdi"]
    if any(x in channel for x in trunk_indicators):
        votes["IN"] += 2
    if any(x in dstchannel for x in trunk_indicators):
        votes["OUT"] += 2
    
    # Vote 4: Last app (weight 3-2)
    lastapp = str(cdr.get("lastapp", "")).lower()
    if lastapp == "queue" or lastapp == "ivr" or lastapp == "stasis":
        votes["IN"] += 2
    elif lastapp == "page" or lastapp == "chanspy" or lastapp == "echo":
        votes["INTERNAL"] += 3
    elif lastapp == "background":
        if src_ext:
            votes["INTERNAL"] += 3        
    # Return max votes
    max_votes = max(votes.values())
    if max_votes == 0:
        return "INTERNAL" if src_ext else "UNKNOWN"
    
    # Tie breaker: IN vs OUT
    if votes["IN"] == votes["OUT"] == max_votes:
        return "IN" if src_pstn else "OUT"
    
    return max(votes, key=votes.get)


def convert_channel_to_extension(dstchannel,channel):
    try:
        temp_ext = dstchannel.split('-')[0].split('/')[1]
        if temp_ext.isdigit():
            extension = temp_ext
        else:
            temp_ext = channel.split('-')[0].split('/')[1]
            extension = temp_ext
    except IndexError:
        extension = None
    return extension

def get_recording_path(file_wav):
    root_dir = Path(os.getenv('ASTERISK_RECORDING_ROOT_DIR','/home/ibrahim/pyc/voip/'))
    # '**/*' means "everything in this folder and all subfolders"
    for path in root_dir.glob('**/*'):
        if path.is_file():
            cont=str(path)
            if str(file_wav) in cont:
                return path
    return None


def call_log(limit=None, date=None, date_from=None, date_to=None, allowed_extensions=None):
    call_log = get_call_log_from_db(limit=limit, date=date,
                                     date_from=date_from, date_to=date_to,
                                     allowed_extensions=allowed_extensions)
    
    result = []
    for cdr in call_log:
        cdr['call_type'] = classify_cdr_direction(cdr)
        cdr['extension'] = convert_channel_to_extension(cdr['dstchannel'],cdr['channel'])        
        if cdr.get('recordingfile'):
            cdr['recording_path'] = get_recording_path(cdr['recordingfile'])
        else:
            cdr['recording_path'] = None
        
        # Determine phone number (external party) based on call direction
        call_type = cdr.get('call_type', '')
        if call_type == 'IN':
            phone_number = cdr.get('src', '')
        elif call_type == 'OUT':
            phone_number = cdr.get('dst', '')
        else:
            phone_number = cdr.get('dst', '') or cdr.get('src', '')
        
        # Map disposition to friendly status
        disposition = str(cdr.get('disposition', '')).upper()
        status_map = {
            'ANSWERED': 'completed',
            'NO ANSWER': 'no_answer',
            'FAILED': 'failed',
            'BUSY': 'busy',
        }
        status = status_map.get(disposition, disposition.lower() or 'unknown')
        
        # Create a new dict with only the fields you want
        filtered_cdr = {
            'calldate': cdr.get('calldate'),
            'src': cdr.get('src'),
            'dst': cdr.get('dst'),
            'phone_number': phone_number,
            'customer_name': cdr.get('cnam') or None,
            'duration': cdr.get('duration'),
            'talk': cdr.get('billsec'),  # billsec renamed to talk
            'disposition': disposition,
            'status': status,
            'QoS': cdr.get('userfield'),
            'extension': cdr.get('extension'),
            'call_type': cdr.get('call_type'),
            'recording_path': str(cdr['recording_path']) if cdr.get('recording_path') else None,
            'recording_file': cdr.get('recordingfile') or None,
            'app': cdr.get('call_app'),  # lastapp renamed to app
        }
        
        result.append(filtered_cdr)
    
    return result