# FINAL_ARCHITECTURE_AUDIT.md

# Zentariq One — Pre-Sprint 1 Architecture Audit

Version: 1.0
Auditor: Lead Software Architect
Scope: All documents in /docs
Status: BLOCKED — 4 conflicts and 5 missing definitions must be resolved before Sprint 1

---

## Audit Summary

| Severity | Count | Category                                       |
| -------- | ----- | ---------------------------------------------- |
| CRITICAL | 1     | Incorrect status value in seed data            |
| HIGH     | 3     | Conflicting definitions / missing API coverage |
| MEDIUM   | 3     | Missing entities and service definitions       |
| LOW      | 2     | Minor structural gaps                          |

**Total findings: 9**

---

## CRITICAL

### AUDIT-01 — `BUSINESS_RULE_ENGINE.md` seed rule uses an undefined chart status value

**Documents in conflict:**

- `docs/BUSINESS_RULE_ENGINE.md` §11 — seed rule "Chart Overdue" sets `status_value: "overdue"`
- `docs/DATABASE_Part_04_Charts_Tasks_Analytics.md` §2 — defines valid `charts.status` values

**Conflict:**
`DATABASE_Part_04` defines the complete set of valid `charts.status` values:

```
chart_ready | in_progress | entered_in_edc | on_hold
```

`"overdue"` does not appear in this list. The seed rule action:

```jsonc
{ "type": "update_status", "payload": { "status_value": "overdue" } }
```

would either fail silently or violate a `CHECK` constraint at the database level. Overdue state is tracked by `chart_metrics.overdue_days` and `charts.priority`, not by a separate status value.

**Required fix:**
Replace the `update_status` action in the "Chart Overdue" seed rule with an `update_priority` action, or change the action type to make the intent explicit. The correct behavior is:

```jsonc
{
  "type": "update_status",
  "payload": { "status_value": "in_progress" },
}
```

and separately:

```jsonc
{
  "type": "calculate_kpi",
  "payload": { "kpi_name": "chart_priority_score" },
}
```

Or add `"overdue"` as a valid `charts.status` value to `DATABASE_Part_04` and add it to the `charts.status CHECK` constraint. One of these two resolutions must be chosen and applied consistently.

**Files to update:** `BUSINESS_RULE_ENGINE.md` or `DATABASE_Part_04_Charts_Tasks_Analytics.md`

---

## HIGH

### AUDIT-02 — `API.md` requires `full_name` at invitation time; `INVITATIONS.md` places it at acceptance time

**Documents in conflict:**

- `docs/API.md` §7 — `POST /api/users/invite` requires `{ email, full_name, roles, sites }`
- `docs/INVITATIONS.md` §5 — `SendInvitationInput` takes `{ email, roleIds, siteIds }` — no `full_name`; `AcceptInvitationInput` takes `{ token, fullName, password }`

**Conflict:**
`API.md` makes the Admin responsible for providing the invitee's full name at invite time. `INVITATIONS.md` correctly makes the invitee enter their own name during account setup. These are mutually exclusive: only one can be implemented, and they produce different user experiences and different database payloads.

The correct design is `INVITATIONS.md` — the invitee should choose their own display name. An admin sending an invitation rarely knows the invitee's preferred name format. The `user_invitations` table in `INVITATIONS.md` does not include a `full_name` column, confirming this is the intended design.

**Required fix:**
Update `API.md §7` `POST /api/users/invite` body to:

```
Required:
- email
- role_ids  (array of UUID)
- site_ids  (array of UUID)
```

Remove `full_name` from the invite payload. It belongs in `POST /api/invitations/accept`.

**File to update:** `API.md`

---

### AUDIT-03 — `PROMPTS.md` confidence type (string) conflicts with database schema and `AI_PROVIDER_ARCHITECTURE.md` (numeric)

**Documents in conflict:**

- `docs/PROMPTS.md` §3 — Standard AI output: `"confidence": "high | medium | low"` (string enum)
- `docs/DATABASE_Part_05_Regulatory_Files_AI_Audit.md` §18 — `ai_responses.confidence numeric`
- `docs/AI_PROVIDER_ARCHITECTURE.md` §7.1 — `BaseAgentOutput.confidence: number` (0.0–1.0)

**Conflict:**
Three documents define the confidence field with three incompatible representations:

- `PROMPTS.md` → string: `"high"`, `"medium"`, `"low"`
- `DATABASE_Part_05` → `numeric` (implying 0.0–1.0 or a percentage)
- `AI_PROVIDER_ARCHITECTURE.md` → `number` between 0.0 and 1.0

An implementer reading `PROMPTS.md` would build agents that return string confidence. An implementer reading the database schema would expect a float. These cannot be stored directly in `ai_responses.confidence` without an undocumented transformation step.

**Required fix — choose one resolution and apply it everywhere:**

