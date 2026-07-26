# BUSINESS_RULE_ENGINE.md

# Zentariq One — Business Rule Engine Specification

Version: 1.0
Status: Production-Ready — Required before Sprint 9

---

## 1. Purpose

The Business Rule Engine (BRE) is Zentariq One's automation backbone. It evaluates stored rules against runtime events and executes the resulting actions. Every module that writes data must pass through the BRE after completing its primary write.

This document resolves **GAP-BL-01** from GAP_ANALYSIS.md: it defines the JSONB condition schema, the action schema, the execution model, the invocation contract, and the seed rules that ship with the platform.

---

## 2. Core Principles

1. Rules are company-specific — no rule fires across company boundaries.
2. Rules execute server-side in the Node.js service layer (never in the browser).
3. Rules are evaluated synchronously after every qualifying write.
4. Every evaluation — pass or fail — is logged in `rule_execution_logs`.
5. A failing rule never rolls back the primary write that triggered it.
6. AI-triggered actions from rules must still pass through human approval before reaching the database.
7. Rules are ordered by `priority` (lower number = higher priority); ties execute in creation order.

---

## 3. Data Model

### 3.1 `business_rules` table (existing — from DATABASE_Part_05)

```sql
business_rules
- id          uuid primary key default gen_random_uuid()
- company_id  uuid references companies(id) not null
- rule_name   text not null
- rule_type   text not null   -- see §4 for allowed values
- conditions  jsonb not null  -- see §5 for schema
- actions     jsonb not null  -- see §6 for schema
- priority    integer default 100
- active      boolean default true
- created_by  uuid references profiles(id)
- created_at  timestamptz default now()
- updated_at  timestamptz default now()
```

### 3.2 `rule_execution_logs` table (existing — from DATABASE_Part_05)

Extended with the following columns beyond the base spec:

```sql
rule_execution_logs
- id                  uuid primary key default gen_random_uuid()
- company_id          uuid references companies(id) not null
- rule_id             uuid references business_rules(id) not null
- source_record_type  text not null    -- e.g., 'chart', 'regulatory_document'
- source_record_id    uuid not null
- trigger_event       text not null    -- e.g., 'chart.created'
- conditions_matched  boolean not null
- actions_executed    jsonb            -- array of action results
- error_message       text             -- null if successful
- result              text not null    -- 'matched', 'skipped', 'failed'
- executed_at         timestamptz default now()
```

**Retention policy:** Purge `rule_execution_logs` records older than 90 days. Unlike `audit_logs`, these are operational logs, not compliance records.

---

## 4. Rule Types

| `rule_type`           | When it fires                                     |
| --------------------- | ------------------------------------------------- |
| `document_expiration` | Regulatory document status changes or daily check |
| `visit_generation`    | Subject created or study activated                |
| `chart_priority`      | Chart created, updated, or daily recalculation    |
| `task_creation`       | Any module event requiring follow-up work         |
| `notification`        | Any module event requiring user alerts            |
| `ai_workflow`         | Events requiring Clinical Intelligence analysis   |

---

## 5. Condition Schema (JSONB)

The `conditions` field holds a `RuleConditionGroup` — a recursive structure supporting AND/OR logic.

### 5.1 TypeScript Interfaces (source of truth)

```typescript
// Primitive condition — evaluates one field against one value
interface RuleCondition {
  field: string;
  operator: RuleOperator;
  value: ConditionValue;
}

type RuleOperator =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'in'
  | 'not_in'
  | 'within_days' // true when a date field is within N days from today
  | 'past_days' // true when a date field is N or more days ago
  | 'is_null'
  | 'is_not_null';

type ConditionValue = string | number | boolean | string[] | null;

// Group — contains child conditions or nested groups
interface RuleConditionGroup {
  logic: 'AND' | 'OR';
  conditions: Array<RuleCondition | RuleConditionGroup>;
}
```

### 5.2 Field Reference Convention

Fields are expressed as `record_type.field_name`:

