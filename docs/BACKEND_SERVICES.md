# BACKEND_SERVICES.md

# Zentariq One Backend Services Specification

Version: 1.0

## Purpose

This document defines the backend service layer used by Zentariq One.

Business logic must never live inside React components or API routes.

Architecture:

Client
→ API / Server Actions
→ Service Layer
→ Business Rule Engine
→ Repository / Supabase
→ Database

---

# Core Principles

- Single responsibility
- Strong typing
- Dependency injection when appropriate
- No duplicated logic
- Every write operation validates permissions
- Every important write creates an Audit Log

---

# Service Architecture

/services

- AuthService
- CompanyService
- UserService
- PermissionService
- SiteService
- StudyService
- VisitTemplateService
- SubjectService
- VisitService
- CalendarService
- ChartService
- RegulatoryService
- FileService
- TaskService
- BusinessRuleEngine
- ClinicalIntelligenceService
- AnalyticsService
- NotificationService
- AuditService
- SearchService

---

# AuthService

Responsibilities

- Login
- Logout
- Session validation
- Current user
- Token refresh

Never expose authentication logic to UI components.

---

# PermissionService

Responsibilities

- Resolve user roles
- Resolve permissions
- Validate site access
- Validate module access

Primary Methods

- hasPermission()
- canAccessSite()
- canAccessStudy()
- canApprove()

---

# CompanyService

Responsibilities

- Company profile
- Branding
- Subscription
- Settings

---

# UserService

Responsibilities

- CRUD users
- Role assignment
- Site assignment
- User status

---

# InvitationService

Responsibilities

- Send invitation (generates token, stores user_invitations record, emails invitee)
- Validate invitation token (public — no auth required)
- Accept invitation (creates auth.users record, profile, assigns roles and sites)
- Revoke invitation (admin only)
- Resend invitation (resets token and expiry)
- Expire stale invitations (cron — runs daily)

Integration:

- Calls NotificationService to send the invitation email
- Calls AuditService on every state change
- On acceptance: calls UserService to create profile, assign roles and sites

---

# SiteService

Responsibilities

- CRUD sites
- Site settings
- User assignments
- Site metrics

---

# StudyService

Responsibilities

- Create study
- Update study
- Activate study
- Close study
- Assign sites
- Assign staff
- Upload protocol

Protocol upload invokes Protocol Agent.

---

# VisitTemplateService

Responsibilities

- Build templates
- Version templates
- Archive templates
- Approve templates

Never overwrite approved versions.

---

# SubjectService

Responsibilities

- Create subject
- Change status
- Timeline
- Notes
- Documents
- Subject validation

Creating a subject automatically invokes Business Rules.

---

# VisitService

Responsibilities

- Generate visits
- Complete visit
- Reschedule
- Cancel
- Out-of-window detection

Completing a visit creates a Chart.

---

# CalendarService

Responsibilities

- Calendar events
- Sponsor visits
- Monitoring visits
- Staff meetings
- Training events

Patient visits are synchronized with Visit records.

---

# ChartService

Responsibilities

- Create chart
- Queue ordering
- Mark Entered in EDC
- Metrics
- Comments

Priority is calculated through Business Rules.

---

# RegulatoryService

Responsibilities

- Regulatory binder
- Study documents
- Staff documents
- Versioning
- Expiration tracking

Uses Regulatory Agent for metadata extraction.

---

# FileService

Responsibilities

- Secure upload
- Signed URLs
- Versioning
- OCR
- AI metadata
- File linking

No module stores files directly.

---

# TaskService

Responsibilities

- Generate tasks
- Complete tasks
- Reassign
- Comments
- Prioritization

Task ordering:

1. Overdue
2. Out of Window
3. Sponsor Visit
4. Remaining work by Site

---

# BusinessRuleEngine

Responsibilities

- Evaluate triggers
- Execute actions
- Create tasks
- Notifications
- KPI updates

Every execution is logged.

---

# ClinicalIntelligenceService

Coordinates all AI agents.

Agents:

- Protocol
- Regulatory
- Subject
- Data
- Analytics
- Executive
- Copilot

AI cannot modify production data without approval.

---

# AnalyticsService

Responsibilities

- KPI calculation
- Dashboard aggregation
- Reports
- Forecasts

KPIs are recalculated incrementally.

---

# NotificationService

Channels

- In-App
- Email
- Future SMS

Supports batching and priority routing.

---

# AuditService

Responsibilities

- Immutable logs
- Record history
- User actions
- AI actions
- Business Rule executions

Every critical backend operation writes an audit record.

---

# SearchService

Provides global search.

Indexes:

- Subjects
- Studies
- Visits
- Charts
- Documents
- Tasks
- Users

Supports permission-aware search.

---

# Cross-Service Rules

Every service should:

- Validate authentication
- Validate permissions
- Validate company
- Validate site
- Execute Business Rules if required
- Update Analytics when applicable
- Write Audit Trail

---

# Error Handling

Throw domain-specific exceptions.

Examples:

- ValidationError
- PermissionDeniedError
- BusinessRuleError
- FileUploadError
- AIReviewRequiredError

Never expose internal database errors to clients.

---

# Final Implementation Rule

Backend services are the single source of business logic.

API routes call services.

Services call repositories.

Repositories interact with Supabase.

Business Rules, Analytics, Notifications and Audit Trail are integrated through the service layer.
