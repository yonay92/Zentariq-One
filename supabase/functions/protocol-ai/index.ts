// Supabase Edge Function: protocol-ai
// Receives { file_id, study_id } OR { file_id, draft_id } (exactly one of study_id/draft_id).
// Loads the protocol PDF from the `protocols` storage bucket, calls Claude (claude-sonnet-4-6)
// with the Protocol Agent prompt (docs/CI_02_Protocol_Agent.md), and writes the extraction
// result to the caller's chosen destination:
//   - study_id: amendment to an existing study — one `study_ai_extractions` row per
//     extraction type, approved=false, reviewed via StudyService.approveAIExtraction().
//   - draft_id: new-study-from-protocol flow — a single `study_drafts` row is updated with
//     the extraction result for human review on the guided review page; no study exists yet.
// Never activates anything automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLAUDE_MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are the Zentariq One Protocol Agent.

Goal: convert a clinical trial study protocol into a draft Zentariq One study.

Inputs: a protocol PDF (and, if provided, amendments or supporting manuals).

Rules:
- Never activate anything automatically — your output is always a draft for human review.
- For every field below, output it only if you are highly confident of the value as stated in
  the document. If you are not highly confident, output null — never fabricate, guess, or
  infer a value that is not clearly supported by the text.
- List every field you left null in "uncertain_fields", each with a short reason (e.g.
  "cro — not mentioned in the document").
- Always produce a confidence score (0.0-1.0) for the extraction as a whole.
- If the protocol contains a Schedule of Assessments or Visit Schedule table, identify each
  visit and populate "visit_template.items". Mark exactly one visit as "is_baseline": true at
  "offset_days": 0 if a baseline/screening visit is identifiable; otherwise set "is_baseline"
  false on every item. If no such schedule is found, return an empty items array.