| Field expression                      | Resolved value                               |
| ------------------------------------- | -------------------------------------------- |
| `chart.days_pending`                  | Computed: `now() - chart.created_at` in days |
| `chart.status`                        | `charts.status` value                        |
| `chart.priority`                      | `charts.priority` value                      |
| `visit.target_date`                   | `visits.target_date`                         |
| `visit.status`                        | `visits.status`                              |
| `regulatory_document.expiration_date` | `regulatory_documents.expiration_date`       |
| `regulatory_document.status`          | `regulatory_documents.status`                |
| `subject.status`                      | `subjects.status`                            |
| `task.status`                         | `tasks.status`                               |
| `task.due_date`                       | `tasks.due_date`                             |

### 5.3 Condition Examples

```jsonc
// Single condition: chart is overdue > 7 days
{
  "logic": "AND",
  "conditions": [
    { "field": "chart.days_pending", "operator": ">", "value": 7 }
  ]
}

// Compound: document expiring within 30 days AND still current
{
  "logic": "AND",
  "conditions": [
    { "field": "regulatory_document.expiration_date", "operator": "within_days", "value": 30 },
    { "field": "regulatory_document.status", "operator": "==", "value": "current" }
  ]
}

// Nested OR inside AND
{
  "logic": "AND",
  "conditions": [
    { "field": "chart.status", "operator": "==", "value": "pending" },
    {
      "logic": "OR",
      "conditions": [
        { "field": "chart.days_pending", "operator": ">", "value": 14 },
        { "field": "chart.priority", "operator": "==", "value": "critical" }
      ]
    }
  ]
}
```

---

## 6. Action Schema (JSONB)

The `actions` field is an array of `RuleAction` objects. Actions execute in array order.

### 6.1 TypeScript Interface

```typescript
interface RuleAction {
  type: RuleActionType;
  payload: RuleActionPayload;
}

type RuleActionType =
  | 'create_task'
  | 'update_status'
  | 'send_notification'
  | 'calculate_kpi'
  | 'write_audit'
  | 'call_ai_agent';

interface RuleActionPayload {
  // create_task
  title?: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  assigned_role?: string; // role.key — task is assigned to all users with this role at the site
  due_date_offset_days?: number; // days from now; null = no due date

  // update_status
  status_value?: string;

  // send_notification
  notification_type?: string; // must match a key in the notifications event catalog (§9)
  notification_title?: string;
  notification_body?: string;
  recipient_role?: string; // role.key — notify all users with this role at the site

  // calculate_kpi
  kpi_name?: string;

  // write_audit
  audit_action?: string;
  audit_module?: string;

  // call_ai_agent
  agent_key?: string; // must match ai_agents.agent_key
  agent_input_mapping?: Record<string, string>; // maps source record fields to agent input
}
```

### 6.2 Action Examples

```jsonc
// Create a critical task for the CRC role
{
  "type": "create_task",
  "payload": {
    "title": "Chart overdue — immediate entry required",
    "priority": "critical",
    "assigned_role": "crc",
    "due_date_offset_days": 1
  }
}

// Update document status to expiring_soon
{
  "type": "update_status",
  "payload": {
    "status_value": "expiring_soon"
  }
}

// Notify the regulatory team
{
  "type": "send_notification",
  "payload": {
    "notification_type": "document_expiring",
    "recipient_role": "regulatory"
  }
}

// Trigger the Regulatory Agent for AI review
{
  "type": "call_ai_agent",
  "payload": {
    "agent_key": "regulatory_agent",
    "agent_input_mapping": {
      "document_id": "source_record_id"
    }
  }
}
```

---

## 7. Trigger Event Catalog

The trigger event is passed to the BRE by the calling service after each write. The BRE selects rules where `rule_type` matches the event category.

