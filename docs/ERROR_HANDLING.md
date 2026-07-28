# ERROR_HANDLING.md

# Zentariq One Error Handling

## Goals

- User-friendly messages
- Developer diagnostics
- Audit critical failures

## Error Categories

- Validation
- Authentication
- Authorization
- Business Rule
- Database
- AI
- Storage
- Network

## Logging

Every unexpected error logs:

- User
- Company
- Site
- Module
- Stack Trace
- Timestamp

## User Experience

Never expose raw SQL or stack traces.

Display actionable messages.

## Retry Strategy

Automatic retry for transient failures:

- AI
- Notifications
- Network
- Queue processing

## Final Rule

All critical failures are logged and traceable.
