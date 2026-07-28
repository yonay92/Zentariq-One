# FRONTEND_COMPONENTS.md

# Zentariq One Frontend Component Specification

Version: 1.0  
Project: Zentariq One  
Purpose: Define the reusable frontend component system for Zentariq One.

---

## 1. Component Philosophy

Zentariq One must use a reusable component library.

No page should create custom UI if a reusable component already exists.

The goal is:

- consistent design
- faster development
- easier maintenance
- predictable user experience
- accessibility
- scalability

All components should be written in:

- React
- TypeScript
- Tailwind CSS

---

## 2. Component Structure

Recommended folder structure:

```text
/components
  /ui
  /layout
  /forms
  /tables
  /feedback
  /navigation
  /clinical
  /analytics
  /ai
```

---

## 3. Core UI Components

### Button

Variants:

- primary
- secondary
- danger
- ghost
- outline
- icon

Props:

```ts
type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline' | 'icon';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  children: React.ReactNode;
};
```

---

### Card

Used for:

- KPI cards
- dashboard blocks
- study summaries
- subject summaries
- document summaries
- task summaries

Props:

```ts
type CardProps = {
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
};
```

---

### Badge

Used for status and category labels.

Variants:

- success
- warning
- danger
- info
- neutral

Examples:

- Active
- Completed
- Expired
- Critical
- Pending

---

### PriorityBadge

Priority levels:

- Critical
- High
- Medium
- Low

Color rules:

- Critical = red
- High = orange
- Medium = amber
- Low = green

---

### StatusBadge

Used across modules.

Status types:

- Study Status
- Subject Status
- Visit Status
- Chart Status
- Task Status
- Document Status

---

## 4. Form Components

### TextInput

Used for normal text entry.

### SelectInput

Used for role, site, study, status and type selections.

### DateInput

Used for dates.

### DateTimeInput

Used for calendar events and timestamps.

### SearchInput

Used in lists, filters and global search.

### TextArea

Used for notes and comments.

### FileUpload

Used for protocol, regulatory documents and subject documents.

Requirements:

- drag and drop
- progress indicator
- file validation
- secure upload
- AI processing indicator when applicable

---

## 5. Table Components

### DataTable

Reusable table component for all modules.

Required features:

- sorting
- filtering
- pagination
- row actions
- loading state
- empty state
- responsive behavior

Used in:

- Studies
- Subjects
- Visits
- Charts
- Regulatory Documents
- Tasks
- Users
- Sites

---

### FilterBar

Used above tables.

Common filters:

- Site
- Study
- Status
- Date range
- User
- Priority

---

### TableActionMenu

Three-dot menu per row.

Actions may include:

- View
- Edit
- Archive
- Add Note
- View History

---

## 6. Navigation Components

### Sidebar

Main modules:

- Dashboard
- Task Center
- Calendar
- Studies
- Subjects
- Charts
- Regulatory
- Analytics
- Clinical Intelligence
- Settings

Rules:

- Collapse on smaller screens.
- Highlight active module.
- Respect permissions.

---

### TopBar

Contains:

- Universal Search
- Current Site selector
- Notifications
- User menu
- Quick Create button

---

### Breadcrumbs

Used on detail pages.

Example:

```text
Studies > Currax > Subject 101-005
```

---

### CommandPalette

Shortcut:

```text
Ctrl + K
```

Actions:

- Create Subject
- Create Study
- Upload Protocol
- Upload Document
- Open Today's Tasks
- Search Subject
- Open Calendar

---

## 7. Layout Components

### AppShell

Global layout.

Contains:

- Sidebar
- TopBar
- Workspace
- StatusBar

---

### PageHeader

Used on every page.

Includes:

- title
- subtitle
- primary action
- secondary actions

---

### DetailPageLayout

Used for record profiles.

Includes:

- header
- status summary
- tabs
- content area

---

### Drawer

Used for quick views and edits.

Examples:

- Task detail
- Chart detail
- Document preview
- AI suggestion review

---

### Modal

Used for confirmation and focused actions.

Examples:

- Delete confirmation
- Approve AI extraction
- Archive document
- Close study

---

## 8. Clinical Components

### SubjectProfileHeader

Displays:

- Subject Number
- Study
- Site
- Status
- Next Visit
- Key Actions

---

### StudyProfileHeader

Displays:

- Study Name
- Protocol Number
- Sponsor
- Status
- Sites
- Health Score

---

### VisitCard

Displays:

- Visit Name
- Target Date
- Scheduled Date
- Window
- Status
- Quick Actions

---

### ChartQueueItem

Displays:

- Priority
- Study
- Subject
- Visit
- Days Pending
- Site
- Status

---

### RegulatoryDocumentCard

Displays:

- Document Name
- Type
- Version
- Expiration
- Status
- AI Metadata status

---

### TaskCard

Displays:

- Title
- Priority
- Due Date
- Site
- Study
- Source Module
- Quick Actions

---

## 9. Analytics Components

### MetricCard

Used for KPIs.

Properties:

- label
- value
- trend
- status
- click action

Rule:

Every MetricCard should be clickable when possible.

---

### ChartWidget

Used for:

- productivity trends
- chart completion
- visit volume
- document health
- site comparison

---

### ReportTable

Used for exportable reports.

Features:

- filters
- export
- saved views

---

## 10. AI Components

### CopilotPanel

Persistent AI assistant panel.

Features:

- chat
- context-aware responses
- suggested actions
- source references

---

### AISuggestionCard

Displays proactive AI recommendations.

Includes:

- suggestion
- confidence score
- source
- approve button
- dismiss button

---

### AIReviewPanel

Used before accepting AI-extracted data.

Shows:

- extracted fields
- confidence
- source text
- approve/correct/reject actions

---

## 11. Feedback Components

### Toast

Used for success/error notifications.

### AlertBanner

Used for page-level warnings.

### EmptyState

Used when lists are empty.

### LoadingSpinner

Used for async loading.

### SkeletonLoader

Used for dashboards and tables.

### ConfirmationDialog

Used before irreversible actions.

---

## 12. Accessibility Rules

All components must support:

- keyboard navigation
- visible focus states
- accessible labels
- semantic HTML
- screen reader compatibility

---

## 13. Design Rules

- Do not use unnecessary colors.
- Use red only for critical issues.
- Use amber for warnings.
- Use green for success.
- Avoid clutter.
- Tables must be readable.
- Dashboards must be actionable.
- Components must be responsive.

---

## 14. Implementation Rules for Claude

Claude must:

- Build reusable components first.
- Use components across all modules.
- Avoid duplicated UI patterns.
- Use TypeScript props.
- Keep components small and composable.
- Prefer server components where appropriate.
- Keep business logic outside UI components.
- Use permission-aware rendering.
- Use loading and error states consistently.

---

## 15. Final Rule

The frontend must feel like a modern enterprise SaaS product, not like a traditional CTMS.

The user should always know:

- what needs attention
- what action to take next
- where they are
- how to complete the task quickly