| Trigger Event                  | Rule Types Evaluated                           | Called After                           |
| ------------------------------ | ---------------------------------------------- | -------------------------------------- |
| `subject.created`              | `visit_generation`, `task_creation`            | SubjectService.createSubject()         |
| `subject.status_changed`       | `task_creation`, `notification`                | SubjectService.updateStatus()          |
| `visit.completed`              | `task_creation`, `notification`, `ai_workflow` | VisitService.completeVisit()           |
| `visit.out_of_window`          | `notification`, `task_creation`                | VisitService.calculateWindow() (daily) |
| `chart.created`                | `chart_priority`, `task_creation`              | ChartService.createChart()             |
| `chart.updated`                | `chart_priority`, `calculate_kpi`              | ChartService.updateChart()             |
| `chart.entered_in_edc`         | `calculate_kpi`, `write_audit`                 | ChartService.markEnteredInEDC()        |
| `regulatory_document.uploaded` | `notification`, `task_creation`, `ai_workflow` | RegulatoryService.uploadDocument()     |
| `regulatory_document.expiring` | `document_expiration`, `notification`          | Cron: daily expiration check           |
| `regulatory_document.expired`  | `document_expiration`, `notification`          | Cron: daily expiration check           |
| `task.created`                 | `notification`                                 | TaskService.createTask()               |
| `task.overdue`                 | `notification`, `task_creation`                | Cron: daily task check                 |
| `study.activated`              | `visit_generation`, `task_creation`            | StudyService.activateStudy()           |
| `ai_response.approved`         | `write_audit`, `calculate_kpi`                 | ClinicalIntelligenceService.approve()  |

---

## 8. Execution Model

### 8.1 Service Invocation Contract

Every service that performs a qualifying write must call the BRE after successfully completing the write:

```typescript
// Pattern — every service write follows this structure
async function exampleServiceWrite(input: Input, ctx: RequestContext): Promise<Result> {
  // 1. Validate permissions
  await permissionService.requirePermission(ctx.userId, 'required_permission');

  // 2. Primary write
  const record = await repository.insert(input);

  // 3. Audit trail
  await auditService.log({ action: 'record.created', record, ctx });

  // 4. Business Rules (always after audit)
  await businessRuleEngine.evaluate({
    event: 'record.created',
    sourceRecordType: 'record',
    sourceRecordId: record.id,
    companyId: ctx.companyId,
    siteId: record.siteId,
    context: record,
  });

  return record;
}
```

### 8.2 BRE Evaluation Sequence

```
businessRuleEngine.evaluate(event)
  1. Load all active rules for company_id WHERE rule_type matches event category
  2. Sort by priority ASC
  3. For each rule:
     a. Evaluate conditions against context object (see §5)
     b. If conditions match → execute actions in order (see §6)
     c. Log result to rule_execution_logs (conditions_matched, actions_executed, result)
  4. Return array of execution results to caller
```

### 8.3 Action Execution Guarantees

- **`create_task`**: Calls `TaskService.createTask()` — writes to `tasks` table, triggers task notification.
- **`update_status`**: Updates the source record's `status` field directly via the repository.
- **`send_notification`**: Calls `NotificationService.dispatch()` — see NOTIFICATIONS.md.
- **`calculate_kpi`**: Calls `AnalyticsService.recalculate(kpiName, context)`.
- **`write_audit`**: Calls `AuditService.log()` — additional audit entry beyond the service-level one.
- **`call_ai_agent`**: Creates an `ai_requests` record for async processing; does NOT block the rule chain.

### 8.4 Error Handling

- A failed action logs an error in `rule_execution_logs.error_message` with `result = 'failed'`.
- A failed action does NOT roll back prior actions in the same rule.
- A failed action does NOT block remaining rules in the evaluation chain.
- Failed AI agent calls are retried up to 3 times with exponential backoff by the AI service layer.
- Persistent failures surface as a system alert visible only to `admin` role.

---

## 9. Implementation: `BusinessRuleEngine.ts`

