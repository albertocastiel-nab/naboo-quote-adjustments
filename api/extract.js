// Vercel serverless function — reconciles a Naboo quote vs a supplier invoice using Claude.
// Key stays server-side (env var). A single Sonnet call does the extraction: it is both more accurate
// on complex invoices AND faster end-to-end than the old Haiku→Sonnet escalation (one call, not two),
// which was tipping over Vercel's function timeout and returning intermittent 502s.

// Raise the function timeout (Vercel reads this export). Hobby allows up to 60s.
export const config = { maxDuration: 60 };

const SONNET = 'claude-sonnet-4-6';

function buildPrompt(quoteText, invoiceText, lang) {
  const L = lang === 'fr' ? 'French' : 'English';
  return `You reconcile a Naboo client quote (devis) against a supplier invoice (facture).
CRITICAL OUTPUT RULE: return your result ONLY by calling the report_reconciliation tool with the fields below. Do ALL line-by-line reasoning SILENTLY — do not write any prose, markdown, or tables.
Write the "note" field AND every toAdd/toRemove "desc" in ${L}, regardless of the documents' language. Use plain numbers only — do not write the tax abbreviations "HT" or "TTC" inside desc/note text.
Naboo is a transparent intermediary: the quote can bundle one or more SUPPLIERS plus Naboo's own line called "Frais de service" / "Venue finding" (Naboo's margin, NOT a supplier).

Extract, as STRICT minified JSON (no prose around it):
{
 "supplier": string|null,            // company that issued the INVOICE (the hotel/venue)
 "invoiceTotalHT": number|null,      // FULL invoice total excl. VAT (HT), before any deposit deducted
 "quoteSupplierHT": number|null,     // in the QUOTE, the per-supplier subtotal HT (excl. VAT) for that same supplier. NOT the global total. Exclude Naboo "Frais de service".
 "invoiceTTC": number|null,          // FULL gross invoice total TTC (incl. VAT), before any deposit deducted. If only a balance is shown after a deposit, set = net + deposit.
 "quoteSupplierTTC": number|null,    // the per-supplier subtotal TTC (incl. VAT) in the quote.
 "invoiceAcompte": number|null,      // deposit already paid on the invoice TTC (positive number), else null
 "invoiceNet": number|null,          // net / balance still to pay TTC, else null
 "acompteRef": {"numero": string|null, "montantTTC": number|null, "statut": "payé"|"non payé"|null} | null,  // referenced deposit invoice, if any
 "invoiceTotalTVA": number|null,     // invoice total VAT (full), else null
 "vatDetail": [{"rate": number, "base": number, "amount": number}],  // the invoice VAT breakdown table; [] if none
 "toAdd": [{"desc": string, "ht": number, "ttc": number}],     // changes to ADD to the Naboo quote (services on the invoice but missing/higher than the quote)
 "toRemove": [{"desc": string, "ht": number, "ttc": number}],  // changes to REMOVE from the Naboo quote (in the quote but not on/lower on the invoice)
 "note": string                      // one short sentence explaining the gap, in the requested UI language
}
Rules: amounts in euros, decimals with a dot (e.g. 4768.62). French (1 234,56) or US (1,234.56) inputs both normalise to a plain number. NEVER invent a figure that is absent from the document — use null. Fill invoiceAcompte AND invoiceNet whenever a deposit is deducted.
Commission: supplier invoices never mention Naboo's commission. Ignore commission entirely — compare the supplier invoice total against the quote total as-is.
Finding the amounts (try hard before returning null — fill BOTH the HT and TTC values for each side):
- Quote (quoteSupplierHT / quoteSupplierTTC): if the quote shows an explicit per-supplier subtotal, use it. If the quote has only ONE supplier or no per-supplier breakdown, use the quote's grand total, excluding any Naboo "Frais de service" / "Venue finding" line. Return null only if the quote has no total at all.
- Invoice (invoiceTotalHT / invoiceTTC): if no single grand total is clearly labelled, use the largest total shown on the invoice (reconstructing net + deposit if needed). HT usually appears in the VAT breakdown table or a "Total HT" line.
ITEMISING THE DIFFERENCES (the most important content — reason through these steps SILENTLY in your head; do NOT write them out; only the resulting toAdd/toRemove arrays go in the JSON):
STEP A — Extract the INVOICE line items. For each line capture: date (if the invoice is laid out by day), description, quantity, unit price HT, line total HT, line total TTC, and the line's VAT rate if the document states it.
STEP B — Extract the QUOTE line items for this supplier the same way (description, quantity, unit price, totals).
STEP C — Match invoice lines to quote lines by service/description (and by day where relevant), then classify EVERY difference:
   - QUANTITY / participant change on a matched line → ONE adjustment. Amount = (invoice qty − quote qty) × unit price HT. E.g. quote 125 pax @ X, invoice 120 pax @ X → "Participants — 125→120 (−5)".
   - UNIT-PRICE change on a matched line → an adjustment for the per-unit delta × quantity.
   - A line ON THE INVOICE but NOT in the quote (added apéritif, extra coffee break, taxe de séjour, an added day, a new activity…) → toAdd, naming the service.
   - A line IN THE QUOTE but NOT on the invoice → toRemove, naming the service.
STEP D — For EACH adjustment output: desc (name the specific service AND the concrete change), ht (excl-VAT amount), ttc (incl-VAT amount). Derive ttc from ht using that line's VAT rate ONLY when the rate is stated on the document; if the rate is not stated, leave ttc null rather than guessing a rate.
The HT amounts MUST net to the gap: sum(toAdd.ht) − sum(toRemove.ht) = (invoiceTotalHT − quoteSupplierHT). If they don't tie out, re-examine your line matching — do NOT pad with a vague catch-all unless the documents genuinely lack line detail.
Each desc must NAME the specific service/line AND the concrete adjustment. Good: "Apéritif dînatoire — added (not in quote)", "Coffee break — +5 participants", "Dîner gala — 125→120 covers (−5)", "Extra day (Mon 17 Aug) — added". Bad: "supplement", "difference", "extra".
If totals already match, return [] and []. Only if the documents genuinely do not expose line detail, return a single net item: toAdd:[{"desc":"Higher than quoted — see invoice detail","ht": <HT gap>, "ttc": <TTC gap>}]. Never invent line amounts unsupported by the documents.

=== QUOTE (devis) ===
${quoteText}

=== INVOICE (facture) ===
${invoiceText}`;
}

