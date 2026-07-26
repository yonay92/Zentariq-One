# SYSTEM_ARCHITECTURE.md

# Zentariq One System Architecture

## Purpose

This document defines the high-level architecture of Zentariq One. It is
the reference that all developers must follow.

## Architectural Principles

- Multi-tenant SaaS
- Modular architecture
- Automation-first
- AI-assisted workflows
- Secure by default
- Event-driven operations
- Complete auditability

## Core Components

### Dashboard

Personalized operational overview.

### Task Center

Central work queue for every user.

### Calendar

Patient visits and operational events.

### Studies

Study lifecycle, protocol management and visit templates.

### Subjects

Subject lifecycle from screening to end of study.

### Visits

Generated automatically from visit templates.

### Charts

Created when visits are completed and processed by Data Entry.

### Regulatory

Study and staff document management.

### Enterprise Document Center

Single repository for all files with versioning and AI metadata.

### Business Rules

Central rules engine responsible for workflow automation.

### Clinical Intelligence

AI platform composed of specialized agents.

### Analytics

Operational and executive dashboards.

### Audit Trail

Immutable log of all significant actions.

### Settings

Company configuration, roles, permissions and system behavior.

## High-Level Flow

Company → Sites → Studies → Subjects → Visits → Charts → Tasks →
Analytics

Business Rules monitor events continuously.

Clinical Intelligence analyzes information and proposes actions.

Task Engine creates operational work.

## Event Pipeline

Subject Created → Generate Visits → Create Calendar Events → Wait for
Visit Completion → Create Chart → Generate Task → Data Entry → Analytics
Updated

## Security Model

Every request is filtered by:

- company_id
- site_id
- role permissions
- row level security

## AI Integration

AI never writes production data directly.

Flow:

User Action → AI Analysis → User Review → Business Rules → Database
Update

## Scalability

The architecture must support:

- Unlimited companies
- Unlimited sites
- Millions of subjects
- Millions of visits
- Millions of documents

No module may contain company-specific logic.

Everything must be configurable.