**Option A (recommended):** Agents return `confidence: number` (0.0–1.0). Update `PROMPTS.md §3` standard output format to use numeric confidence. Add a `confidence_label` helper field (e.g., `< 0.5 = low, 0.5–0.79 = medium, >= 0.8 = high`) for display. Update all agent prompt expected-output examples in `PROMPTS.md §4–12` to use numeric values.

**Option B:** Add a `confidence_label text` column alongside `confidence numeric` in `ai_responses`. Agents return both. More verbose but preserves both formats.

**Files to update:** `PROMPTS.md` (most affected) — update §3, §4 through §12 expected output examples.

---

### AUDIT-04 — `API.md` is missing notification, invitation management, and two other endpoints

**Source documents defining endpoints not in API.md:**

- `docs/NOTIFICATIONS.md` §8.2 — defines 6 notification endpoints
- `docs/INVITATIONS.md` §6 — defines 4 additional invitation endpoints
- `docs/ARCHITECT_REVIEW.md` §5.2 — flags 2 missing endpoints

**Missing endpoints:**

```
Notifications (NOTIFICATIONS.md §8.2):
  GET    /api/notifications
  GET    /api/notifications/unread-count
  PATCH  /api/notifications/:id/read
  POST   /api/notifications/mark-all-read
  GET    /api/notifications/preferences
  PUT    /api/notifications/preferences/:type

Invitations (INVITATIONS.md §6):
  POST   /api/invitations/accept            ← public endpoint (no auth)
  DELETE /api/users/invitations/:id         ← revoke
  POST   /api/users/invitations/:id/resend  ← resend
  GET    /api/users/invitations             ← list all

Flagged in ARCHITECT_REVIEW.md §5.2:
  GET    /api/subjects/:id/visits           ← needed for Subject Profile Visits tab
  PATCH  /api/regulatory/documents/:id      ← needed for metadata correction before AI approval
```

**Impact:** Sprint 1 will implement invitation flows without an API contract to reference, creating risk of inconsistency between the API spec and the service implementation.

**Required fix:**
Add all 12 missing endpoints to `API.md` with their request/response contracts. Notification and invitation endpoints are Sprint 1 requirements; subject visits and regulatory patch are Sprint 3 and Sprint 6 respectively but should be documented now.

**File to update:** `API.md`

---

## MEDIUM

### AUDIT-05 — `ERD.md` does not include the four tables added by new architecture documents

**Document out of date:** `docs/ERD.md`

**Missing from ERD:**

- `notifications` (NOTIFICATIONS.md §3.1)
- `notification_preferences` (NOTIFICATIONS.md §3.2)
- `notification_email_queue` (NOTIFICATIONS.md §7.1)
- `user_invitations` (INVITATIONS.md §3.1)

**Impact:** An implementer reading `ERD.md` will build migration 001 missing these four tables or unaware of their relationships to `companies` and `profiles`.

**Required fix:**
Add the four tables to `ERD.md §2` (High-Level ERD) and `ERD.md §12` (Mermaid diagram).

Additions to §2:

```text
profiles
   |-- user_invitations

companies
   |-- notifications
   |-- notification_preferences
   |-- notification_email_queue
   |-- user_invitations
```

**File to update:** `ERD.md`

---

### AUDIT-06 — `DATABASE_Part_05` `ai_agents` seed keys include `training_agent`, which three other documents exclude from MVP

**Documents in conflict:**

- `docs/DATABASE_Part_05_Regulatory_Files_AI_Audit.md` §16 — lists `training_agent` in agent keys
- `docs/GAP_ANALYSIS.md` GAP-AI-03 — recommends removing `training_agent` from MVP seed data
- `docs/AI_PROVIDER_ARCHITECTURE.md` §12 — explicitly states: "Training Agent is excluded from MVP per GAP-AI-03. The `training_agent` key must not be seeded in `ai_agents` for v1.0."
- `docs/ARCHITECT_REVIEW.md` §7.2 — recommends excluding Training Agent from MVP

**Impact:** A developer reading `DATABASE_Part_05` to write seed data will include `training_agent`. A developer reading `AI_PROVIDER_ARCHITECTURE.md` will exclude it. The seed SQL will diverge depending on which doc is read first.

**Required fix:**
Update `DATABASE_Part_05 §16` to remove `training_agent` from the Agent Keys list and add a note: "Training Agent is excluded from MVP. See `AI_PROVIDER_ARCHITECTURE.md` §12."

**File to update:** `DATABASE_Part_05_Regulatory_Files_AI_Audit.md`

---

### AUDIT-07 — `BACKEND_SERVICES.md` does not list `InvitationService`

**Document missing entity:** `docs/BACKEND_SERVICES.md`

**Conflict:**
`INVITATIONS.md §5` defines a dedicated `InvitationService` with six methods. `BACKEND_SERVICES.md` lists the full service registry used by Sprint 1 through Sprint 14 and does not include `InvitationService`. It assigns invitation responsibility to `UserService`, but the INVITATIONS.md service contract is too large to embed in `UserService` without that service violating single-responsibility.

