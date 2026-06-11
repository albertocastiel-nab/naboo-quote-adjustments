// Vercel serverless function — reconciles a Naboo quote vs a supplier invoice using Claude.
// Key stays server-side (env var). Cheap model (Haiku) does every extraction; escalate to Sonnet
// only when the amounts don't match OR the LLM output fails an internal consistency check.

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

function buildPrompt(quoteText, invoiceText) {
  return `You reconcile a Naboo client quote (devis) against a supplier invoice (facture).
Naboo is a transparent intermediary: the quote can bundle one or more SUPPLIERS plus Naboo's own line called "Frais de service" / "Venue finding" (Naboo's margin, NOT a supplier).

Extract, as STRICT minified JSON (no prose around it):
{
 "supplier": string|null,            // company that issued the INVOICE (the hotel/venue)
 "invoiceTTC": number|null,          // FULL gross invoice total TTC, BEFORE any deposit is deducted. If the invoice only shows a balance after a deposit, set this = net + deposit.
 "quoteSupplierTTC": number|null,    // in the QUOTE, the per-supplier subtotal TTC for that same supplier. NOT the global "Total séjour". Exclude Naboo "Frais de service".
 "invoiceAcompte": number|null,      // deposit already paid on the invoice (positive number), else null
 "invoiceNet": number|null,          // net / balance still to pay, else null
 "acompteRef": {"numero": string|null, "montantTTC": number|null, "statut": "payé"|"non payé"|null} | null,  // referenced deposit invoice, if any
 "invoiceTotalHT": number|null,      // invoice total excl. VAT (full), else null
 "invoiceTotalTVA": number|null,     // invoice total VAT (full), else null
 "vatDetail": [{"rate": number, "base": number, "amount": number}],  // the invoice VAT breakdown table; [] if none
 "toAdd": [{"desc": string, "amount": number}],     // changes to ADD to the Naboo quote: things on the supplier invoice but missing from (or higher than) the quote. TTC amounts.
 "toRemove": [{"desc": string, "amount": number}],  // changes to REMOVE from the Naboo quote: things in the quote but not on (or lower on) the supplier invoice. TTC amounts.
 "note": string                      // one short sentence (language of the documents) explaining the gap
}
Rules: amounts in euros, decimals with a dot (e.g. 4768.62). French (1 234,56) or US (1,234.56) inputs both normalise to a plain number. NEVER invent a figure that is absent from the document — use null. Fill invoiceAcompte AND invoiceNet whenever a deposit is deducted.
toAdd / toRemove must reconcile the gap: sum(toAdd amounts) − sum(toRemove amounts) must equal (invoiceTTC − quoteSupplierTTC). If both totals match, return [] and []. If the documents DO expose the differing line items, list them specifically (e.g. an extra "Team Quest" billed = add). If they do NOT expose enough detail to itemise, return a single explanatory item for the net difference (e.g. toAdd:[{"desc":"Higher than quoted (see invoice detail)","amount": <gap>}]). Never invent line amounts that aren't supported by the documents.

=== QUOTE (devis) ===
${quoteText}

=== INVOICE (facture) ===
${invoiceText}`;
}

async function callModel(model, key, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 700, temperature: 0, messages: [{ role: 'user', content: prompt }] })
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
  if (num(o.invoiceAcompte) != null && num(o.invoiceNet) != null && num(o.invoiceTTC) != null && !close(o.invoiceAcompte + o.invoiceNet, o.invoiceTTC))
    w.push(`Deposit + balance (${r2(o.invoiceAcompte + o.invoiceNet)}) ≠ full TTC (${o.invoiceTTC})`);
  if (o.acompteRef && num(o.acompteRef.montantTTC) != null && num(o.invoiceAcompte) != null && !close(o.acompteRef.montantTTC, o.invoiceAcompte))
    w.push(`Deposit deducted (${o.invoiceAcompte}) ≠ referenced deposit invoice (${o.acompteRef.montantTTC})`);
  return w;
}

// Does the add/remove breakdown reconcile to the gap?
function reconcileCheck(o) {
  if (num(o.invoiceTTC) == null || num(o.quoteSupplierTTC) == null) return { ok: true, gap: null };
  const gap = o.invoiceTTC - o.quoteSupplierTTC;
  const add = Array.isArray(o.toAdd) ? o.toAdd.reduce((s, x) => s + (num(x.amount) || 0), 0) : 0;
  const rem = Array.isArray(o.toRemove) ? o.toRemove.reduce((s, x) => s + (num(x.amount) || 0), 0) : 0;
  const ok = Math.abs((add - rem) - gap) <= Math.max(0.02, Math.abs(gap) * 0.005);
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
  if (!quoteText || !invoiceText) { res.status(400).json({ error: 'MISSING_TEXT' }); return; }

  const prompt = buildPrompt(quoteText, invoiceText);

  try {
    // 1) Cheap pass
    let out = await callModel(HAIKU, key, prompt);
    let usedModel = 'haiku';
    let warnings = validate(out);
    const inv = num(out.invoiceTTC), q = num(out.quoteSupplierTTC);
    const matches = inv != null && q != null && Math.abs(inv - q) < 0.01;

    // 2) Escalate to Sonnet when amounts don't match, Haiku is internally inconsistent, or the breakdown doesn't reconcile
    if (!matches || warnings.length > 0 || !reconcileCheck(out).ok) {
      try { const s = await callModel(SONNET, key, prompt); out = s; usedModel = 'sonnet'; warnings = validate(out); }
      catch (e) { /* keep Haiku result if Sonnet fails */ }
    }

    // 3) Guardrail: the displayed add/remove MUST reconcile to the gap. If it doesn't, drop the
    //    unreliable itemisation and show a single net-adjustment line equal to the gap (never overshoot).
    const recon = reconcileCheck(out);
    if (!recon.ok && recon.gap != null) {
      if (recon.gap > 0.01) { out.toAdd = [{ desc: 'Net difference — could not itemise reliably, check the invoice detail', amount: r2(recon.gap) }]; out.toRemove = []; }
      else if (recon.gap < -0.01) { out.toRemove = [{ desc: 'Net difference — could not itemise reliably, check the invoice detail', amount: r2(-recon.gap) }]; out.toAdd = []; }
      else { out.toAdd = []; out.toRemove = []; }
      warnings.push(`Could not itemise the difference reliably — showing the net adjustment only (${r2(recon.gap)} €).`);
    }

    out.model = usedModel;
    out.warnings = warnings;
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: e.message || 'SERVER', detail: e.detail || null, status: e.status || null });
  }
}
