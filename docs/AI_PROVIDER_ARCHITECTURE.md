# AI_PROVIDER_ARCHITECTURE.md

# Zentariq One — AI Provider Architecture Specification

Version: 1.0
Status: Production-Ready — Required before Sprint 10

---

## 1. Purpose

This document defines the concrete AI provider implementation for Zentariq One. It resolves **GAP-AI-01** and **GAP-AI-02** from GAP_ANALYSIS.md: the provider abstraction interface, model selection, request/response lifecycle, error handling, cost tracking, and the integration contract that all Clinical Intelligence agents must follow.

---

## 2. Core Principles

1. All AI interactions flow through a single `AIProviderClient` — no agent calls an AI API directly.
2. The default provider is **Anthropic Claude** (`claude-sonnet-4-6`).
3. The client is provider-agnostic by interface — a future provider (OpenAI, Gemini) can be swapped in without changing agent code.
4. Every request is logged in `ai_requests` before the API call is made.
5. Every response is stored in `ai_responses` regardless of outcome.
6. AI never writes production records directly — all output is stored as `requires_review = true`.
7. All AI outputs must conform to a structured JSON schema defined per agent.
8. Token usage is logged on every request for cost tracking and budget enforcement.

---

## 3. Provider Configuration

### 3.1 Default Model

| Parameter      | Value                    |
| -------------- | ------------------------ |
| Provider       | Anthropic                |
| Model          | `claude-sonnet-4-6`      |
| Context window | 200,000 tokens           |
| Output format  | JSON (structured output) |
| Max output     | 8,096 tokens             |

### 3.2 Environment Variables

```bash
# Server-side only — never exposed to the frontend
ANTHROPIC_API_KEY=sk-ant-...

# Optional: override per-agent (set in company_settings.ai_config)
AI_DEFAULT_MODEL=claude-sonnet-4-6
AI_MAX_RETRIES=3
AI_REQUEST_TIMEOUT_MS=120000
```

### 3.3 Provider Abstraction Interface

```typescript
// lib/ai/AIProviderClient.ts

export interface AIInput {
  systemPrompt: string;
  userMessage: string;
  attachments?: AIAttachment[]; // for multimodal (PDFs, images)
  outputSchema: Record<string, unknown>; // JSON Schema — forces structured output
  maxTokens?: number;
  temperature?: number; // default 0 for clinical extraction, 0.3 for analysis
}

export interface AIAttachment {
  type: 'pdf' | 'image';
  data: Buffer; // binary content
  mediaType: string; // e.g., "application/pdf"
  name: string;
}

export interface AIOutput {
  data: Record<string, unknown>; // parsed JSON matching outputSchema
  confidence: number; // 0.0–1.0, computed by the agent or returned in output
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  latencyMs: number;
}

export interface AIProviderClient {
  analyze(input: AIInput, requestId: string): Promise<AIOutput>;
}
```

### 3.4 Anthropic Implementation

````typescript
// lib/ai/AnthropicClient.ts
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicClient implements AIProviderClient {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async analyze(input: AIInput, requestId: string): Promise<AIOutput> {
    const start = Date.now();

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: this.buildContent(input),
      },
    ];

    const response = await this.client.messages.create({
      model: process.env.AI_DEFAULT_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: input.maxTokens ?? 8096,
      temperature: input.temperature ?? 0,
      system: input.systemPrompt,
      messages,
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '{}';
    const data = this.parseJSON(text, requestId);

    return {
      data,
      confidence: data.confidence ?? 0.8,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      model: response.model,
      latencyMs: Date.now() - start,
    };
  }

  private buildContent(input: AIInput): Anthropic.ContentBlock[] {
    const content: Anthropic.ContentBlock[] = [];

    if (input.attachments) {
      for (const att of input.attachments) {
        if (att.type === 'pdf' || att.type === 'image') {
          content.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: att.mediaType as Anthropic.Base64PDFSource['media_type'],
              data: att.data.toString('base64'),
            },
          } as unknown as Anthropic.ContentBlock);
        }
      }
    }

    content.push({ type: 'text', text: input.userMessage });
    return content;
  }

  private parseJSON(text: string, requestId: string): Record<string, unknown> {
    try {
      const match = text.match(/```json\n?([\s\S]*?)\n?```/) ?? text.match(/(\{[\s\S]*\})/);
      return JSON.parse(match ? match[1] : text);
    } catch {
      return { parse_error: true, raw: text, request_id: requestId };
    }
  }
}
````