**Required fix:**
Add `InvitationService` to `BACKEND_SERVICES.md` with its responsibilities:

- Send invitation
- Validate token
- Accept invitation (creates profile, assigns roles and sites)
- Revoke invitation
- Resend invitation
- Expire stale invitations (cron)

**File to update:** `BACKEND_SERVICES.md`

---

## LOW

### AUDIT-08 — `NOTIFICATIONS.md` event catalog is missing the `protocol_amendment` event type

**Source of requirement:** `docs/BUSINESS_RULES_02_Studies.md` — Protocol Amendment actions include "Notify Regulatory and CRCs."

**Missing from:** `docs/NOTIFICATIONS.md §6` — event type catalog.

**Impact:** The notification dispatch for protocol amendments has no defined event type, so `NotificationService.dispatch()` cannot be called with a valid `type` value when a protocol amendment is detected.

**Required fix:**
Add to `NOTIFICATIONS.md §6`:

| Event Type           | Default Priority | Trigger Source                         | Default Title Template           |
| -------------------- | ---------------- | -------------------------------------- | -------------------------------- |
| `protocol_amendment` | high             | StudyService.uploadProtocolAmendment() | "Protocol amended: {study_name}" |

**File to update:** `NOTIFICATIONS.md`

---

### AUDIT-09 — `BUSINESS_RULE_ENGINE.md` adds columns to `rule_execution_logs` without documenting them in `DATABASE_Part_05`

**Documents in tension:**

- `docs/BUSINESS_RULE_ENGINE.md` §3.2 — defines extended `rule_execution_logs` schema with 4 new columns: `trigger_event text`, `conditions_matched boolean`, `actions_executed jsonb`, `error_message text`
- `docs/DATABASE_Part_05_Regulatory_Files_AI_Audit.md` §15 — defines the base `rule_execution_logs` schema without these columns

**Impact:** Migration 009 (business rules) will need to include these columns, but the base schema doc does not mention them. A developer reading `DATABASE_Part_05` to write the migration will produce an incomplete table.

**Required fix (minimal):**
Add a note to `DATABASE_Part_05 §15`:

```
Note: rule_execution_logs is extended in docs/BUSINESS_RULE_ENGINE.md §3.2
with additional operational columns required by the BRE execution model.
See that document for the complete column list.
```

**File to update:** `DATABASE_Part_05_Regulatory_Files_AI_Audit.md`

---

## Resolution Priority

### Must resolve before Sprint 1

| ID       | Finding                                     | Why it blocks Sprint 1                                                                                |
| -------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AUDIT-01 | Chart status "overdue" invalid              | Seed rule will fail; blocks BRE implementation regardless of sprint                                   |
| AUDIT-02 | `full_name` in invite payload               | Sprint 1 implements invitation; conflicting contract produces broken API                              |
| AUDIT-03 | Confidence type mismatch                    | All AI agent implementations depend on this; sprint 10 will build on wrong assumptions if unfixed now |
| AUDIT-04 | Missing API endpoints                       | Sprint 1 needs notification and invitation endpoints defined                                          |
| AUDIT-05 | ERD missing 4 tables                        | Sprint 1 migration 001 must include all four tables                                                   |
| AUDIT-06 | `training_agent` in seed data               | Sprint 1 seed data will include an undefined/unsupported agent                                        |
| AUDIT-07 | `InvitationService` not in BACKEND_SERVICES | Sprint 1 service architecture is incomplete                                                           |

### Can be addressed before their relevant sprint

| ID       | Finding                                 | Relevant Sprint             |
| -------- | --------------------------------------- | --------------------------- |
| AUDIT-08 | `protocol_amendment` event type missing | Sprint 2 (Study Management) |
| AUDIT-09 | `rule_execution_logs` column gap        | Sprint 9 (Business Rules)   |

---

## Files Requiring Updates

| File                                            | Findings           | Changes Required                                                   |
| ----------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| `BUSINESS_RULE_ENGINE.md`                       | AUDIT-01           | Fix "overdue" status in Chart Overdue seed rule                    |
| `API.md`                                        | AUDIT-02, AUDIT-04 | Remove `full_name` from invite; add 12 missing endpoints           |
| `PROMPTS.md`                                    | AUDIT-03           | Change confidence type to numeric across all agent output examples |
| `ERD.md`                                        | AUDIT-05           | Add 4 new tables to diagram and relationship list                  |
| `DATABASE_Part_05_Regulatory_Files_AI_Audit.md` | AUDIT-06, AUDIT-09 | Remove `training_agent`; add cross-reference note to BRE columns   |
| `BACKEND_SERVICES.md`                           | AUDIT-07           | Add `InvitationService` entry                                      |
| `NOTIFICATIONS.md`                              | AUDIT-08           | Add `protocol_amendment` event type to catalog                     |
