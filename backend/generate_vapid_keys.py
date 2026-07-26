#!/usr/bin/env python3
"""
Generate a VAPID key pair for browser Web Push and print the .env lines to add.

Usage:
    python generate_vapid_keys.py

Then paste the printed VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT lines
into backend/.env and restart OpDesk. Web Push stays disabled until these are set.
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def main() -> None:
    # VAPID uses an ECDSA P-256 key pair.
    private_key = ec.generate_private_key(ec.SECP256R1())

    # Private key: raw 32-byte scalar, base64url (pywebpush accepts this form).
    priv_int = private_key.private_numbers().private_value
    priv_bytes = priv_int.to_bytes(32, "big")
    vapid_private = _b64url(priv_bytes)

    # Public key: uncompressed point (0x04 || X || Y), base64url — the applicationServerKey.
    pub_bytes = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    vapid_public = _b64url(pub_bytes)

    print("# Add these to backend/.env, then restart OpDesk:")
    print(f"VAPID_PUBLIC_KEY={vapid_public}")
    print(f"VAPID_PRIVATE_KEY={vapid_private}")
    print("VAPID_SUBJECT=mailto:admin@example.com")


if __name__ == "__main__":
    main()
