# BUSINESS RULES 01 - Core Workflow

## Purpose

Business Rules is the execution engine of Zentariq One. Users perform actions, Business Rules evaluate conditions, and the system creates the next operational step.

## Rule Engine

Every rule contains:

- Trigger
- Conditions
- Actions
- Priority
- Enabled flag

## Global Workflow

Event
→ Business Rule Evaluation
→ Clinical Intelligence (optional)
→ Task Engine
→ Notifications
→ Analytics
→ Audit Trail

## Global Rules

1. Every important event is evaluated.
2. Rules execute before notifications.
3. AI never bypasses Business Rules.
4. Every execution is logged.
5. Rules are company-specific.

## Event Sources

- Subject
- Visit
- Chart
- Document
- Study
- Task
- User
- Calendar

## Action Types

- Create Task
- Update Status
- Create Visit
- Send Notification
- Create Chart
- Calculate KPI
- Write Audit Log
