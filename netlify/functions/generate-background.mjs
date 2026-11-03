import { getStore } from '@netlify/blobs';

// Step 2: runs in the background (the "-background" name does that), so it can take longer than 10 seconds.
// It only receives a small request. The photo is read from storage, saved by upload.mjs.
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash-image';

export default async (req) => {
    const results = getStore('results');
    const jobs = getStore('jobs');
    let id = '';
    try {
        const body = await req.json();
        id = String(body.id || '');
        if (!/^[a-z0-9]{16,40}$/.test(id)) return new Response('bad id');

        const fail = (msg) => results.setJSON(id, { status: 'error', error: msg });
        const { prompt, style, strength, faceLock } = body;

        if (!process.env.OPENROUTER_API_KEY) return await fail('The site is not set up yet.');
        if (!prompt || typeof prompt !== 'string') return await fail('Please describe what to create.');

        const ticket = await jobs.get(`ticket-${id}`);
        if (ticket === null) return await fail('Please try again.');
        await jobs.delete(`ticket-${id}`);
        const image = ticket === '-' ? '' : ticket;

        // Build the instruction. Face lock keeps the person's real face.
        const pct = Math.round(Math.min(Math.max(Number(strength) || 0.4, 0.1), 0.9) * 100);
        const lead = image && faceLock !== false
            ? 'Keep the person\u2019s face, identity, skin tone and facial features exactly the same as in the photo. '
            : '';
        const look = style && style !== 'Original' ? ` Style: ${style}.` : '';
        const subtle = image ? ` Keep the edit subtle, about ${pct}% change from the original photo.` : '';
        const content = [{ type: 'text', text: `${lead}${prompt}${look}${subtle}` }];
        if (image) content.push({ type: 'image_url', image_url: { url: image } });

        const model = process.env.MODEL || DEFAULT_MODEL;
        const imageOnly = process.env.IMAGE_ONLY === '1' || model.startsWith('black-forest-labs/');
        const r = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                // Image-only models (like Flux) need ['image']; Gemini-style models take ['image','text'].
                modalities: imageOnly ? ['image'] : ['image', 'text'],
                messages: [{ role: 'user', content }],
            }),
            signal: AbortSignal.timeout(280_000),
        });

        if (!r.ok) {
            const raw = await r.text();
            let detail = raw;
            try {
                const j = JSON.parse(raw);
                detail = (typeof j.error === 'string' ? j.error : j.error?.message) || j.message || raw;
            } catch {}
            detail = String(detail).replace(/\s+/g, ' ').slice(0, 160);
            console.error('Upstream error', r.status, detail);
            return await fail(`The image service failed (${r.status}). ${detail}`);
        }

        const data = await r.json();
        const msg = data.choices?.[0]?.message;
        let out = msg?.images?.[0]?.image_url?.url;
        if (!out && Array.isArray(msg?.content)) {
            out = msg.content.find((c) => c?.image_url?.url)?.image_url?.url;
        }
        if (!out) {
            console.error('No image in response', JSON.stringify(data).slice(0, 600));
            const said = typeof msg?.content === 'string' ? msg.content.replace(/\s+/g, ' ').slice(0, 140) : '';
            return await fail('No image came back.' + (said ? ` The model said: ${said}` : ' Try another prompt or model.'));
        }

        await results.setJSON(id, { status: 'done', image: out });
    } catch (e) {
        console.error(e);
        if (id) {
            try { await results.setJSON(id, { status: 'error', error: 'Something went wrong. Try again.' }); } catch {}
        }
    }
    return new Response('ok');
};
