import { getStore } from '@netlify/blobs';

// Step 1: receives the photo (this kind of function accepts big files) and saves it for the job.
const LIMIT_PER_HOUR = 10;

export default async (req, context) => {
    try {
        const { id, image } = await req.json();
        if (!/^[a-z0-9]{16,40}$/.test(String(id || ''))) {
            return Response.json({ error: 'Bad request.' }, { status: 400 });
        }
        if (image) {
            const ok = typeof image === 'string'
                && image.length <= 4_500_000
                && /^data:image\/(png|jpe?g|webp);base64,/.test(image);
            if (!ok) return Response.json({ error: 'Upload a PNG, JPG or WebP photo.' }, { status: 400 });
        }

        const jobs = getStore('jobs');

        // Stopgap abuse limit: 10 images per person per hour.
        const ip = req.headers.get('x-nf-client-connection-ip') || context.ip || 'unknown';
        const rkey = `rate-${String(ip).replace(/[^a-z0-9]/gi, '_')}-${Math.floor(Date.now() / 3600000)}`;
        const used = Number(await jobs.get(rkey)) || 0;
        if (used >= LIMIT_PER_HOUR) {
            return Response.json({ error: 'Too many images. Try again later.' }, { status: 429 });
        }
        await jobs.set(rkey, String(used + 1));

        // "-" means no photo. Only jobs that pass through here are allowed to run.
        await jobs.set(`ticket-${id}`, image || '-');
        return Response.json({ ok: true });
    } catch (e) {
        console.error(e);
        return Response.json({ error: 'Something went wrong.' }, { status: 500 });
    }
};
