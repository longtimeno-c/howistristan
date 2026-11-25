#!/usr/bin/env python3
"""One-time Garmin sign-in. Run this on your own computer, never in CI.

    pip install -r requirements.txt
    python3 scripts/garmin-login.py

It asks for your Garmin email, password and (if you use one) the two-factor code,
then prints a token. Save that token as the repository secret GARMIN_TOKENS:

    python3 scripts/garmin-login.py | gh secret set GARMIN_TOKENS

Your password is not stored anywhere. The token gives read and write access to
your Garmin account, so treat it like a password: it belongs in the secret and
nowhere else. To revoke it, change your Garmin password.
"""
import getpass
import sys

from garminconnect import Garmin


def ask(prompt: str) -> str:
    # Prompts go to stderr so stdout carries only the token and can be piped.
    sys.stderr.write(prompt)
    sys.stderr.flush()
    return sys.stdin.readline().strip() if not sys.stdin.isatty() else input()


def main() -> int:
    sys.stderr.write("Garmin email: ")
    sys.stderr.flush()
    email = input().strip()
    password = getpass.getpass("Garmin password: ", stream=sys.stderr)
    client = Garmin(email=email, password=password, prompt_mfa=lambda: ask("Two-factor code: "))
    client.login()
    sys.stderr.write("\nSigned in. Token follows on stdout; save it as GARMIN_TOKENS.\n\n")
    print(client.client.dumps())
    return 0


if __name__ == "__main__":
    sys.exit(main())
