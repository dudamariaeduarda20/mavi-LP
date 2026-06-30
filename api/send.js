// Vercel serverless function — sends the contact-form emails via Resend.
// The API key lives ONLY here, in a Vercel env var. It is never exposed to the
// browser, and Resend's CORS block (which kills client-side calls) does not apply.
//
// Required Vercel env var:
//   RESEND_API_KEY   — from https://resend.com/api-keys
// Optional env vars (sensible defaults below):
//   MAIL_TO          — where leads are delivered (default: mavidigitalgroup@gmail.com)
//   MAIL_FROM        — sender. Default "onboarding@resend.dev" works WITHOUT a
//                      verified domain but only delivers to the Resend account
//                      owner. After verifying mavidigital.pt on Resend, set this
//                      to e.g. "MAVI <contato@mavidigital.pt>" so the client
//                      confirmation email also delivers.

const SERVICE_LABELS = {
  landing: 'Landing Page Premium',
  social: 'Estratégia de Conteúdo Social',
  management: 'Gerenciamento de Presença',
  complete: 'Solução Completa (Tudo Junto)',
  other: 'Outro',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serviceLabel(v) {
  return SERVICE_LABELS[v] || (v ? esc(v) : '—');
}

async function sendEmail(apiKey, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    let detail = '';
    try { const d = await r.json(); detail = d.message || JSON.stringify(d); } catch (e) {}
    throw new Error(`Resend ${r.status}: ${detail}`);
  }
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Servidor sem RESEND_API_KEY configurada.' });
    return;
  }

  // Body may arrive parsed (Vercel auto-parse), as a raw string, or — if the
  // runtime doesn't parse — not at all. Handle all three.
  let body = req.body;
  if (body == null || body === '') {
    body = await new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => resolve(raw));
      req.on('error', () => resolve(''));
    });
  }
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const name = (body.name || '').trim();
  const email = (body.email || '').trim();
  const phone = (body.phone || '').trim();
  const company = (body.company || '').trim();
  const service = (body.service || '').trim();
  const message = (body.message || '').trim();
  const timestamp = (body.timestamp || new Date().toLocaleString('pt-BR')).toString();

  if (!name || !email || !message) {
    res.status(400).json({ error: 'Preencha nome, email e mensagem.' });
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'Email inválido.' });
    return;
  }

  const from = process.env.MAIL_FROM || 'MAVI <onboarding@resend.dev>';
  const to = process.env.MAIL_TO || 'mavidigitalgroup@gmail.com';

  const adminHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #000;">Nova Submissão de Projeto</h2>
      <p><strong>Nome:</strong> ${esc(name)}</p>
      <p><strong>Email:</strong> ${esc(email)}</p>
      <p><strong>Telefone:</strong> ${esc(phone) || '—'}</p>
      <p><strong>Empresa:</strong> ${esc(company) || '—'}</p>
      <p><strong>Serviço Solicitado:</strong> ${serviceLabel(service)}</p>
      <p><strong>Mensagem:</strong></p>
      <p style="background-color: #f5f5f5; padding: 16px; border-radius: 8px;">
        ${esc(message).replace(/\n/g, '<br>')}
      </p>
      <p><strong>Data/Hora:</strong> ${esc(timestamp)}</p>
      <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
      <p style="color: #888; font-size: 12px;">Responda para: ${esc(email)}</p>
    </div>`;

  const clientHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #000;">Obrigado pela sua solicitação!</h2>
      <p>Olá <strong>${esc(name)}</strong>,</p>
      <p>Recebemos sua submissão com sucesso. Nossa equipe analisará seu projeto e responderá com uma proposta estratégica em até 24 horas.</p>
      <div style="background-color: #f5f5f5; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Resumo da sua solicitação:</strong></p>
        <p>Empresa: ${esc(company) || '—'}<br>
        Serviço: ${serviceLabel(service)}<br>
        Contato: ${esc(email)}</p>
      </div>
      <p>Enquanto isso, conheça mais sobre nossos serviços em <strong>mavidigital.pt</strong></p>
      <p>Abraços,<br><strong>MAVI — Digital Group</strong></p>
      <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
      <p style="color: #888; font-size: 12px;">Email: mavidigitalgroup@gmail.com</p>
    </div>`;

  try {
    // Admin notification is the critical path — fail the request if it errors.
    await sendEmail(apiKey, {
      from,
      to,
      reply_to: email,
      subject: `Nova submissão de projeto - ${name}`,
      html: adminHtml,
    });
  } catch (err) {
    console.error('admin email failed:', err.message);
    res.status(502).json({ error: 'Não foi possível enviar agora. Tente novamente.' });
    return;
  }

  // Client confirmation is best-effort. Without a verified domain Resend rejects
  // sending to external addresses — don't fail the lead if this part errors.
  let clientConfirmed = true;
  try {
    await sendEmail(apiKey, {
      from,
      to: email,
      subject: 'Recebemos sua solicitação - MAVI Digital Group',
      html: clientHtml,
    });
  } catch (err) {
    clientConfirmed = false;
    console.error('client confirmation skipped:', err.message);
  }

  res.status(200).json({ ok: true, clientConfirmed });
};