---

## 4. Request / Response Lifecycle

### 4.1 Full Sequence

```
Agent.analyze(input)
  1. Create ai_requests record (status = 'pending')
  2. Call AIProviderClient.analyze() with retry wrapper
  3. On success:
     a. Update ai_requests (status = 'completed', token counts, latency)
     b. Create ai_responses (output_data, confidence, requires_review = true)
     c. Return ai_responses.id to caller
  4. On failure after all retries:
     a. Update ai_requests (status = 'failed', error logged)
     b. Return error to caller — no ai_responses record created
```

### 4.2 Database Integration

```typescript
// services/ClinicalIntelligenceService.ts

async function runAgentRequest(
  agentKey: string,
  input: AIInput,
  ctx: RequestContext,
  sourceRecordType: string,
  sourceRecordId: string,
): Promise<string> {
  // returns ai_responses.id

  // 1. Log request
  const aiRequest = await db.ai_requests.insert({
    company_id: ctx.companyId,
    user_id: ctx.userId,
    agent_key: agentKey,
    input_type: sourceRecordType,
    input_data: { source_record_id: sourceRecordId, ...input },
    status: 'pending',
  });

  try {
    // 2. Call AI with retry
    const output = await withRetry(() => aiProviderClient.analyze(input, aiRequest.id));

    // 3. Update request
    await db.ai_requests.update(aiRequest.id, {
      status: 'completed',
      input_tokens: output.inputTokens,
      output_tokens: output.outputTokens,
      latency_ms: output.latencyMs,
    });

    // 4. Store response
    const aiResponse = await db.ai_responses.insert({
      company_id: ctx.companyId,
      ai_request_id: aiRequest.id,
      output_data: output.data,
      confidence: output.confidence,
      requires_review: true,
      approved_by: null,
      approved_at: null,
      rejected_by: null,
      rejected_at: null,
    });

    // 5. Audit
    await auditService.log({
      action: 'ai_request.completed',
      module: 'clinical_intelligence',
      record_type: 'ai_requests',
      record_id: aiRequest.id,
      ctx,
    });

    return aiResponse.id;
  } catch (error) {
    await db.ai_requests.update(aiRequest.id, { status: 'failed' });
    await auditService.log({ action: 'ai_request.failed', module: 'clinical_intelligence', ctx });
    throw error;
  }
}
```

---

## 5. Retry Strategy

```typescript
// lib/ai/withRetry.ts

export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === maxAttempts) break;
      await sleep(1000 * 2 ** (attempt - 1)); // 1s, 2s, 4s
    }
  }
  throw lastError;
}

function isTransient(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('529') || // Anthropic overloaded
      error.message.includes('500') ||
      error.message.includes('timeout') ||
      error.message.includes('ECONNRESET')
    );
  }
  return false;
}
```

---

## 6. Large Document Chunking (Resolves RISK-07 from ARCHITECT_REVIEW.md)

Protocol PDFs exceeding 100 pages must be chunked before processing.

### 6.1 Chunking Strategy

```typescript
// lib/ai/DocumentChunker.ts

export interface DocumentChunk {
  index: number;
  section: string; // e.g., "Schedule of Assessments", "Inclusion Criteria"
  content: Buffer;
  pageRange: string; // e.g., "1-20"
}

export function chunkProtocolPDF(pdf: Buffer, maxPagesPerChunk = 30): DocumentChunk[] {
  // Split by section headers detected via heuristics
  // Sections: "Schedule of Assessments", "Inclusion/Exclusion Criteria",
  //           "Study Procedures", "Statistical Methods", "Appendices"
  // If no section markers, split every maxPagesPerChunk pages
}
```

### 6.2 Chunk Merge

After processing all chunks, the Protocol Agent merges results:

```typescript
function mergeChunkResults(chunks: AgentOutput[]): AgentOutput {
  // Deduplicate extracted fields (prefer higher-confidence chunk for conflicts)
  // Concatenate visit schedules across chunks
  // Flag any field where chunk results conflict as confidence: 'low'
}
```

### 6.3 Processing Status

During chunked processing, `ai_requests.status` follows this progression:

| Status       | Meaning                                            |
| ------------ | -------------------------------------------------- |
| `pending`    | Request created, not yet started                   |
| `processing` | Chunks are being processed (partial results exist) |
| `completed`  | All chunks merged, `ai_responses` record created   |
| `failed`     | Unrecoverable error after all retries              |
| `partial`    | Some chunks succeeded, some failed — needs review  |

The UI polls `GET /api/ai/requests/:id/status` every 5 seconds and displays a progress indicator.

---

## 7. Output Schema Requirements (Per Agent)

Every agent must define its output schema as a JSON Schema object. The `AIProviderClient` passes this schema in the system prompt as a formatting instruction. The client enforces it by parsing and validating the response.

### 7.1 Base Output Fields (required in every agent output)

```typescript
interface BaseAgentOutput {
  confidence: number; // 0.0–1.0
  confidence_reason: string; // human-readable explanation
  warnings: string[]; // low-confidence fields or missing data
  extracted_at: string; // ISO 8601 timestamp
}
```

### 7.2 Protocol Agent Output (example)

```typescript
interface ProtocolAgentOutput extends BaseAgentOutput {
  study_title: string;
  protocol_number: string;
  study_phase: string;
  indication: string;
  primary_endpoint: string;
  secondary_endpoints: string[];
  inclusion_criteria: string[];
  exclusion_criteria: string[];
  visit_schedule: VisitScheduleItem[];
  randomization_ratio: string;
  blinding: string;
  sponsor: string;
}

interface VisitScheduleItem {
  visit_name: string;
  visit_code: string;
  day_offset: number;
  window_minus: number;
  window_plus: number;
  procedures: string[];
}
```

---

## 8. Token Budget Enforcement

Per **GAP-AI-01**, AI request costs are tracked and budgeted per company.

### 8.1 Schema additions to `ai_requests`

```sql
ALTER TABLE ai_requests
  ADD COLUMN input_tokens integer,
  ADD COLUMN output_tokens integer,
  ADD COLUMN latency_ms integer,
  ADD COLUMN model text;
```

### 8.2 `ai_budgets` table (new — add to migration 010)

```sql
ai_budgets
- id               uuid primary key default gen_random_uuid()
- company_id       uuid references companies(id)
- monthly_token_limit  bigint default 10000000   -- 10M tokens/month default
- current_month_tokens bigint default 0
- budget_period    text                           -- 'YYYY-MM' format
- alert_threshold  numeric default 0.8            -- alert at 80% usage
- hard_stop        boolean default false          -- if true, block new requests at limit
- created_at       timestamptz default now()
- updated_at       timestamptz default now()
```

### 8.3 Budget Check in Service Layer

```typescript
async function checkBudget(companyId: string, estimatedTokens: number): Promise<void> {
  const budget = await db.ai_budgets.findCurrentPeriod(companyId);
  if (!budget) return; // no limit configured

  const projected = budget.current_month_tokens + estimatedTokens;

  if (budget.hard_stop && projected > budget.monthly_token_limit) {
    throw new AIBudgetExceededError('Monthly AI token budget exceeded');
  }

  if (projected / budget.monthly_token_limit >= budget.alert_threshold) {
    await notificationService.dispatch({
      type: 'ai_budget_warning',
      recipientRole: 'admin',
      companyId,
    });
  }
}
```

---

## 9. OCR Strategy (Resolves GAP-AI-02)

For MVP, Claude's multimodal vision capability handles all document OCR. No external OCR provider is required.

| Document Type        | Processing Method                                     |
| -------------------- | ----------------------------------------------------- |
| Digital PDF (native) | Claude text extraction (no vision needed)             |
| Scanned PDF          | Claude vision (multimodal) — base64 encoded           |
| JPEG / PNG image     | Claude vision — base64 encoded                        |
| DOCX                 | Server-side: extract text via `mammoth`, pass as text |