```typescript
// services/BusinessRuleEngine.ts

export interface BREContext {
  event: string;
  sourceRecordType: string;
  sourceRecordId: string;
  companyId: string;
  siteId?: string;
  context: Record<string, unknown>; // the source record fields available for condition evaluation
}

export interface BREResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  actionsExecuted: string[];
  error?: string;
}

export class BusinessRuleEngine {
  async evaluate(ctx: BREContext): Promise<BREResult[]> {
    const rules = await this.loadRules(ctx.companyId, ctx.event);
    const results: BREResult[] = [];

    for (const rule of rules) {
      const matched = this.evaluateConditions(rule.conditions, ctx.context);

      if (matched) {
        const actionsExecuted = await this.executeActions(rule.actions, ctx);
        results.push({ ruleId: rule.id, ruleName: rule.rule_name, matched: true, actionsExecuted });
      } else {
        results.push({
          ruleId: rule.id,
          ruleName: rule.rule_name,
          matched: false,
          actionsExecuted: [],
        });
      }

      await this.logExecution(rule, ctx, matched, results.at(-1));
    }

    return results;
  }

  private evaluateConditions(group: RuleConditionGroup, context: Record<string, unknown>): boolean {
    const results = group.conditions.map((c) =>
      'logic' in c ? this.evaluateConditions(c, context) : this.evaluatePrimitive(c, context),
    );
    return group.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
  }

  private evaluatePrimitive(condition: RuleCondition, context: Record<string, unknown>): boolean {
    const value = this.resolveField(condition.field, context);
    return this.compare(value, condition.operator, condition.value);
  }

  private resolveField(field: string, context: Record<string, unknown>): unknown {
    // field format: "record_type.field_name" — strip the record_type prefix
    const key = field.includes('.') ? field.split('.').slice(1).join('.') : field;
    return context[key] ?? null;
  }

  private compare(actual: unknown, operator: RuleOperator, expected: ConditionValue): boolean {
    if (operator === 'is_null') return actual === null || actual === undefined;
    if (operator === 'is_not_null') return actual !== null && actual !== undefined;
    if (operator === '==') return actual === expected;
    if (operator === '!=') return actual !== expected;
    if (operator === '>' && typeof actual === 'number' && typeof expected === 'number')
      return actual > expected;
    if (operator === '>=' && typeof actual === 'number' && typeof expected === 'number')
      return actual >= expected;
    if (operator === '<' && typeof actual === 'number' && typeof expected === 'number')
      return actual < expected;
    if (operator === '<=' && typeof actual === 'number' && typeof expected === 'number')
      return actual <= expected;
    if (operator === 'in' && Array.isArray(expected)) return expected.includes(actual as string);
    if (operator === 'not_in' && Array.isArray(expected))
      return !expected.includes(actual as string);
    if (operator === 'within_days' && typeof expected === 'number' && actual instanceof Date) {
      const daysUntil = Math.ceil((actual.getTime() - Date.now()) / 86_400_000);
      return daysUntil >= 0 && daysUntil <= expected;
    }
    if (operator === 'past_days' && typeof expected === 'number' && actual instanceof Date) {
      const daysPast = Math.floor((Date.now() - actual.getTime()) / 86_400_000);
      return daysPast >= expected;
    }
    return false;
  }
}
```

---

## 10. Cron-Based Rule Evaluations

Some rules do not fire from user writes but from scheduled checks. These are handled by a Supabase Edge Function: `task-generator`.

| Cron Schedule | Action                                                                           |
| ------------- | -------------------------------------------------------------------------------- |
| Daily 02:00   | Check all regulatory documents → fire `regulatory_document.expiring` / `expired` |
| Daily 02:15   | Check all tasks past due date → fire `task.overdue`                              |
| Daily 02:30   | Check all visits for window breaches → fire `visit.out_of_window`                |
| Daily 03:00   | Recalculate chart priority scores for `chart_ready` charts                       |

---

## 11. Seed Rules (Default Rules for Every Company)

These rules are inserted via `supabase/seed/business_rules.sql` when a new company is provisioned.

### Rule: Chart Overdue — Create Critical Task

```jsonc
{
  "rule_name": "Chart Overdue - Critical Task",
  "rule_type": "task_creation",
  "priority": 10,
  "conditions": {
    "logic": "AND",
    "conditions": [
      { "field": "chart.days_pending", "operator": ">", "value": 7 },
      { "field": "chart.status", "operator": "==", "value": "chart_ready" },
    ],
  },
  "actions": [
    {
      "type": "create_task",
      "payload": {
        "title": "Chart overdue — entry required",
        "priority": "critical",
        "assigned_role": "data_entry",
        "due_date_offset_days": 1,
      },
    },
    {
      "type": "send_notification",
      "payload": {
        "notification_type": "chart_overdue",
        "recipient_role": "data_entry",
      },
    },
  ],
}
```

### Rule: Document Expiring in 30 Days

