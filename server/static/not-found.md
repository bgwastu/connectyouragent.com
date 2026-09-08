# Connect Your Agent (CYA)

CYA gives an AI agent temporary, user-approved command access to a machine without opening inbound ports or sharing SSH credentials. Sessions are 100% in-memory and ephemeral.

## Session Unavailable

The requested session ({{code}}) is no longer available. It has either expired due to idle timeout, been closed by the user, or the session code is invalid.

## Running Commands

Commands cannot be executed because this session is unavailable or expired. Do not retry requests or send commands for this session code.

### Instructions for the Agent

- Do not run commands or retry requests for this session.
- Inform the user that the CYA session has expired or is invalid.
- Ask the user to create a new session at {{origin}} and share the updated prompt instructions.
