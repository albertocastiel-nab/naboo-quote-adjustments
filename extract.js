// Vercel serverless function — reconciles a Naboo quote vs a supplier invoice using Claude.
// Holds the API key server-side (env var ANTHROPIC_API_KEY). The browser never sees it.
// Cost strategy: cheap model (Haiku) does every extraction; escalate to Sonnet ONLY when the
// amounts don't match or a value is missing, to confirm a discrepancy before reporting it.

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

function buildPrompt(quoteText, invoiceText) {
  return `You reconcile a Naboo client quote (devis) against a supplier invoice (facture).
Naboo is a transparent intermediary: the quote can bundle one or more SUPPLIERS plus Naboo's own line called "Frais de service" / "Venue finding" (that is Naboo's margin, NOT a supplier).

From the two documents below:
1. Identify the SUPPLIER that issued the INVOICE (the company name on the facture, e.g. the hotel).
2. Read the INVOICE grand total in euros TTC (tax included).
3. In the QUOTE, find the subtotal in euros TTC for THAT SAME supplier. Use the per-supplier subtotal, NOT the global "Total séjour" total, and EXCLUDE Naboo "Frais de service".
Numbers may use French (1 234,56) or US (1,234.56 / 1 234.56) formats — normalise to a plain number like 4768.62.

Return ONLY strict minified JSON, no prose:
{"supplier": string|null, "invoiceTTC": number|null, "quoteSupplierTTC": number|null, "note": string}
"note" = one short sentence in the language of the documents explaining what you matched (or why a value is null).

=== QUOTE (devis) ===
${quoteText}

=== INVOICE (facture) ===
${invoiceText}`;
}

async function callModel(model, key, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) { const detail = await r.text(); const e = new Error('LLM_ERROR'); e.detail = detail.slice(0, 500); e.status = r.status; throw e; }
  const data = await r.json();
  let txt = (data.content && data.content[0] && data.content[0].text || '').trim();
  txt = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(txt); } catch (e) { const m = txt.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
  if (!parsed) { const e = new Error('BAD_JSON'); e.detail = txt.slice(0, 300); throw e; }
  return parsed;
}

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'NO_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel env vars.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const quoteText = (body && body.quoteText || '').slice(0, 60000);
  const invoiceText = (body && body.invoiceText || '').slice(0, 60000);
  if (!quoteText || !invoiceText) { res.status(400).json({ error: 'MISSING_TEXT' }); return; }

  const prompt = buildPrompt(quoteText, invoiceText);

  try {
    // 1) Cheap pass
    let out = await callModel(HAIKU, key, prompt);
    let usedModel = 'haiku';
    const inv = num(out.invoiceTTC), q = num(out.quoteSupplierTTC);
    const matches = inv != null && q != null && Math.abs(inv - q) < 0.01;

    // 2) Escalate to verify a discrepancy / missing value
    if (!matches) {
      try { out = await callModel(SONNET, key, prompt); usedModel = 'sonnet'; }
      catch (e) { /* keep Haiku result if Sonnet fails */ }
    }
    out.model = usedModel;
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: e.message || 'SERVER', detail: e.detail || null, status: e.status || null });
  }
}