For scanned documents, confidence scores below 0.7 trigger a UI warning: "This document was scanned and may have extraction errors. Please verify all fields."

**v1.5 evaluation:** If >20% of extracted regulatory documents have user-corrected fields (tracked via `ai_responses.corrections`), evaluate AWS Textract or Azure Form Recognizer for scanned-PDF-heavy workflows.

---

## 10. AI Response Approval Workflow

All `ai_responses` records start with `requires_review = true`. The approval flow is:

```
AI Response created (requires_review = true, approved_by = null)
  → UI surfaces in AIReviewPanel
  → User reviews each field
  → User approves: approved_by = user_id, approved_at = now()
  → OR User rejects: rejected_by = user_id, rejected_at = now()
  → OR User edits + approves: corrections stored in output_data, then approved

On approval:
  → BusinessRuleEngine.evaluate('ai_response.approved', ...)
  → AuditService.log('ai_response.approved', ...)
  → The calling module's service applies the approved data to production tables
```

### 10.1 Schema additions to `ai_responses`

```sql
ALTER TABLE ai_responses
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN rejected_by uuid references profiles(id),
  ADD COLUMN rejection_reason text;
```

---

## 11. Security

- `ANTHROPIC_API_KEY` is a server-side secret stored in Vercel environment variables. It is never passed to the browser or logged.
- All AI requests are scoped to the authenticated user's `company_id`. Context sent to Claude must be pre-filtered by company and site access before the API call.
- The AI may only receive data the requesting user is authorized to see (SECURITY.md §11).
- AI responses are stored encrypted at rest via Supabase's default AES-256 disk encryption.
- Every AI request and response is audit-logged regardless of outcome.

---

## 12. Agent Registry

Each agent is a separate TypeScript class in `services/ai/agents/`. All agents extend a shared `BaseAgent`:

```typescript
// services/ai/agents/BaseAgent.ts
abstract class BaseAgent {
  protected client: AIProviderClient;
  protected ciService: ClinicalIntelligenceService;

  abstract readonly agentKey: string;
  abstract readonly systemPrompt: string;
  abstract readonly outputSchema: Record<string, unknown>;

  async run(input: AgentInput, ctx: RequestContext): Promise<string> {
    return this.ciService.runAgentRequest(
      this.agentKey,
      this.buildAIInput(input),
      ctx,
      input.sourceRecordType,
      input.sourceRecordId,
    );
  }

  protected abstract buildAIInput(input: AgentInput): AIInput;
}
```

| Agent Class       | `agent_key`        | Primary Input              | Sprint |
| ----------------- | ------------------ | -------------------------- | ------ |
| `ProtocolAgent`   | `protocol_agent`   | Protocol PDF buffer        | 10     |
| `RegulatoryAgent` | `regulatory_agent` | Regulatory document buffer | 10     |
| `SubjectAgent`    | `subject_agent`    | Subject record + visits    | 10     |
| `DataAgent`       | `data_agent`       | Chart + visit data         | 10     |
| `AnalyticsAgent`  | `analytics_agent`  | KPI snapshot               | 10     |
| `ExecutiveAgent`  | `executive_agent`  | Multi-study summary        | 10     |
| `CopilotAgent`    | `copilot`          | User query + context       | 10     |

**Training Agent** is excluded from MVP per GAP-AI-03. The `training_agent` key must not be seeded in `ai_agents` for v1.0.

---

## 13. Cross-References

- Clinical Intelligence agents: `docs/CI_01_Architecture.md` through `CI_10_Prompt_Engineering.md`
- Business Rule Engine AI action: `docs/BUSINESS_RULE_ENGINE.md` §6 (`call_ai_agent`)
- Gaps resolved: GAP-AI-01, GAP-AI-02 (`docs/GAP_ANALYSIS.md`)
- Security requirements: `docs/SECURITY.md` §11
- Implemented in Sprint: Sprint 10 (`docs/DEVELOPMENT_PLAN.md`)