```jsonc
{
  "rule_name": "Regulatory Document Expiring — 30 Day Warning",
  "rule_type": "document_expiration",
  "priority": 20,
  "conditions": {
    "logic": "AND",
    "conditions": [
      { "field": "regulatory_document.expiration_date", "operator": "within_days", "value": 30 },
      { "field": "regulatory_document.status", "operator": "==", "value": "current" },
    ],
  },
  "actions": [
    {
      "type": "update_status",
      "payload": { "status_value": "expiring_soon" },
    },
    {
      "type": "send_notification",
      "payload": {
        "notification_type": "document_expiring",
        "recipient_role": "regulatory",
      },
    },
    {
      "type": "create_task",
      "payload": {
        "title": "Document expiring in 30 days — renewal required",
        "priority": "high",
        "assigned_role": "regulatory",
        "due_date_offset_days": 25,
      },
    },
  ],
}
```

### Rule: Visit Completed — Create Chart

```jsonc
{
  "rule_name": "Visit Completed - Create Chart",
  "rule_type": "task_creation",
  "priority": 5,
  "conditions": {
    "logic": "AND",
    "conditions": [{ "field": "visit.status", "operator": "==", "value": "completed" }],
  },
  "actions": [
    {
      "type": "create_task",
      "payload": {
        "title": "Visit completed — chart ready for entry",
        "priority": "high",
        "assigned_role": "data_entry",
        "due_date_offset_days": 3,
      },
    },
  ],
}
```

### Rule: Subject Randomized — Confirm Visit Schedule

Note: Visit generation itself is executed directly by `SubjectService`. A placeholder Baseline visit is created when the subject is created (from the approved visit template's `is_baseline` item), and the rest of the schedule is generated by `SubjectService.completeBaselineVisit` once the Baseline visit is completed (see `DATABASE_Part_03 §12`) — not at subject creation. This BRE rule fires on the `subject.status_changed` event when status transitions to `randomized`, and creates a CRC confirmation task to verify the generated schedule.

```jsonc
{
  "rule_name": "Subject Randomized - Confirm Visit Schedule",
  "rule_type": "task_creation",
  "priority": 1,
  "conditions": {
    "logic": "AND",
    "conditions": [{ "field": "subject.status", "operator": "==", "value": "randomized" }],
  },
  "actions": [
    {
      "type": "create_task",
      "payload": {
        "title": "Subject randomized — verify visit schedule is complete",
        "priority": "high",
        "assigned_role": "crc",
        "due_date_offset_days": 1,
      },
    },
  ],
}
```

---

## 12. Rule Builder UI (Sprint 9)

The admin UI for managing rules must:

1. Display all active and inactive rules for the company, filterable by `rule_type`.
2. Provide a condition builder with field selector, operator dropdown, and value input.
3. Provide an action builder with action type selector and dynamic payload fields.
4. Allow priority ordering via drag-and-drop.
5. Show `rule_execution_logs` for each rule (last 100 evaluations).
6. Allow enabling/disabling rules without deletion.
7. Require `manage_business_rules` permission to create, edit, or delete rules.

---

## 13. Security

- The BRE runs entirely server-side. It is never called from client code.
- Rules are loaded with a company-scoped query: `WHERE company_id = ctx.companyId AND active = true`.
- The BRE service uses the service role key only within Edge Functions. In the Next.js service layer, it uses the user's authenticated client — actions are still subject to the user's permissions.
- A rule cannot escalate a user's permissions beyond what they currently hold.
- All BRE-generated tasks, notifications, and AI requests are written with `company_id` and `site_id` inherited from the triggering context.

---

## 14. Integration Map

| Module               | BRE Calls After                              |
| -------------------- | -------------------------------------------- |
| SubjectService       | createSubject, updateStatus                  |
| VisitService         | completeVisit, rescheduleVisit               |
| ChartService         | createChart, updateChart, markEnteredInEDC   |
| RegulatoryService    | uploadDocument, archiveDocument              |
| TaskService          | createTask (for overdue check re-evaluation) |
| StudyService         | activateStudy                                |
| ClinicalIntelligence | approveAIResponse                            |
| Cron (Edge Function) | daily expiration, overdue, window checks     |

---

## 15. Cross-References

- Database schema: `docs/DATABASE_Part_05_Regulatory_Files_AI_Audit.md` §14–15
- AI action integration: `docs/AI_PROVIDER_ARCHITECTURE.md`
- Notification action: `docs/NOTIFICATIONS.md`
- Gap resolved: GAP-BL-01 (`docs/GAP_ANALYSIS.md`)
- Implemented in Sprint: Sprint 9 (`docs/DEVELOPMENT_PLAN.md`)