// Forced tool use guarantees a structured object back — the model cannot emit prose/markdown,
// which is what was breaking JSON.parse before.
const itemSchema = { type: 'object', properties: { desc: { type: 'string' }, ht: { type: ['number', 'null'] }, ttc: { type: ['number', 'null'] } }, required: ['desc'] };
const RESULT_TOOL = {
  name: 'report_reconciliation',
  description: 'Return the quote-vs-invoice reconciliation as structured data.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: ['string', 'null'] },
      invoiceTotalHT: { type: ['number', 'null'] },
      quoteSupplierHT: { type: ['number', 'null'] },
      invoiceTTC: { type: ['number', 'null'] },
      quoteSupplierTTC: { type: ['number', 'null'] },
      invoiceAcompte: { type: ['number', 'null'] },
      invoiceNet: { type: ['number', 'null'] },
      acompteRef: { type: ['object', 'null'] },
      invoiceTotalTVA: { type: ['number', 'null'] },
      vatDetail: { type: 'array' },
      toAdd: { type: 'array', items: itemSchema },
      toRemove: { type: 'array', items: itemSchema },
      note: { type: 'string' }
    },
    required: ['toAdd', 'toRemove']
  }
};

async function callModel(model, key, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 4000, temperature: 0,
      tools: [RESULT_TOOL],
      tool_choice: { type: 'tool', name: 'report_reconciliation' },
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) { const detail = await r.text(); const e = new Error('LLM_ERROR'); e.detail = detail.slice(0, 500); e.status = r.status; throw e; }
  const data = await r.json();
  const block = (data.content || []).find(c => c.type === 'tool_use');
  if (!block || !block.input || typeof block.input !== 'object') {
    const e = new Error('BAD_JSON'); e.detail = JSON.stringify(data).slice(0, 300); throw e;
  }
  return block.input;
}

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Deterministic, TOLERANT validation — only checks values that are actually present.
// Returns an array of human-readable warnings (does NOT block).
function validate(o) {
  const w = [];
  const close = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.005);
  const vd = Array.isArray(o.vatDetail) ? o.vatDetail : [];
  const haveVd = vd.length > 0;
  const sumBase = vd.reduce((s, x) => s + (num(x.base) || 0), 0);
  const sumAmt = vd.reduce((s, x) => s + (num(x.amount) || 0), 0);
  const recTTC = vd.reduce((s, x) => s + (num(x.base) || 0) * (1 + (num(x.rate) || 0) / 100), 0);

  if (haveVd && num(o.invoiceTotalHT) != null && !close(sumBase, o.invoiceTotalHT))
    w.push(`VAT bases sum (${r2(sumBase)}) ≠ declared HT (${o.invoiceTotalHT})`);
  if (haveVd && num(o.invoiceTTC) != null && !close(sumBase + sumAmt, o.invoiceTTC))
    w.push(`VAT table total (${r2(sumBase + sumAmt)}) ≠ invoice TTC (${o.invoiceTTC})`);
  if (haveVd && num(o.invoiceTTC) != null && !close(recTTC, o.invoiceTTC))
    w.push(`Recomputed TTC (${r2(recTTC)}) ≠ invoice TTC (${o.invoiceTTC})`);
  // NOTE: deposit+balance is intentionally NOT checked against full TTC — a deposit is often taken on the
  // original quote, so it legitimately differs from a later, revised invoice total.
  if (o.acompteRef && num(o.acompteRef.montantTTC) != null && num(o.invoiceAcompte) != null && !close(o.acompteRef.montantTTC, o.invoiceAcompte))
    w.push(`Deposit deducted (${o.invoiceAcompte}) ≠ referenced deposit invoice (${o.acompteRef.montantTTC})`);
  return w;
}

