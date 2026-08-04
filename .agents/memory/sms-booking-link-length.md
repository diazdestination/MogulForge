---
name: SMS drafts vs. minted booking links
description: Long signed /book/<token> URLs can blow the SMS draft length cap; template drafts must degrade to a compact body.
---

Signed per-lead `/book/<token>` booking URLs are ~200–300 chars (base64url JSON claims + HMAC), so appending them to a full SMS template body exceeds the 480-char SMS content-schema cap and validation throws — which used to 500 campaign preview AND activation for any SMS campaign using `{{booking_link}}`.

**Why:** the length cap is enforced by `parseMessageContent` after composition; the booking line is appended to an already near-limit template.

**How to apply:** any code path that composes SMS bodies with a resolved booking link must shrink the surrounding copy (compact greeting + link + opt-out) when over the cap, never drop the link or the opt-out. Note the booking token cannot be shortened (stateless HMAC). Also: the `booking_url` appointments adapter reports connected whenever SESSION_SECRET can sign links — tests must not expect it to be a not-connected stub.