Respond with a single JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "confidence": 0.0,
  "uncertain_fields": ["field_name — reason", ...],
  "study_profile": {
    "study_name": null,
    "protocol_number": null,
    "protocol_version": null,
    "sponsor": null,
    "cro": null,
    "phase": null,
    "therapeutic_area": null,
    "indication": null,
    "estimated_enrollment": null,
    "study_duration": null,
    "study_design": null,
    "primary_endpoint": null,
    "start_date": null,
    "end_date": null
  },
  "visit_template": {
    "items": [
      { "visit_name": "", "visit_order": 1, "offset_days": 0, "window_before": 0, "window_after": 0, "visit_type": "scheduled", "is_required": true, "is_baseline": false, "notes": "" }
    ]
  },
  "inclusion_criteria": ["..."],
  "exclusion_criteria": ["..."],
  "schedule_of_assessments": { "assessments": [] },
  "required_documents": ["Protocol", "ICF", "Investigator Brochure"]
}`;

type ExtractionPayload = {
  confidence: number;
  uncertain_fields: string[];
  study_profile: Record<string, unknown>;
  visit_template: { items: unknown[] };
  inclusion_criteria: unknown[];
  exclusion_criteria: unknown[];
  schedule_of_assessments: Record<string, unknown>;
  required_documents: unknown[];
};

Deno.serve(async (req: Request) => {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({ error: 'Missing Supabase credentials' }, 500);
    }
    if (!anthropicApiKey) {
      return jsonResponse({ error: 'Missing ANTHROPIC_API_KEY' }, 500);
    }

    const { file_id, study_id, draft_id } = (await req.json().catch(() => ({}))) as {
      file_id?: string;
      study_id?: string;
      draft_id?: string;
    };

    if (!file_id || (!study_id && !draft_id) || (study_id && draft_id)) {
      return jsonResponse(
        { error: 'file_id and exactly one of study_id or draft_id are required' },
        400,
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    try {
      const { data: fileRow, error: fileError } = await supabase
        .from('files')
        .select('id, company_id, storage_path, mime_type')
        .eq('id', file_id)
        .single();

      if (fileError || !fileRow) {
        return jsonResponse({ error: 'File not found' }, 404);
      }

      const { data: pdfBlob, error: downloadError } = await supabase.storage
        .from('protocols')
        .download(fileRow.storage_path);

      if (downloadError || !pdfBlob) {
        return jsonResponse({ error: `Failed to download file: ${downloadError?.message}` }, 500);
      }

      const pdfBase64 = arrayBufferToBase64(await pdfBlob.arrayBuffer());

      const extraction = await callProtocolAgent(pdfBase64, anthropicApiKey);

      if (draft_id) {
        const { error: draftError } = await supabase
          .from('study_drafts')
          .update({
            status: 'ready',
            confidence: extraction.confidence,
            uncertain_fields: extraction.uncertain_fields,
            extracted_profile: extraction.study_profile,
            extracted_visit_items: extraction.visit_template.items,
            extracted_extra: {
              inclusion_criteria: extraction.inclusion_criteria,
              exclusion_criteria: extraction.exclusion_criteria,
              schedule_of_assessments: extraction.schedule_of_assessments,
              required_documents: extraction.required_documents,
            },
          })
          .eq('id', draft_id);

        if (draftError) {
          return jsonResponse(
            { error: `Failed to store draft extraction: ${draftError.message}` },
            500,
          );
        }

        await supabase.from('files').update({ ai_processed: true }).eq('id', file_id);

        return jsonResponse({
          draft_id,
          confidence: extraction.confidence,
          uncertain_fields: extraction.uncertain_fields,
        });
      }

      const companyId = fileRow.company_id as string;
      const rows = [
        {
          company_id: companyId,
          study_id,
          extraction_type: 'study_profile',
          confidence: extraction.confidence,
          extracted_data: {
            ...extraction.study_profile,
            uncertain_fields: extraction.uncertain_fields,
          },
          approved: false,
        },
        {
          company_id: companyId,
          study_id,
          extraction_type: 'visit_template',
          confidence: extraction.confidence,
          extracted_data: extraction.visit_template,
          approved: false,
        },
        {
          company_id: companyId,
          study_id,
          extraction_type: 'inclusion_criteria',
          confidence: extraction.confidence,
          extracted_data: { criteria: extraction.inclusion_criteria },
          approved: false,
        },
        {
          company_id: companyId,
          study_id,
          extraction_type: 'exclusion_criteria',
          confidence: extraction.confidence,
          extracted_data: { criteria: extraction.exclusion_criteria },
          approved: false,
        },
        {
          company_id: companyId,
          study_id,
          extraction_type: 'schedule_of_assessments',
          confidence: extraction.confidence,
          extracted_data: extraction.schedule_of_assessments,
          approved: false,
        },
      ];

      const { data: inserted, error: insertError } = await supabase
        .from('study_ai_extractions')
        .insert(rows)
        .select('id, extraction_type');

      if (insertError || !inserted) {
        return jsonResponse({ error: `Failed to store extraction: ${insertError?.message}` }, 500);
      }

      await supabase.from('files').update({ ai_processed: true }).eq('id', file_id);

      const primary = (inserted as Array<{ id: string; extraction_type: string }>).find(
        (r) => r.extraction_type === 'study_profile',
      );

      return jsonResponse({
        extraction_id: primary?.id ?? inserted[0]?.id ?? null,
        uncertain_fields: extraction.uncertain_fields,
        confidence: extraction.confidence,
      });
    } catch (innerErr) {
      const message = innerErr instanceof Error ? innerErr.message : String(innerErr);
      if (draft_id) {
        await supabase
          .from('study_drafts')
          .update({ status: 'failed', error_message: message })
          .eq('id', draft_id);
      }
      throw innerErr;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[protocol-ai] unexpected error:', message);
    return jsonResponse({ error: message }, 500);
  }
});

async function callProtocolAgent(pdfBase64: string, apiKey: string): Promise<ExtractionPayload> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            {
              type: 'text',
              text: 'Extract the structured study data as JSON exactly per the schema in the system prompt.',
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content.find((c) => c.type === 'text')?.text ?? '';

  return parseExtraction(text);
}

function parseExtraction(text: string): ExtractionPayload {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return lowConfidenceFallback('Model did not return parseable JSON');
  }
  try {
    const parsed = JSON.parse(match[0]);
    return {
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      uncertain_fields: Array.isArray(parsed.uncertain_fields) ? parsed.uncertain_fields : [],
      study_profile: parsed.study_profile ?? {},
      visit_template: parsed.visit_template ?? { items: [] },
      inclusion_criteria: parsed.inclusion_criteria ?? [],
      exclusion_criteria: parsed.exclusion_criteria ?? [],
      schedule_of_assessments: parsed.schedule_of_assessments ?? {},
      required_documents: parsed.required_documents ?? [],
    };
  } catch {
    return lowConfidenceFallback('Failed to parse model JSON output');
  }
}

function lowConfidenceFallback(reason: string): ExtractionPayload {
  return {
    confidence: 0,
    uncertain_fields: ['all — ' + reason],
    study_profile: {},
    visit_template: { items: [] },
    inclusion_criteria: [],
    exclusion_criteria: [],
    schedule_of_assessments: {},
    required_documents: [],
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
