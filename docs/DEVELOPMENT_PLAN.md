# DEVELOPMENT_PLAN.md

# Zentariq One Development Plan

Version: 1.0

## Objective

Build Zentariq One incrementally using a modular architecture. Every sprint must produce a deployable and testable application.

---

# Phase 0 - Project Foundation

Goals:

- Create GitHub repository
- Configure Next.js
- Configure TypeScript
- Configure Tailwind CSS
- Configure Supabase
- Configure Vercel
- CI/CD pipeline
- Environment variables
- Logging

Deliverable:
Running empty application with authentication.

---

# Sprint 1 - Authentication & SaaS Foundation

Modules:

- Login
- Logout
- Invite Users
- Companies
- Sites
- Roles
- Permissions
- User Profiles

Deliverables:

- Multi-tenant authentication
- Row Level Security
- Company isolation
- Site access control

---

# Sprint 2 - Study Management

Modules:

- Studies
- Study Sites
- Study Staff
- Visit Templates
- Protocol Upload

Deliverables:

- Manual Study Creation
- AI Draft Study Creation
- Visit Template Builder

---

# Sprint 3 - Subject Management

Modules:

- Subjects
- Timeline
- Notes
- Documents
- Status History

Deliverables:

- Subject Profile
- Subject Lifecycle
- Timeline

---

# Sprint 4 - Visits & Calendar

Modules:

- Scheduled Visits
- Unscheduled Visits
- Calendar
- Sponsor Visits
- Monitoring Visits

Deliverables:

- Automatic Visit Generation
- Calendar
- Visit Windows

---

# Sprint 5 - Charts & Data Entry

Modules:

- Chart Queue
- Chart Profile
- Data Entry Workflow
- Chart Metrics

Deliverables:

- Automatic Chart Creation
- Queue Prioritization
- Entered in EDC workflow

---

# Sprint 6 - Regulatory

Modules:

- Regulatory Binder
- Staff Documents
- Study Documents
- Versioning

Deliverables:

- Regulatory Health Score
- Expiration Tracking

---

# Sprint 7 - Enterprise Document Center

Modules:

- Secure File Storage
- OCR
- AI Metadata
- Version History
- Search

Deliverables:
Single document repository.

---

# Sprint 8 - Task Engine

Modules:

- Tasks
- Assignment
- Prioritization
- Comments
- History

Deliverables:
Operational work queue.

---

# Sprint 9 - Business Rules

Modules:

- Rule Builder
- Rule Execution
- Rule Logs

Deliverables:
Configurable automation engine.

---

# Sprint 10 - Clinical Intelligence

Agents:

- Protocol
- Regulatory
- Subject
- Data
- Analytics
- Executive
- Copilot

Deliverables:
AI integrated across Zentariq One.

---

# Sprint 11 - Analytics

Modules:

- Executive Dashboard
- Operational KPIs
- Reports
- Exports

Deliverables:
Interactive analytics.

---

# Sprint 12 - Settings

Modules:

- Company Settings
- Notification Settings
- Document Types
- AI Configuration

---

# Sprint 13 - Security Hardening

Tasks:

- Security Audit
- Performance Testing
- RLS Review
- API Validation
- Permission Validation

---

# Sprint 14 - Production Readiness

Tasks:

- Documentation
- Backup Strategy
- Monitoring
- Error Tracking
- Final QA
- Production Deployment

---

# Definition of Done

Every sprint must include:

- Unit tests
- Integration tests
- Responsive UI
- Audit Trail
- Permission validation
- Documentation
- Business Rules validation

---

# Coding Rules

- Clean Architecture
- Feature-based modules
- Reusable components
- No duplicated business logic
- Strict TypeScript
- Server-side validation
- Row Level Security
- Audit logging
- AI behind approval workflows

---

# Repository Structure

/docs
/app
/components
/features
/lib
/services
/hooks
/types
/supabase
/public

---

# Final Instruction for Claude

Implement one sprint at a time.

Never skip architecture.

Never bypass Business Rules.

Never bypass Security.

Every module must integrate with:

- Audit Trail
- Task Engine
- Analytics
- Clinical Intelligence
  where applicable.