const sumHT = arr => Array.isArray(arr) ? arr.reduce((s, x) => s + (num(x.ht) || 0), 0) : 0;
const sumTTC = arr => Array.isArray(arr) ? arr.reduce((s, x) => s + (num(x.ttc) || 0), 0) : 0;

// Does the add/remove breakdown reconcile to the HT gap?
function reconcileCheck(o) {
  if (num(o.invoiceTotalHT) == null || num(o.quoteSupplierHT) == null) return { ok: true, gap: null };
  const gap = o.invoiceTotalHT - o.quoteSupplierHT;
  const net = sumHT(o.toAdd) - sumHT(o.toRemove);
  const ok = Math.abs(net - gap) <= Math.max(0.02, Math.abs(gap) * 0.005);
  return { ok, gap };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_OPS || process.env.ANTHROPIC_KEY;
  if (!key) { res.status(500).json({ error: 'NO_KEY', message: 'ANTHROPIC_API_KEY is not set in Vercel env vars.' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const quoteText = (body && body.quoteText || '').slice(0, 60000);
  const invoiceText = (body && body.invoiceText || '').slice(0, 60000);
  const lang = (body && body.lang) === 'fr' ? 'fr' : 'en';
  if (!quoteText || !invoiceText) { res.status(400).json({ error: 'MISSING_TEXT' }); return; }

  const prompt = buildPrompt(quoteText, invoiceText, lang);

  try {
    // Single Sonnet pass — best accuracy on complex invoices, one round-trip (avoids the timeout).
    let out = await callModel(SONNET, key, prompt);
    let usedModel = 'sonnet';
    let warnings = validate(out);

    // Guardrail: the displayed add/remove MUST reconcile to the gap. Rather than discard the
    //    itemisation the model found, KEEP the identified items and append a balancing residual line so
    //    the totals always tie out. Only fall back to a pure net line if the model found nothing useful.
    if (!Array.isArray(out.toAdd)) out.toAdd = [];
    if (!Array.isArray(out.toRemove)) out.toRemove = [];
    const recon = reconcileCheck(out);
    if (!recon.ok && recon.gap != null) {
      const haveItems = out.toAdd.length + out.toRemove.length > 0;
      const residualHT = r2(recon.gap - (sumHT(out.toAdd) - sumHT(out.toRemove)));
      const gapTTC = (num(out.invoiceTTC) != null && num(out.quoteSupplierTTC) != null) ? out.invoiceTTC - out.quoteSupplierTTC : null;
      const residualTTC = gapTTC != null ? r2(gapTTC - (sumTTC(out.toAdd) - sumTTC(out.toRemove))) : residualHT;
      const label = haveItems ? 'Other differences — not itemised, check the invoice detail'
                              : 'Higher/lower than quoted — see invoice detail';
      if (residualHT > 0.01) out.toAdd.push({ desc: label, ht: residualHT, ttc: residualTTC });
      else if (residualHT < -0.01) out.toRemove.push({ desc: label, ht: r2(-residualHT), ttc: r2(-residualTTC) });
      warnings.push(haveItems
        ? `Itemisation didn't fully tie out — added a balancing line of ${residualHT} € (excl. VAT). Check the invoice detail.`
        : `Could not itemise the difference — showing the net adjustment only.`);
    }

    out.model = usedModel;
    out.warnings = warnings;
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: e.message || 'SERVER', detail: e.detail || null, status: e.status || null });
  }
}
