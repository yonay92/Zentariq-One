# BUSINESS RULES 02 - Studies

## Study Creation

Trigger:

- Admin creates study manually OR uploads protocol.

Rules:

- Protocol upload starts AI extraction.
- AI creates draft only.
- Human approval required.
- Assign one or more Sites.
- Activate study.
- Generate Visit Template.

## Protocol Amendment

Trigger:
New protocol version uploaded.

Actions:

- Compare versions.
- Highlight differences.
- Create new Visit Template version.
- Preserve previous version.
- Notify Regulatory and CRCs.

## Study Closeout

Actions:

- Prevent new Subjects.
- Preserve historical data.
- Archive Regulatory Binder.
- Generate closeout tasks.

## Study Editing

Study fields (name, protocol number, sponsor, CRO, phase, therapeutic area,
dates) may be edited at any time by a user with `edit_study` or
`manage_studies`. Editing is always audit logged.

## Study Archive

Zentariq One never hard-deletes a Study from the application. "Delete" is
implemented as Archive (`status = 'archived'`).

Rules:

- Requires `manage_studies`.
- Blocked if the study has one or more enrolled Subjects, unless the user
  also holds `force_archive_study` — a permission not granted to any role by
  default; a company owner must deliberately enable it per-role from
  Settings > Roles.
- Forcing an archive (bypassing the enrolled-subjects block) requires a
  reason. The reason is mandatory only in the forced case — archiving a
  study with no enrolled subjects does not require one.
- Archiving is audit logged, including the user, timestamp, enrolled-subject
  count, whether the block was overridden, and the reason (if any).
- Archived studies are excluded from the default Studies list; the list's
  Active / Archived / All filter controls visibility.
- The underlying override + required-reason mechanism
  (`PermissionService.guardDangerousOperation`) is generic — intended to be
  reused for future "dangerous operation" business rules, not specific to
  Study Archive.
