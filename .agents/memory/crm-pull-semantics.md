---
name: CRM pull semantics
description: What inbound CRM sync (HubSpot/GHL pull) does and does not do — shapes any UI copy around "importing" from a CRM.
---

**Rule:** `pullCrmUpdates` only reconciles remote contacts against leads that ALREADY exist locally (matched by external id / email / phone). Unmatched remote contacts are counted (`unmatched`) but never created as leads.

**Why:** Pull is a sync/reconciliation mechanism with conflict protection, not an importer. On a fresh org a pull yields "0 matched, N unmatched" — every UI that offers "connect your CRM" must not promise it will import the lead list (onboarding wizard steers users to file upload for the initial list and says so explicitly).

**How to apply:** Any copy or flow that implies "bring leads in via CRM" must either (a) be honest that only existing leads get updated, or (b) wait until a "create unmatched contacts as leads" capability actually ships.
