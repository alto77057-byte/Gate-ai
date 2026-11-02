import { getStore } from '@netlify/blobs';

// Runs in the background (the "-background" name does that), so it can take longer than 10 seconds.
const ENDPOINT = 'https://openrouter.apify.actor/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash-image';
const LIMIT_PER_HOUR = 10;

export default async (req, context) => {
    const store = getStore('results');
    let id = '';
    try {
        const body = await req.json();
        id = String(body.id || '');
        if (!/^[a-z0-9]{16,40}$/.test(id)) return new Response('bad id');

        const fail = (msg) => store.setJSON(id, { status: 'error', error: msg });
        const { image, prompt, style, strength, faceLock } = body;

        if (!process.env.APIFY_TOKEN) return await fail('The site is not set up yet.');
        if (!prompt || typeof prompt !== 'string') return await fail('Please describe what to create.');
        if (image && !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
            return await fail('Upload a PNG, JPG or WebP photo.');
        }

        // Stopgap abuse limit: 10 images per person per hour.
        const ip = req.headers.get('x-nf-client-connection-ip') || context.ip || 'unknown';
        const rkey = `rate-${String(ip).replace(/[^a-z0-9]/gi, '_')}-${Math.floor(Date.now() / 3600000)}`;
        const used = Number(await store.get(rkey)) || 0;
        if (used >= LIMIT_PER_HOUR) return await fail('Too many images. Try again later.');
        await store.set(rkey, String(used + 1));

        // Build the instruction. Face lock keeps the person's real face.
        const pct = Math.round(Math.min(Math.max(Number(strength) || 0.4, 0.1), 0.9) * 100);
        const lead = faceLock !== false
            ? 'Keep the person\u2019s face, identity, skin tone and facial features exactly the same as in the photo. '
            : '';
        const look = style && style !== 'Original' ? ` Style: ${style}.` : '';
        const subtle = image ? ` Keep the edit subtle, about ${pct}% change from the original photo.` : '';
        const content = [{ type: 'text', text: `${lead}${prompt}${look}${subtle}` }];
        if (image) content.push({ type: 'image_url', image_url: { url: image } });

        const r = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.APIFY_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: process.env.MODEL || DEFAULT_MODEL,
                modalities: ['image', 'text'],
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
        const out = data.choices?.[0]?.message?.images?.[0]?.image_url?.url;
        if (!out) {
            console.error('No image in response', JSON.stringify(data).slice(0, 300));
            return await fail('No image came back. Try another prompt or model.');
        }

        await store.setJSON(id, { status: 'done', image: out });
    } catch (e) {
        console.error(e);
        if (id) {
            try { await store.setJSON(id, { status: 'error', error: 'Something went wrong. Try again.' }); } catch {}
        }
    }
    return new Response('ok');
};
